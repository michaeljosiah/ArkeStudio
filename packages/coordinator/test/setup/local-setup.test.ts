import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DomainEvent, SetupStatus } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { LocalSetupService, systemTar, type SetupDeps } from "../../src/setup/local-setup.js";
import {
  catalogueTotalMb,
  isVoxaSetupComponentId,
  SETUP_CATALOGUE,
  VOXA_SETUP_COMPONENT_IDS,
  voxaSetupCompleted,
  type CatalogueEntry,
} from "../../src/setup/catalogue.js";

const GGML_MAGIC = [0x6c, 0x6d, 0x67, 0x67] as const;

/** A tiny catalogue: one file download, one installer, one pull that needs the installer. */
function catalogue(): CatalogueEntry[] {
  return [
    {
      id: "runtime",
      displayName: "Ollama",
      purpose: "Runs models here",
      sizeMb: 1,
      spec: {
        kind: "installer",
        file: { url: "https://example.test/OllamaSetup.exe", file: "OllamaSetup.exe", sizeMb: 1 },
        silentArgs: ["/VERYSILENT"],
      },
    },
    {
      id: "model",
      displayName: "Llama",
      purpose: "The default local model",
      sizeMb: 1,
      requires: ["runtime"],
      spec: { kind: "pull", command: "ollama", args: ["pull", "llama3.1:8b"] },
    },
    {
      id: "weights",
      displayName: "Whisper",
      purpose: "Dictation, on this machine",
      sizeMb: 1,
      spec: {
        kind: "files",
        dir: "whisper",
        files: [{ url: "https://example.test/ggml.bin", file: "ggml.bin", sizeMb: 1, magic: GGML_MAGIC }],
      },
    },
  ];
}

function bytes(n: number, lead: readonly number[] = GGML_MAGIC): Uint8Array {
  const out = new Uint8Array(n);
  lead.forEach((b, i) => (out[i] = b));
  return out;
}

interface FakeOpts {
  installed?: boolean;
  listOutput?: string;
  chunks?: Uint8Array[];
  contentLength?: number | null;
  status?: number;
  runCode?: number;
  diskFreeMb?: number | null;
  acceptRanges?: boolean;
  contentRangeStart?: number | null;
}

function deps(opts: FakeOpts = {}): SetupDeps & { calls: string[] } {
  let installed = opts.installed ?? false;
  const calls: string[] = [];
  return {
    calls,
    async fetchStream(url, _signal, rangeStart) {
      calls.push(`fetch ${url}${rangeStart === null ? "" : ` @${rangeStart}`}`);
      const chunks = opts.chunks ?? [bytes(2048)];
      const total = chunks.reduce((s, c) => s + c.byteLength, 0);
      return {
        ok: (opts.status ?? 200) < 400,
        status: opts.status ?? 200,
        contentLength: opts.contentLength === undefined ? total : opts.contentLength,
        acceptRanges: opts.acceptRanges ?? false,
        contentRangeStart: opts.contentRangeStart ?? null,
        body: (async function* () {
          for (const c of chunks) yield c;
        })(),
      };
    },
    async run(command, args) {
      calls.push(`run ${command} ${args.join(" ")}`);
      if (command.endsWith("OllamaSetup.exe")) installed = true;
      if (command === "ollama" && args[0] === "list") return { code: 0, output: opts.listOutput ?? "" };
      return { code: opts.runCode ?? 0, output: "" };
    },
    async which(command) {
      calls.push(`which ${command}`);
      return installed && command === "ollama" ? "C:/ollama.exe" : null;
    },
    async probeUrl() {
      return installed;
    },
    async diskFreeMb() {
      return opts.diskFreeMb === undefined ? 500_000 : opts.diskFreeMb;
    },
  };
}

function resumableDeps(
  payload: Uint8Array,
  split: number,
  opts: {
    acceptRanges?: boolean;
    resumeStatus?: number;
    resumeStart?: number | null;
    resumeEnd?: number | null;
    resumeTotal?: number | null;
    resumeValidator?: string | null;
  } = {},
): SetupDeps & {
  calls: string[];
  ranges: Array<number | null>;
  firstDurable: Promise<void>;
  releaseInitial(): void;
} {
  const base = deps();
  const ranges: Array<number | null> = [];
  let durable: () => void = () => {};
  let release: () => void = () => {};
  const firstDurable = new Promise<void>((resolve) => (durable = resolve));
  return {
    ...base,
    ranges,
    firstDurable,
    releaseInitial: () => release(),
    async fetchStream(_url, signal, rangeStart) {
      ranges.push(rangeStart);
      if (rangeStart !== null) {
        const status = opts.resumeStatus ?? 206;
        const suffix = payload.subarray(rangeStart);
        return {
          ok: status >= 200 && status < 300,
          status,
          contentLength: suffix.byteLength,
          acceptRanges: opts.acceptRanges ?? true,
          contentRangeStart: opts.resumeStart === undefined ? rangeStart : opts.resumeStart,
          contentRangeEnd: opts.resumeEnd === undefined ? payload.byteLength - 1 : opts.resumeEnd,
          contentRangeTotal: opts.resumeTotal === undefined ? payload.byteLength : opts.resumeTotal,
          validator: opts.resumeValidator === undefined ? '"weights-v1"' : opts.resumeValidator,
          body: (async function* () {
            yield suffix;
          })(),
        };
      }
      return {
        ok: true,
        status: 200,
        contentLength: payload.byteLength,
        acceptRanges: opts.acceptRanges ?? true,
        contentRangeStart: null,
        validator: '"weights-v1"',
        body: (async function* () {
          yield payload.subarray(0, split);
          durable();
          await new Promise<void>((resolve) => {
            release = resolve;
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (!signal.aborted) yield payload.subarray(split);
        })(),
      };
    },
  };
}

function digestCatalogue(payload: Uint8Array): CatalogueEntry[] {
  const entry = catalogue().find((candidate) => candidate.id === "weights")!;
  if (entry.spec.kind !== "files") throw new Error("test catalogue changed");
  return [{
    ...entry,
    spec: {
      ...entry.spec,
      files: [{ ...entry.spec.files[0]!, sha256: createHash("sha256").update(payload).digest("hex") }],
    },
  }];
}

async function root(): Promise<string> {
  return tempDir("arke-setup-");
}

function last(events: DomainEvent[]): SetupStatus {
  const e = [...events].reverse().find((x) => x.type === "setup.status");
  assert.ok(e && e.type === "setup.status", "a setup.status event was emitted");
  return e.setup;
}

describe("fetching the local runtimes at setup", () => {
  it("exports the exact Voxa model component identities used by the catalogue", () => {
    const byId = new Map(SETUP_CATALOGUE.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(VOXA_SETUP_COMPONENT_IDS.kokoro)?.spec.kind, "files");
    assert.equal(byId.get(VOXA_SETUP_COMPONENT_IDS.whisper)?.spec.kind, "files");
    assert.equal(
      new Set([VOXA_SETUP_COMPONENT_IDS.kokoro, VOXA_SETUP_COMPONENT_IDS.whisper]).size,
      2,
    );
    assert.equal(isVoxaSetupComponentId(VOXA_SETUP_COMPONENT_IDS.kokoro), true);
    assert.equal(isVoxaSetupComponentId(VOXA_SETUP_COMPONENT_IDS.whisper), true);
    assert.equal(isVoxaSetupComponentId("kokoro-82m"), false, "the stale model id cannot trigger a restart");
  });

  it("detects a canonical voice component completion exactly once for the idle restart", () => {
    const queued = [
      { id: VOXA_SETUP_COMPONENT_IDS.kokoro, state: "downloading" },
      { id: VOXA_SETUP_COMPONENT_IDS.whisper, state: "present" },
    ];
    const ready = [
      { id: VOXA_SETUP_COMPONENT_IDS.kokoro, state: "ready" },
      { id: VOXA_SETUP_COMPONENT_IDS.whisper, state: "present" },
    ];
    assert.equal(voxaSetupCompleted(queued, ready), true);
    assert.equal(voxaSetupCompleted(ready, ready), false, "the final idle publication does not schedule a second restart");
    assert.equal(voxaSetupCompleted(undefined, [{ id: "kokoro-82m", state: "ready" }]), false);
  });

  it("downloads what is missing, installs the runtime, and reports every component ready", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    const d = deps();
    const svc = new LocalSetupService(d, (e) => events.push(e), { appRoot, catalogue: catalogue(), throttleMs: 0 });

    await svc.run();

    const status = last(events);
    assert.deepEqual(
      status.components.map((c) => `${c.id}:${c.state}`),
      ["runtime:ready", "model:ready", "weights:ready"],
    );
    assert.equal(status.components.find((c) => c.id === "weights")!.installLocation, join(appRoot, "models", "whisper"));
    assert.notEqual(status.components.find((c) => c.id === "runtime")!.installLocation, join(appRoot, "models"));
    assert.notEqual(status.components.find((c) => c.id === "model")!.installLocation, join(appRoot, "models"));
    assert.equal(status.running, false);

    // The weights landed under the app root, whole — never a .partial.
    const written = await readFile(join(appRoot, "models", "whisper", "ggml.bin"));
    assert.equal(written.byteLength, 2048);
    // The installer ran silently, and the pull happened only after the runtime arrived.
    assert.ok(d.calls.some((c) => c.includes("OllamaSetup.exe /VERYSILENT")));
    assert.ok(d.calls.indexOf("run ollama pull llama3.1:8b") > d.calls.findIndex((c) => c.includes("OllamaSetup.exe")));
  });

  it("counts a small file as present — a 44-byte config is not a fragment", async () => {
    // The bug this pins: presence required 1024 bytes per file as a fragment heuristic, and
    // Kokoro's config.json is 44 bytes of legitimate JSON. So every launch decided the voice
    // weights were missing and fetched 88 MB that were already on the disk. A size floor
    // cannot tell a small file from a broken one; the .partial rename already does that.
    const appRoot = await root();
    const withTinyFile = catalogue().map((e) =>
      e.id === "weights"
        ? {
            ...e,
            spec: {
              kind: "files" as const,
              dir: "whisper",
              files: [
                { url: "https://example.test/ggml.bin", file: "ggml.bin", sizeMb: 1, magic: GGML_MAGIC },
                { url: "https://example.test/config.json", file: "config.json", sizeMb: 1 },
              ],
            },
          }
        : e,
    );
    await mkdir(join(appRoot, "models", "whisper"), { recursive: true });
    await writeFile(join(appRoot, "models", "whisper", "ggml.bin"), bytes(4096));
    await writeFile(join(appRoot, "models", "whisper", "config.json"), '{"model_type": "style_text_to_speech_2"}');

    const d = deps({ installed: true });
    const events: DomainEvent[] = [];
    const svc = new LocalSetupService(d, (e) => events.push(e), { appRoot, catalogue: withTinyFile, throttleMs: 0 });
    await svc.run();

    assert.equal(last(events).components.find((c) => c.id === "weights")!.state, "present");
    assert.ok(!d.calls.some((c) => c.startsWith("fetch")), "nothing was downloaded again");
  });

  it("an empty file is still not presence — a rename that lost its bytes is not a download", async () => {
    const appRoot = await root();
    await mkdir(join(appRoot, "models", "whisper"), { recursive: true });
    await writeFile(join(appRoot, "models", "whisper", "ggml.bin"), new Uint8Array(0));
    const d = deps({ installed: true });
    const events: DomainEvent[] = [];
    const svc = new LocalSetupService(d, (e) => events.push(e), { appRoot, catalogue: catalogue(), throttleMs: 0 });
    await svc.run();
    assert.equal(last(events).components.find((c) => c.id === "weights")!.state, "ready", "it was fetched again");
  });

  it("fetches nothing on a second launch — presence is detected first", async () => {
    const appRoot = await root();
    await mkdir(join(appRoot, "models", "whisper"), { recursive: true });
    await writeFile(join(appRoot, "models", "whisper", "ggml.bin"), bytes(4096));
    const d = deps({ installed: true });
    const events: DomainEvent[] = [];
    const svc = new LocalSetupService(d, (e) => events.push(e), { appRoot, catalogue: catalogue(), throttleMs: 0 });

    await svc.run();

    const status = last(events);
    assert.equal(status.components.find((c) => c.id === "weights")!.state, "present");
    assert.equal(status.components.find((c) => c.id === "runtime")!.state, "present");
    assert.ok(!d.calls.some((c) => c.startsWith("fetch")), "nothing was downloaded again");
  });

  it("refuses to start when the disk cannot hold it, and says both figures", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    const svc = new LocalSetupService(deps({ diskFreeMb: 100 }), (e) => events.push(e), {
      appRoot,
      catalogue: catalogue(),
      throttleMs: 0,
      headroomMb: 2000,
    });

    await svc.run();

    const status = last(events);
    assert.ok(status.components.every((c) => c.state === "blocked"));
    assert.match(status.components[0]!.detail ?? "", /this disk has 100 MB free/);
  });

  it("a truncated download fails loudly and leaves nothing behind", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    // Server promises more than it sends.
    const svc = new LocalSetupService(deps({ chunks: [bytes(1024)], contentLength: 999_999 }), (e) => events.push(e), {
      appRoot,
      catalogue: catalogue().filter((c) => c.id === "weights"),
      throttleMs: 0,
    });

    await svc.run();

    const weights = last(events).components.find((c) => c.id === "weights")!;
    assert.equal(weights.state, "failed");
    assert.match(weights.detail ?? "", /stopped short/);
    await assert.rejects(readFile(join(appRoot, "models", "whisper", "ggml.bin")));
  });

  it("a file that is not what we asked for is rejected rather than filed", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    // An HTML error page, magic bytes and all.
    const svc = new LocalSetupService(deps({ chunks: [bytes(2048, [0x3c, 0x21, 0x44, 0x4f])] }), (e) => events.push(e), {
      appRoot,
      catalogue: catalogue().filter((c) => c.id === "weights"),
      throttleMs: 0,
    });

    await svc.run();

    const weights = last(events).components.find((c) => c.id === "weights")!;
    assert.equal(weights.state, "failed");
    assert.match(weights.detail ?? "", /not the file we asked for/);
  });

  it("rejects a checksum mismatch before the model becomes visible", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    const payload = bytes(2048);
    const entries = catalogue().filter((c) => c.id === "weights");
    const weights = entries[0]!;
    if (weights.spec.kind !== "files") throw new Error("test catalogue changed");
    const catalogueWithDigest = [{
      ...weights,
      spec: {
        ...weights.spec,
        files: [{ ...weights.spec.files[0]!, sha256: createHash("sha256").update("different").digest("hex") }],
      },
    }];
    const svc = new LocalSetupService(deps({ chunks: [payload] }), (event) => events.push(event), {
      appRoot,
      catalogue: catalogueWithDigest,
      throttleMs: 0,
    });
    await svc.run();
    assert.match(last(events).components[0]!.detail ?? "", /checksum mismatch/);
    await assert.rejects(readFile(join(appRoot, "models", "whisper", "ggml.bin")));
  });

  it("pauses and resumes at the durable byte boundary, then verifies the complete digest", async () => {
    const appRoot = await root();
    const payload = bytes(4096);
    const d = resumableDeps(payload, 1536);
    const events: DomainEvent[] = [];
    const svc = new LocalSetupService(d, (event) => events.push(event), {
      appRoot,
      catalogue: digestCatalogue(payload),
      throttleMs: 0,
    });

    const running = svc.run();
    await d.firstDurable;
    assert.equal(svc.pause("weights"), true);
    await running;

    const paused = svc.status().components[0]!;
    assert.equal(paused.state, "paused");
    assert.equal(paused.pauseSupported, true);
    assert.equal(paused.bytesDone, 1536);
    const receiptFiles = await readdir(join(appRoot, ".setup-downloads"));
    assert.equal(receiptFiles.length, 1);
    const receipt = JSON.parse(await readFile(join(appRoot, ".setup-downloads", receiptFiles[0]!), "utf8"));
    assert.deepEqual(
      {
        componentId: receipt.componentId,
        url: receipt.url,
        target: receipt.target,
        durableBytes: receipt.durableBytes,
      },
      {
        componentId: "weights",
        url: "https://example.test/ggml.bin",
        target: join(appRoot, "models", "whisper", "ggml.bin"),
        durableBytes: 1536,
      },
    );
    assert.equal((await stat(receipt.partialPath)).size, 1536);

    assert.equal(svc.resume("weights"), true);
    await svc.run();
    assert.deepEqual(d.ranges, [null, 1536]);
    assert.equal(svc.status().components[0]!.state, "ready");
    assert.deepEqual(await readFile(join(appRoot, "models", "whisper", "ggml.bin")), Buffer.from(payload));
    assert.deepEqual(await readdir(join(appRoot, ".setup-downloads")), []);
  });

  it("recovers a disposed transfer from its app-owned receipt after restart", async () => {
    const appRoot = await root();
    const payload = bytes(3072);
    const firstDeps = resumableDeps(payload, 1024);
    const first = new LocalSetupService(firstDeps, () => {}, {
      appRoot,
      catalogue: digestCatalogue(payload),
      throttleMs: 0,
    });
    const running = first.run();
    await firstDeps.firstDurable;
    await first.dispose();
    await running;

    const secondDeps = resumableDeps(payload, 1024);
    const events: DomainEvent[] = [];
    const restored = new LocalSetupService(secondDeps, (event) => events.push(event), {
      appRoot,
      catalogue: digestCatalogue(payload),
      throttleMs: 0,
    });
    await restored.detect();
    assert.equal(last(events).components[0]!.state, "paused");
    assert.equal(last(events).components[0]!.bytesDone, 1024);
    assert.equal(restored.resume("weights"), true);
    await restored.run();
    assert.deepEqual(secondDeps.ranges, [1024]);
    assert.deepEqual(await readFile(join(appRoot, "models", "whisper", "ggml.bin")), Buffer.from(payload));
  });

  it("finishes verification from a complete receipt without requesting bytes past EOF", async () => {
    const appRoot = await root();
    const payload = bytes(3072);
    const firstDeps = resumableDeps(payload, 1024);
    const first = new LocalSetupService(firstDeps, () => {}, {
      appRoot,
      catalogue: digestCatalogue(payload),
      throttleMs: 0,
    });
    const running = first.run();
    await firstDeps.firstDurable;
    first.pause("weights");
    await running;
    const receiptDir = join(appRoot, ".setup-downloads");
    const receiptPath = join(receiptDir, (await readdir(receiptDir))[0]!);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    await writeFile(receipt.partialPath, payload);
    await writeFile(receiptPath, JSON.stringify({
      ...receipt,
      durableBytes: payload.byteLength,
      downloadComplete: true,
      rangeSupported: false,
    }));

    const restoredDeps = deps();
    const restored = new LocalSetupService(restoredDeps, () => {}, {
      appRoot,
      catalogue: digestCatalogue(payload),
      throttleMs: 0,
    });
    await restored.detect();
    assert.equal(restored.resume("weights"), true);
    await restored.run();
    assert.ok(!restoredDeps.calls.some((call) => call.startsWith("fetch")));
    assert.equal(restored.status().components[0]!.state, "ready");
    assert.deepEqual(await readFile(join(appRoot, "models", "whisper", "ggml.bin")), Buffer.from(payload));
  });

  it("resumes with only the remaining disk space and finishes a closure added after pausing", async () => {
    const appRoot = await root();
    const payload = bytes(3 * 1024 * 1024);
    const entries = digestCatalogue(payload);
    const weights = entries[0]!;
    if (weights.spec.kind !== "files") throw new Error("test catalogue changed");
    entries[0] = {
      ...weights,
      sizeMb: 3,
      optional: true,
      spec: {
        ...weights.spec,
        files: [{ ...weights.spec.files[0]!, sizeMb: 3 }],
      },
    };
    entries.push({
      id: "model",
      displayName: "Writing model",
      purpose: "Writes here",
      sizeMb: 0,
      optional: true,
      requires: ["weights"],
      spec: { kind: "pull", command: "ollama", args: ["pull", "test:model"] },
    });
    let freeMb = 10;
    const firstDeps = resumableDeps(payload, 2 * 1024 * 1024);
    firstDeps.diskFreeMb = async () => freeMb;
    const first = new LocalSetupService(firstDeps, () => {}, {
      appRoot,
      catalogue: entries,
      headroomMb: 0,
      throttleMs: 0,
    });
    first.retry("weights");
    await firstDeps.firstDurable;
    first.pause("weights");
    await first.run();
    first.installClosure("model");
    await first.dispose();

    freeMb = 1;
    const secondDeps = resumableDeps(payload, 2 * 1024 * 1024);
    secondDeps.diskFreeMb = async () => freeMb;
    const restored = new LocalSetupService(secondDeps, () => {}, {
      appRoot,
      catalogue: entries,
      headroomMb: 0,
      throttleMs: 0,
    });
    await restored.detect();
    assert.equal(restored.status().components.find((component) => component.id === "model")?.state, "blocked");
    assert.equal(restored.resume("weights"), true);
    await restored.run();
    assert.equal(restored.status().components.find((component) => component.id === "weights")?.state, "ready");
    assert.equal(restored.status().components.find((component) => component.id === "model")?.state, "ready");
    assert.ok(secondDeps.calls.some((call) => call === "run ollama pull test:model"));
  });

  it("publishes unsupported pause when Accept-Ranges is absent", async () => {
    const appRoot = await root();
    const d = resumableDeps(bytes(2048), 512, { acceptRanges: false });
    const svc = new LocalSetupService(d, () => {}, {
      appRoot,
      catalogue: catalogue().filter((entry) => entry.id === "weights"),
      throttleMs: 0,
    });
    const running = svc.run();
    await d.firstDurable;
    assert.equal(svc.status().components[0]!.state, "downloading");
    assert.equal(svc.status().components[0]!.pauseSupported, false);
    assert.equal(svc.pause("weights"), false);
    d.releaseInitial();
    await running;
    assert.equal(svc.status().components[0]!.state, "ready");
  });

  it("refuses a resume that answers 200 instead of a matching partial response", async () => {
    const appRoot = await root();
    const payload = bytes(2048);
    const d = resumableDeps(payload, 768, { resumeStatus: 200 });
    const svc = new LocalSetupService(d, () => {}, {
      appRoot,
      catalogue: digestCatalogue(payload),
      throttleMs: 0,
    });
    const running = svc.run();
    await d.firstDurable;
    assert.equal(svc.pause("weights"), true);
    await running;
    assert.equal(svc.resume("weights"), true);
    await svc.run();
    assert.equal(svc.status().components[0]!.state, "failed");
    assert.match(svc.status().components[0]!.detail ?? "", /answered 200, not 206/);
    assert.deepEqual(d.ranges, [null, 768]);
    await assert.rejects(readFile(join(appRoot, "models", "whisper", "ggml.bin")));
  });

  it("requires a ranged 206 even when the durable resume offset is zero", async () => {
    const appRoot = await root();
    const payload = bytes(1024);
    const d = resumableDeps(payload, 0, { resumeStatus: 200 });
    const svc = new LocalSetupService(d, () => {}, {
      appRoot,
      catalogue: digestCatalogue(payload),
      throttleMs: 0,
    });
    const running = svc.run();
    await d.firstDurable;
    assert.equal(svc.pause("weights"), true);
    await running;
    assert.equal(svc.status().components[0]!.bytesDone, 0);
    svc.resume("weights");
    await svc.run();
    assert.deepEqual(d.ranges, [null, 0]);
    assert.match(svc.status().components[0]!.detail ?? "", /answered 200, not 206/);
  });

  it("refuses a resume whose Content-Range starts at a different byte", async () => {
    const appRoot = await root();
    const payload = bytes(2048);
    const d = resumableDeps(payload, 768, { resumeStart: 0 });
    const svc = new LocalSetupService(d, () => {}, {
      appRoot,
      catalogue: digestCatalogue(payload),
      throttleMs: 0,
    });
    const running = svc.run();
    await d.firstDurable;
    svc.pause("weights");
    await running;
    svc.resume("weights");
    await svc.run();
    assert.equal(svc.status().components[0]!.state, "failed");
    assert.match(svc.status().components[0]!.detail ?? "", /Content-Range started at 0, not 768/);
  });

  it("refuses a resume whose Content-Range does not cover the complete remainder", async () => {
    const appRoot = await root();
    const payload = bytes(2048);
    const d = resumableDeps(payload, 768, { resumeEnd: 1600 });
    const svc = new LocalSetupService(d, () => {}, {
      appRoot,
      catalogue: digestCatalogue(payload),
      throttleMs: 0,
    });
    const running = svc.run();
    await d.firstDurable;
    svc.pause("weights");
    await running;
    svc.resume("weights");
    await svc.run();
    assert.equal(svc.status().components[0]!.state, "failed");
    assert.match(svc.status().components[0]!.detail ?? "", /Content-Range did not describe the complete remainder/);
    assert.equal(svc.status().components[0]!.bytesDone, 0);
  });

  it("refuses a resume when the response validator changed", async () => {
    const appRoot = await root();
    const payload = bytes(2048);
    const d = resumableDeps(payload, 768, { resumeValidator: '"weights-v2"' });
    const svc = new LocalSetupService(d, () => {}, {
      appRoot,
      catalogue: digestCatalogue(payload),
      throttleMs: 0,
    });
    const running = svc.run();
    await d.firstDurable;
    svc.pause("weights");
    await running;
    svc.resume("weights");
    await svc.run();
    assert.equal(svc.status().components[0]!.state, "failed");
    assert.match(svc.status().components[0]!.detail ?? "", /source changed/);
    assert.equal(svc.status().components[0]!.bytesDone, 0);
  });

  it("retains a durable prefix when a resumed stream fails transiently", async () => {
    const appRoot = await root();
    const payload = bytes(4096);
    const d = resumableDeps(payload, 1024);
    const fetchStream = d.fetchStream.bind(d);
    let resumedAttempts = 0;
    d.fetchStream = async (url, signal, rangeStart, validator) => {
      if (rangeStart !== null && resumedAttempts++ === 0) {
        const end = rangeStart + 511;
        return {
          ok: true,
          status: 206,
          contentLength: payload.byteLength - rangeStart,
          acceptRanges: true,
          contentRangeStart: rangeStart,
          contentRangeEnd: payload.byteLength - 1,
          contentRangeTotal: payload.byteLength,
          validator: '"weights-v1"',
          body: (async function* () {
            yield payload.subarray(rangeStart, end + 1);
            throw new Error("connection reset");
          })(),
        };
      }
      return fetchStream(url, signal, rangeStart, validator);
    };
    const svc = new LocalSetupService(d, () => {}, {
      appRoot,
      catalogue: digestCatalogue(payload),
      throttleMs: 0,
    });
    const running = svc.run();
    await d.firstDurable;
    svc.pause("weights");
    await running;
    svc.resume("weights");
    await svc.run();
    assert.equal(svc.status().components[0]!.state, "paused");
    assert.match(svc.status().components[0]!.detail ?? "", /connection reset/);
    assert.equal(svc.status().components[0]!.bytesDone, 1536);

    svc.resume("weights");
    await svc.run();
    assert.equal(svc.status().components[0]!.state, "ready");
    assert.deepEqual(await readFile(join(appRoot, "models", "whisper", "ggml.bin")), Buffer.from(payload));
  });

  it("Stop all discards a paused owned partial without touching an unrelated one", async () => {
    const appRoot = await root();
    const payload = bytes(2048);
    const d = resumableDeps(payload, 640);
    const svc = new LocalSetupService(d, () => {}, {
      appRoot,
      catalogue: digestCatalogue(payload),
      throttleMs: 0,
    });
    const running = svc.run();
    await d.firstDurable;
    svc.pause("weights");
    await running;
    const receiptDir = join(appRoot, ".setup-downloads");
    const receiptName = (await readdir(receiptDir))[0]!;
    const receipt = JSON.parse(await readFile(join(receiptDir, receiptName), "utf8"));
    const unrelated = join(appRoot, "models", "whisper", "somebody-else.partial");
    await writeFile(unrelated, "not ours");

    await svc.cancel();

    await assert.rejects(stat(receipt.partialPath));
    assert.deepEqual(await readdir(receiptDir), []);
    assert.equal((await stat(unrelated)).isFile(), true);
    assert.equal(svc.status().components[0]!.state, "skipped");
    assert.equal(svc.status().components[0]!.bytesDone, 0);
  });

  it("does not infer ownership from an unreceipted partial", async () => {
    const appRoot = await root();
    await mkdir(join(appRoot, "models", "whisper"), { recursive: true });
    const orphan = join(appRoot, "models", "whisper", "ggml.bin.partial");
    await writeFile(orphan, bytes(512));
    const events: DomainEvent[] = [];
    const svc = new LocalSetupService(deps(), (e) => events.push(e), {
      appRoot,
      catalogue: catalogue().filter((c) => c.id === "weights"),
      throttleMs: 0,
    });

    await svc.run();

    assert.equal((await stat(orphan)).isFile(), true, "a conventional name is not ownership proof");
    assert.equal(last(events).components[0]!.state, "ready");
  });

  it("an offered model is never fetched unasked, and downloads when it is", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    const d = deps({ installed: true });
    const offered: CatalogueEntry[] = [
      {
        id: "big-model",
        displayName: "Gemma 4 · 12B",
        purpose: "Reads images, holds a long context",
        sizeMb: 7600,
        optional: true,
        spec: { kind: "pull", command: "ollama", args: ["pull", "gemma4:12b"] },
      },
    ];
    const svc = new LocalSetupService(d, (e) => events.push(e), { appRoot, catalogue: offered, throttleMs: 0 });

    await svc.run();
    assert.equal(last(events).components[0]!.state, "available", "setup leaves it alone");
    assert.ok(!d.calls.some((c) => c.includes("pull")), "nothing was pulled unasked");
    assert.equal(catalogueTotalMb(offered), 0, "an offered model is nobody's cost until chosen");

    // What the Download button does.
    svc.retry("big-model");
    await svc.run();
    assert.equal(last(events).components[0]!.state, "ready");
    assert.ok(d.calls.includes("run ollama pull gemma4:12b"));
  });

  it("tells one tag from another — gemma4:12b is not gemma4:e2b", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    const d = deps({
      installed: true,
      listOutput: ["NAME              ID    SIZE", "gemma4:e2b        abc   7.2 GB", ""].join("\n"),
    });
    const svc = new LocalSetupService(d, (e) => events.push(e), {
      appRoot,
      catalogue: [
        {
          id: "twelve",
          displayName: "Gemma 4 · 12B",
          purpose: "the twelve",
          sizeMb: 7600,
          spec: { kind: "pull", command: "ollama", args: ["pull", "gemma4:12b"] },
        },
      ],
      throttleMs: 0,
    });

    await svc.run();

    // The list holds a different gemma4; the one we want is still missing, so it was pulled.
    assert.equal(last(events).components[0]!.state, "ready");
    assert.ok(d.calls.includes("run ollama pull gemma4:12b"));
  });

  it("a skipped component is left alone, and retry puts it back", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    const d = deps();
    const svc = new LocalSetupService(d, (e) => events.push(e), {
      appRoot,
      catalogue: catalogue().filter((c) => c.id === "weights"),
      throttleMs: 0,
    });

    svc.skip("weights");
    await svc.run();
    assert.equal(last(events).components[0]!.state, "skipped");
    assert.ok(!d.calls.some((c) => c.startsWith("fetch")));

    svc.retry("weights");
    await svc.run(); // resolves with the run retry() started, however long it takes
    assert.equal(last(events).components[0]!.state, "ready");
  });

  it("repair uses the canonical Whisper id and replaces the files Voxa launches", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    const voiceCatalogue = SETUP_CATALOGUE.filter((entry) => entry.id === VOXA_SETUP_COMPONENT_IDS.whisper);
    const target = join(appRoot, "models", "whisper-base-en", "ggml-base.en.bin");
    await mkdir(join(appRoot, "models", "whisper-base-en"), { recursive: true });
    await writeFile(target, bytes(2048));
    const d = deps();
    const svc = new LocalSetupService(d, (event) => events.push(event), {
      appRoot,
      catalogue: voiceCatalogue,
      throttleMs: 0,
    });

    await svc.detect();
    assert.equal(last(events).components[0]?.state, "present");
    await svc.repair(VOXA_SETUP_COMPONENT_IDS.whisper);
    await assert.rejects(readFile(target));
    assert.equal(last(events).components[0]?.state, "queued");
    await svc.run();
    assert.equal((await readFile(target)).byteLength, 2048);
  });

  it("the model waits for its runtime, and says what it is waiting on", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    const svc = new LocalSetupService(deps(), (e) => events.push(e), {
      appRoot,
      catalogue: catalogue().filter((c) => c.id === "model"),
      throttleMs: 0,
    });

    await svc.run();

    const model = last(events).components[0]!;
    assert.equal(model.state, "blocked");
    assert.match(model.detail ?? "", /waiting on/);
  });
});

/**
 * An archive component: the shape the Higgsfield CLI arrives in (issue 137). A release
 * publishes one archive per architecture holding a single executable, so the component fetches,
 * verifies, unpacks, and uses the binary where it landed — nothing is installed and nothing
 * reaches PATH.
 */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

function archiveCatalogue(): CatalogueEntry[] {
  return [
    {
      id: "higgsfield-cli",
      displayName: "Higgsfield CLI",
      purpose: "Generates through your Higgsfield account",
      sizeMb: 1,
      optional: true,
      spec: {
        kind: "archive",
        dir: "higgsfield-cli",
        executable: "hf.exe",
        byArch: {
          x64: { url: "https://example.test/hf_x64.tar.gz", file: "hf_x64.tar.gz", sizeMb: 1, magic: GZIP_MAGIC },
          arm64: { url: "https://example.test/hf_arm64.tar.gz", file: "hf_arm64.tar.gz", sizeMb: 1, magic: GZIP_MAGIC },
        },
      },
    },
  ];
}

/** A `tar` that really writes the executable the archive is supposed to contain. */
function archiveDeps(opts: { tarCode?: number; emit?: boolean } = {}) {
  const base = deps({ chunks: [bytes(2048, GZIP_MAGIC)] });
  return {
    ...base,
    async run(command: string, args: readonly string[]) {
      base.calls.push(`run ${command} ${args.join(" ")}`);
      // Matched by basename: the extractor is resolved to Windows' bsdtar by absolute path
      // rather than taken off PATH (see systemTar).
      if (/(^|[\\/])tar(\.exe)?$/i.test(command) && (opts.emit ?? true)) {
        const into = args[args.indexOf("-C") + 1]!;
        await mkdir(into, { recursive: true });
        await writeFile(join(into, "hf.exe"), "MZ");
      }
      return { code: opts.tarCode ?? 0, output: opts.tarCode ? "tar: not in gzip format" : "" };
    },
  };
}

describe("a tool that arrives as an archive (issue 137)", () => {
  it("fetches this machine's architecture, unpacks it, and lands the executable", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    const d = archiveDeps();
    const svc = new LocalSetupService(d, (e) => events.push(e), {
      appRoot,
      catalogue: archiveCatalogue(),
      throttleMs: 0,
      arch: "arm64",
    });

    svc.retry("higgsfield-cli");
    await svc.run();

    assert.ok(d.calls.includes("fetch https://example.test/hf_arm64.tar.gz"), "the arm64 archive, not the x64 one");
    const row = last(events).components.find((c) => c.id === "higgsfield-cli");
    assert.equal(row?.state, "ready");
    // Beside the models, not among them: an executable is not a weight file.
    assert.equal(await readFile(join(appRoot, "higgsfield-cli", "hf.exe"), "utf8"), "MZ");
  });

  it("is offered, never fetched unasked — a vendor's tool is not the app's call", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    const d = archiveDeps();
    const svc = new LocalSetupService(d, (e) => events.push(e), {
      appRoot,
      catalogue: archiveCatalogue(),
      throttleMs: 0,
    });

    await svc.run();
    assert.equal(last(events).components.find((c) => c.id === "higgsfield-cli")?.state, "available");
    assert.equal(d.calls.filter((c) => c.startsWith("fetch")).length, 0);
  });

  it("an archive that does not unpack leaves nothing that looks installed", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    const svc = new LocalSetupService(archiveDeps({ tarCode: 1, emit: false }), (e) => events.push(e), {
      appRoot,
      catalogue: archiveCatalogue(),
      throttleMs: 0,
    });

    svc.retry("higgsfield-cli");
    await svc.run();

    const row = last(events).components.find((c) => c.id === "higgsfield-cli");
    assert.equal(row?.state, "failed");
    assert.match(row!.detail!, /gzip/);
    // Discovery stats this path. A half-unpacked archive here would read as a working tool.
    await assert.rejects(readFile(join(appRoot, "higgsfield-cli", "hf.exe")));
  });

  it("says so rather than guessing when no build exists for this machine", async () => {
    const appRoot = await root();
    const events: DomainEvent[] = [];
    const only = archiveCatalogue();
    only[0]!.spec = { ...(only[0]!.spec as { kind: "archive" } & Record<string, unknown>), byArch: {} } as never;
    const svc = new LocalSetupService(archiveDeps(), (e) => events.push(e), {
      appRoot,
      catalogue: only,
      throttleMs: 0,
      arch: "arm64",
    });

    svc.retry("higgsfield-cli");
    await svc.run();

    const row = last(events).components.find((c) => c.id === "higgsfield-cli");
    assert.equal(row?.state, "blocked");
    assert.match(row!.detail!, /architecture/);
  });
});

describe("the tar we mean (#195, and again in issue 137)", () => {
  it("never invokes a bare tar on Windows, whatever the shell's PATH prefers", () => {
    const resolved = systemTar();
    if (process.platform !== "win32") {
      assert.equal(resolved, "tar");
      return;
    }
    // GNU tar — which Git Bash and MSYS2 put ahead of bsdtar — reads the `C:` in an absolute
    // archive path as a remote host: "Cannot connect to C: resolve failed". A user's PATH is
    // not ours to predict, so the binary is resolved rather than the path escaped. The bare
    // name survives only as a fallback for a Windows install with no System32 copy.
    const system32 = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
    assert.equal(resolved, existsSync(system32) ? system32 : "tar");
    if (existsSync(system32)) assert.notEqual(resolved, "tar");
  });
});
