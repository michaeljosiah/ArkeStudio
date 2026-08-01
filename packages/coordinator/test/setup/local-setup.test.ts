import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DomainEvent, SetupStatus } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { LocalSetupService, type SetupDeps } from "../../src/setup/local-setup.js";
import type { CatalogueEntry } from "../../src/setup/catalogue.js";

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
  chunks?: Uint8Array[];
  contentLength?: number | null;
  status?: number;
  runCode?: number;
  diskFreeMb?: number | null;
}

function deps(opts: FakeOpts = {}): SetupDeps & { calls: string[] } {
  let installed = opts.installed ?? false;
  const calls: string[] = [];
  return {
    calls,
    async fetchStream(url) {
      calls.push(`fetch ${url}`);
      const chunks = opts.chunks ?? [bytes(2048)];
      const total = chunks.reduce((s, c) => s + c.byteLength, 0);
      return {
        ok: (opts.status ?? 200) < 400,
        status: opts.status ?? 200,
        contentLength: opts.contentLength === undefined ? total : opts.contentLength,
        body: (async function* () {
          for (const c of chunks) yield c;
        })(),
      };
    },
    async run(command, args) {
      calls.push(`run ${command} ${args.join(" ")}`);
      if (command.endsWith("OllamaSetup.exe")) installed = true;
      if (command === "ollama" && args[0] === "list") return { code: 0, output: installed ? "" : "" };
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

async function root(): Promise<string> {
  return tempDir("arke-setup-");
}

function last(events: DomainEvent[]): SetupStatus {
  const e = [...events].reverse().find((x) => x.type === "setup.status");
  assert.ok(e && e.type === "setup.status", "a setup.status event was emitted");
  return e.setup;
}

describe("fetching the local runtimes at setup", () => {
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
    assert.equal(status.running, false);

    // The weights landed under the app root, whole — never a .partial.
    const written = await readFile(join(appRoot, "models", "whisper", "ggml.bin"));
    assert.equal(written.byteLength, 2048);
    // The installer ran silently, and the pull happened only after the runtime arrived.
    assert.ok(d.calls.some((c) => c.includes("OllamaSetup.exe /VERYSILENT")));
    assert.ok(d.calls.indexOf("run ollama pull llama3.1:8b") > d.calls.findIndex((c) => c.includes("OllamaSetup.exe")));
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

  it("sweeps the debris of a cancelled run before starting a new one", async () => {
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

    await assert.rejects(readFile(orphan), "the fragment from the cancelled run is gone");
    assert.equal(last(events).components[0]!.state, "ready");
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
