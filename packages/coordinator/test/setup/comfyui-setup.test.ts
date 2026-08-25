import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DomainEvent, SetupStatus } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { LocalSetupService, type SetupDeps } from "../../src/setup/local-setup.js";
import { ProviderCallStore } from "../../src/providers/call-store.js";
import { SecretRegistry } from "../../src/redact.js";
import type { CatalogueEntry } from "../../src/setup/catalogue.js";

/**
 * SPEC-021 §2.4 in the setup service: the tree kind installs a whole runtime atomically,
 * selected external sources win over installation while detection remains an offer (D10),
 * external folders are the user's — per-file
 * paths, per-file repair, never a recursive delete — and the call-record truncation order
 * finding from issue 354 stays fixed.
 */

const SEVENZ = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] as const;

function treeEntry(): CatalogueEntry {
  return {
    id: "comfyui-runtime",
    displayName: "ComfyUI",
    purpose: "Runs the local recipes",
    sizeMb: 1,
    optional: true,
    spec: {
      kind: "tree",
      dir: "comfyui-runtime",
      rootMarker: "ComfyUI/main.py",
      file: { url: "https://example.test/portable.7z", file: "portable.7z", sizeMb: 1, magic: SEVENZ },
    },
  };
}

function weightsEntry(): CatalogueEntry {
  return {
    id: "comfyui-weights-draft-image",
    displayName: "Draft Image weights",
    purpose: "SDXL Base 1.0",
    sizeMb: 1,
    optional: true,
    spec: {
      kind: "files",
      dir: "",
      externalRoot: "comfyui-models",
      files: [{ url: "https://example.test/sdxl.safetensors", file: "checkpoints/sd_xl_base_1.0.safetensors", sizeMb: 1 }],
    },
  };
}

function bytes(n: number, lead: readonly number[] = SEVENZ): Uint8Array {
  const out = new Uint8Array(n);
  lead.forEach((b, i) => (out[i] = b));
  return out;
}

function deps(opts: {
  externallyPresent?: boolean;
  onTar?: (staged: string) => Promise<void>;
  lead?: readonly number[];
} = {}): SetupDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetchStream(url) {
      calls.push(`fetch ${url}`);
      const payload = bytes(2048, opts.lead ?? SEVENZ);
      return {
        ok: true,
        status: 200,
        contentLength: payload.byteLength,
        body: (async function* () {
          yield payload;
        })(),
      };
    },
    async run(command, args) {
      calls.push(`run ${command} ${args.join(" ")}`);
      if (/tar/i.test(command) && args[0] === "-xf") {
        await opts.onTar?.(args[3]!);
        return { code: 0, output: "" };
      }
      return { code: 0, output: "" };
    },
    async which() {
      return null;
    },
    async probeUrl() {
      return false;
    },
    async diskFreeMb() {
      return 500_000;
    },
    ...(opts.externallyPresent !== undefined
      ? { externallyPresent: async () => opts.externallyPresent! }
      : {}),
  };
}

function last(events: DomainEvent[]): SetupStatus {
  const e = [...events].reverse().find((x) => x.type === "setup.status");
  assert.ok(e && e.type === "setup.status");
  return e.setup;
}

describe("the tree kind installs a whole runtime atomically (§2.4, D10)", () => {
  it("downloads, extracts into staging, verifies the marker one level deep, and renames whole", async () => {
    const appRoot = await tempDir("arke-tree-");
    const events: DomainEvent[] = [];
    const d = deps({
      onTar: async (staged) => {
        // The upstream archive wraps its tree in one top folder, exactly as the real 7z does.
        const inner = join(staged, "ComfyUI_windows_portable");
        await mkdir(join(inner, "ComfyUI"), { recursive: true });
        await mkdir(join(inner, "python_embeded"), { recursive: true });
        await writeFile(join(inner, "ComfyUI", "main.py"), "print('comfy')");
        await writeFile(join(inner, "python_embeded", "python.exe"), "MZ");
      },
    });
    const svc = new LocalSetupService(d, (e) => events.push(e), {
      appRoot,
      catalogue: [treeEntry()],
      throttleMs: 0,
    });
    svc.retry("comfyui-runtime"); // optional entries wait to be asked for
    await svc.run();
    const status = last(events);
    assert.equal(status.components[0]!.state, "ready");
    // The whole tree arrived under the component dir, marker intact, archive cleaned away.
    const marker = join(appRoot, "comfyui-runtime", "ComfyUI_windows_portable", "ComfyUI", "main.py");
    assert.equal((await stat(marker)).isFile(), true);
    await assert.rejects(stat(join(appRoot, "comfyui-runtime", "portable.7z")));
    // A second detect() sees it as present without fetching again.
    await svc.detect();
    assert.equal(last(events).components[0]!.state, "present");
    assert.equal(d.calls.filter((c) => c.startsWith("fetch")).length, 1);
  });

  it("an archive missing the marker fails with the reason, and nothing takes the real path", async () => {
    const appRoot = await tempDir("arke-tree-");
    const events: DomainEvent[] = [];
    const d = deps({ onTar: async () => {} }); // extraction "succeeds" but yields nothing
    const svc = new LocalSetupService(d, (e) => events.push(e), {
      appRoot,
      catalogue: [treeEntry()],
      throttleMs: 0,
    });
    svc.retry("comfyui-runtime");
    await svc.run();
    const status = last(events);
    assert.equal(status.components[0]!.state, "failed");
    assert.match(status.components[0]!.detail!, /ComfyUI\/main\.py/);
    await assert.rejects(stat(join(appRoot, "comfyui-runtime")), "no half-runtime under the real name");
  });

  it("the disk guard measures the extracted size, not the download", async () => {
    // The archive is ~2 GB and the tree it becomes is ~6 GB, both on disk at once while it
    // unpacks. Guarding on the download alone let a disk with room for the archive start a
    // fetch that then died part-way through extraction — precisely the silent mid-way failure
    // this guard exists to replace with a refusal stated up front.
    const appRoot = await tempDir("arke-tree-");
    const events: DomainEvent[] = [];
    const d = deps();
    d.diskFreeMb = async () => 5000; // room for the 2 GB download, not for the 8 GB peak
    const svc = new LocalSetupService(d, (e) => events.push(e), {
      appRoot,
      catalogue: [{ ...treeEntry(), sizeMb: 2034, installedMb: 8200 }],
      throttleMs: 0,
      headroomMb: 2000,
    });
    svc.retry("comfyui-runtime");
    await svc.run();
    const status = last(events);
    assert.equal(status.components[0]!.state, "blocked");
    // The figure quoted is the extracted peak (8.0 GB), not the 2 GB download — with the
    // working headroom named separately rather than folded into one number.
    assert.match(status.components[0]!.detail!, /needs 8\.0 GB plus room to work/);
    assert.match(status.components[0]!.detail!, /this disk has 4\.9 GB free/);
    assert.doesNotMatch(status.components[0]!.detail!, /2\.0 GB/);
    assert.equal(d.calls.filter((c) => c.startsWith("fetch")).length, 0, "nothing was downloaded");
  });

  it("an explicitly selected external engine is never fetched (D10)", async () => {
    const appRoot = await tempDir("arke-tree-");
    const events: DomainEvent[] = [];
    const d = deps({ externallyPresent: true });
    const svc = new LocalSetupService(d, (e) => events.push(e), {
      appRoot,
      catalogue: [treeEntry()],
      throttleMs: 0,
    });
    await svc.detect();
    assert.equal(last(events).components[0]!.state, "present");
    await svc.run();
    assert.equal(d.calls.filter((c) => c.startsWith("fetch")).length, 0, "nothing was downloaded");
  });

  it("a detected but unselected engine leaves the managed runtime available", async () => {
    const appRoot = await tempDir("arke-tree-");
    const events: DomainEvent[] = [];
    const svc = new LocalSetupService(deps({ externallyPresent: false }), (e) => events.push(e), {
      appRoot,
      catalogue: [treeEntry()],
      throttleMs: 0,
    });
    await svc.detect();
    assert.equal(last(events).components[0]!.state, "available");
  });

  it("awaits runtime activation before resolving a dependent weights destination", async () => {
    const appRoot = await tempDir("arke-tree-");
    const modelsDir = join(appRoot, "comfyui-runtime", "ComfyUI_windows_portable", "ComfyUI", "models");
    let resolvedModelsDir: string | null = null;
    const events: DomainEvent[] = [];
    const d = deps({
      onTar: async (staged) => {
        const inner = join(staged, "ComfyUI_windows_portable");
        await mkdir(join(inner, "ComfyUI"), { recursive: true });
        await mkdir(join(inner, "python_embeded"), { recursive: true });
        await writeFile(join(inner, "ComfyUI", "main.py"), "print('comfy')");
        await writeFile(join(inner, "python_embeded", "python.exe"), "MZ");
      },
    });
    const runtime = { ...treeEntry(), optional: false };
    const weights = { ...weightsEntry(), optional: false, requires: ["comfyui-runtime"] };
    const svc = new LocalSetupService(d, (event) => events.push(event), {
      appRoot,
      catalogue: [runtime, weights],
      throttleMs: 0,
      externalDirs: { "comfyui-models": () => resolvedModelsDir },
      onComponentReady: async (componentId) => {
        if (componentId === "comfyui-runtime") resolvedModelsDir = modelsDir;
      },
    });

    await svc.run();
    assert.deepEqual(last(events).components.map((component) => component.state), ["ready", "ready"]);
    assert.equal(
      (await stat(join(modelsDir, "checkpoints", "sd_xl_base_1.0.safetensors"))).isFile(),
      true,
    );
  });
});

describe("an external models folder is the user's (§2.4)", () => {
  it("a file already in the folder is recognised, not re-downloaded; a missing one is fetched to the same path", async () => {
    const appRoot = await tempDir("arke-ext-");
    const modelsDir = await tempDir("arke-ext-models-");
    await mkdir(join(modelsDir, "checkpoints"), { recursive: true });
    await writeFile(join(modelsDir, "checkpoints", "sd_xl_base_1.0.safetensors"), bytes(64, [1, 2, 3]));
    const events: DomainEvent[] = [];
    const d = deps();
    const svc = new LocalSetupService(d, (e) => events.push(e), {
      appRoot,
      catalogue: [weightsEntry()],
      throttleMs: 0,
      externalDirs: { "comfyui-models": () => modelsDir },
    });
    await svc.detect();
    assert.equal(last(events).components[0]!.state, "present", "the user's file IS presence (R-8)");
    assert.equal(d.calls.filter((c) => c.startsWith("fetch")).length, 0);
  });

  it("with no folder mapped, the entry blocks with the reason instead of inventing a destination", async () => {
    const appRoot = await tempDir("arke-ext-");
    const events: DomainEvent[] = [];
    const svc = new LocalSetupService(deps(), (e) => events.push(e), {
      appRoot,
      catalogue: [weightsEntry()],
      throttleMs: 0,
      externalDirs: { "comfyui-models": () => null },
    });
    svc.retry("comfyui-weights-draft-image");
    await svc.run();
    const status = last(events);
    assert.equal(status.components[0]!.state, "blocked");
    assert.match(status.components[0]!.detail!, /no models folder is mapped/);
  });

  it("repair removes exactly the entry's own files — the user's other files survive", async () => {
    const appRoot = await tempDir("arke-ext-");
    const modelsDir = await tempDir("arke-ext-models-");
    await mkdir(join(modelsDir, "checkpoints"), { recursive: true });
    await writeFile(join(modelsDir, "checkpoints", "sd_xl_base_1.0.safetensors"), bytes(64, [1, 2, 3]));
    await writeFile(join(modelsDir, "checkpoints", "the-users-own-finetune.safetensors"), bytes(64, [4, 5, 6]));
    const svc = new LocalSetupService(deps(), () => {}, {
      appRoot,
      catalogue: [weightsEntry()],
      throttleMs: 0,
      externalDirs: { "comfyui-models": () => modelsDir },
    });
    await svc.repair("comfyui-weights-draft-image");
    await assert.rejects(stat(join(modelsDir, "checkpoints", "sd_xl_base_1.0.safetensors")), "the entry's file is gone");
    assert.equal(
      (await stat(join(modelsDir, "checkpoints", "the-users-own-finetune.safetensors"))).isFile(),
      true,
      "the user's own file is untouched",
    );
    assert.equal((await stat(modelsDir)).isDirectory(), true, "the folder itself survives");
  });
});

describe("an oversized request body truncates instead of losing the record (issue 354 §1)", () => {
  it("the record persists with the request marked truncated", async () => {
    const dir = await tempDir("arke-calls-");
    const store = new ProviderCallStore(join(dir, "calls.jsonl"), new SecretRegistry());
    // A request body big enough that even after sanitisation the record exceeds 512 KiB —
    // under the old ordering this threw and the whole call vanished from history.
    const id = await store.start({
      provider: "comfyui",
      operation: "submit",
      method: "POST",
      endpoint: "http://127.0.0.1:8188/prompt",
      headers: {},
      body: { huge: Array.from({ length: 60 }, () => "y".repeat(50_000)) },
    });
    await store.drain();
    const records = await store.listRecent();
    const record = records.find((r) => r.id === id);
    assert.ok(record, "the record survived");
    assert.deepEqual(record!.request.body, {
      truncated: true,
      reason: "provider request exceeded the 512 KiB call-record limit",
    });
    await store.drain();
  });
});
