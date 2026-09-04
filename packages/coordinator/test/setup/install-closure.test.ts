import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupClosure, transferProgress, type DomainEvent, type SetupComponent } from "@arke-studio/contracts";
import { LocalSetupService } from "../../src/setup/local-setup.js";
import type { CatalogueEntry } from "../../src/setup/catalogue.js";
import { tempDir } from "../tmp.js";

/**
 * What an install chain is built from, and what it costs (SPEC-033 §1.8).
 *
 * SPEC-028 R-5 already requires one-action activation over a complete dependency closure. What
 * this covers is where the closure comes from — declared data, never inferred from an
 * identifier's shape — and how its size is spoken about: the figure on the button is the figure
 * that lands on disk.
 */

const RUNTIME: CatalogueEntry = {
  id: "engine-runtime",
  displayName: "Engine",
  purpose: "Runs the models",
  sizeMb: 2000,
  installedMb: 8000,
  optional: true,
  spec: { kind: "files", dir: "engine", files: [{ url: "https://example/e", file: "e.bin", sizeMb: 2000 }] },
};

const WEIGHTS: CatalogueEntry = {
  id: "engine-weights-big",
  displayName: "Big weights",
  purpose: "Model files",
  sizeMb: 10_000,
  optional: true,
  requires: ["engine-runtime"],
  spec: { kind: "files", dir: "weights", files: [{ url: "https://example/w", file: "w.bin", sizeMb: 10_000 }] },
};

const SIBLING: CatalogueEntry = {
  id: "engine-weights-small",
  displayName: "Small weights",
  purpose: "Model files",
  sizeMb: 500,
  optional: true,
  requires: ["engine-runtime"],
  spec: { kind: "files", dir: "small", files: [{ url: "https://example/s", file: "s.bin", sizeMb: 500 }] },
};

function service(catalogue: readonly CatalogueEntry[], appRoot: string) {
  const events: DomainEvent[] = [];
  const svc = new LocalSetupService(
    {
      fetchStream: async () => ({ ok: false, status: 500, contentLength: null, body: (async function* () {})() }),
      run: async () => ({ code: 1, output: "" }),
      which: async () => null,
      probeUrl: async () => false,
      diskFreeMb: async () => 1_000_000,
    },
    (event) => events.push(event),
    { appRoot, catalogue, throttleMs: 0 },
  );
  const status = () => {
    const last = events.filter((e) => e.type === "setup.status").at(-1);
    assert.ok(last && last.type === "setup.status");
    return last.setup;
  };
  return { svc, events, status };
}

describe("the closure is declared data, and its total is what the button says (R-39, R-40)", () => {
  const components = (over: Partial<Record<string, SetupComponent["state"]>> = {}): SetupComponent[] =>
    [RUNTIME, WEIGHTS, SIBLING].map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      purpose: entry.purpose,
      sizeMb: entry.sizeMb,
      installLocation: "/models",
      state: over[entry.id] ?? "available",
      bytesDone: 0,
      bytesTotal: 0,
      bytesPerSecond: null,
      ...(entry.requires !== undefined ? { requires: [...entry.requires] } : {}),
      ...(entry.installedMb !== undefined ? { installedMb: entry.installedMb } : {}),
    }));

  it("carries the whole chain, dependencies first, at the whole chain's size", () => {
    const closure = setupClosure(components(), "engine-weights-big");
    assert.deepEqual(closure.componentIds, ["engine-runtime", "engine-weights-big"]);
    // Quoting the model's own weight while silently fetching an engine beside it makes honest
    // arithmetic dishonest: 10 GB of weights plus a 2 GB engine is a 12 GB press.
    assert.equal(closure.downloadMb, 12_000);
    // Peak disk uses each component's installed figure where it has one — an archive that is
    // extracted holds both copies at once, and the guard measures against that.
    assert.equal(closure.installedMb, 18_000);
    assert.equal(closure.supporting, 1);
  });

  it("leaves out what is already here, so a shared component is not quoted twice (R-44)", () => {
    const closure = setupClosure(components({ "engine-runtime": "ready" }), "engine-weights-big");
    assert.deepEqual(closure.componentIds, ["engine-weights-big"]);
    assert.equal(closure.downloadMb, 10_000);
    // Nothing to support, so the row says nothing about supporting components rather than "0".
    assert.equal(closure.supporting, 0);
  });

  it("is the same graph for a sibling, and neither fetches the engine twice", () => {
    const both = components();
    assert.deepEqual(setupClosure(both, "engine-weights-small").componentIds, [
      "engine-runtime",
      "engine-weights-small",
    ]);
    const after = components({ "engine-runtime": "present", "engine-weights-big": "ready" });
    assert.deepEqual(setupClosure(after, "engine-weights-small").componentIds, ["engine-weights-small"]);
  });
});

describe("one press starts the chain (SPEC-028 R-5, R-40)", () => {
  it("queues every unsettled member, not just the one that was asked for", async () => {
    const root = await tempDir("arke-setup-");
    const { svc, status } = service([RUNTIME, WEIGHTS, SIBLING], root);
    const closure = svc.installClosure("engine-weights-big");
    assert.deepEqual(closure.componentIds, ["engine-runtime", "engine-weights-big"]);
    const queued = status().components.filter((c) => c.state === "queued" || c.state === "downloading");
    assert.deepEqual(
      queued.map((c) => c.id).sort(),
      ["engine-runtime", "engine-weights-big"],
      "the sibling was not asked for and is not started",
    );
    await svc.cancel();
    await svc.dispose();
  });
});

describe("remove answers for what Arke owns, and nothing else (R-43)", () => {
  it("refuses a component setup fetches unasked, because the next launch undoes it", async () => {
    const root = await tempDir("arke-setup-");
    const required: CatalogueEntry = { ...SIBLING, id: "required-weights", optional: false };
    const { svc, status } = service([required], root);
    const result = await svc.remove(required.id);
    assert.equal(result.freedMb, 0);
    assert.match(status().components[0]!.detail ?? "", /Arke did not put this here/);
    assert.notEqual(status().components[0]!.removable, true, "and the row is never offered one");
    await svc.dispose();
  });

  it("refuses a weight file living in a folder the user mapped", async () => {
    // The row can read `present` because the person already owned the checkpoint — `install`
    // recognises a file that is already there rather than re-fetching it — so a Remove here
    // would delete somebody's own 28 GB weights from a folder Arke does not own.
    const root = await tempDir("arke-setup-");
    const mapped = await tempDir("arke-mapped-");
    const theirs: CatalogueEntry = {
      ...SIBLING,
      id: "engine-weights-mapped",
      spec: { kind: "files", dir: "", externalRoot: "engine-models", files: SIBLING.spec.kind === "files" ? SIBLING.spec.files : [] },
    };
    const events: DomainEvent[] = [];
    const svc = new LocalSetupService(
      {
        fetchStream: async () => ({ ok: false, status: 500, contentLength: null, body: (async function* () {})() }),
        run: async () => ({ code: 1, output: "" }),
        which: async () => null,
        probeUrl: async () => false,
        diskFreeMb: async () => 1_000_000,
      },
      (event) => events.push(event),
      { appRoot: root, catalogue: [theirs], throttleMs: 0, externalDirs: { "engine-models": () => mapped } },
    );
    await mkdir(mapped, { recursive: true });
    await writeFile(join(mapped, "s.bin"), Buffer.alloc(1024));
    const result = await svc.remove(theirs.id);
    assert.equal(result.freedMb, 0);
    assert.ok((await stat(join(mapped, "s.bin")).catch(() => null)) !== null, "their file is still there");
    await svc.dispose();
  });

  it("asks the runtime to take back what the runtime pulled", async () => {
    // `rm -rf` on a store Arke does not own is not a removal, it is damage — so a pulled model
    // is removed the way it arrived, by asking Ollama.
    const root = await tempDir("arke-setup-");
    const pulled: CatalogueEntry = {
      id: "ollama-gemma4-12b",
      displayName: "Gemma 4 · 12B",
      purpose: "Writes with you",
      sizeMb: 7600,
      optional: true,
      requires: ["engine-runtime"],
      spec: { kind: "pull", command: "ollama", args: ["pull", "gemma4:12b"] },
    };
    const asked: string[][] = [];
    const events: DomainEvent[] = [];
    const svc = new LocalSetupService(
      {
        fetchStream: async () => ({ ok: false, status: 500, contentLength: null, body: (async function* () {})() }),
        run: async (command, args) => {
          asked.push([command, ...args]);
          return { code: 0, output: "" };
        },
        which: async () => null,
        probeUrl: async () => false,
        diskFreeMb: async () => 1_000_000,
      },
      (event) => events.push(event),
      { appRoot: root, catalogue: [pulled], throttleMs: 0 },
    );
    const result = await svc.remove(pulled.id);
    assert.deepEqual(asked, [["ollama", "rm", "gemma4:12b"]]);
    assert.equal(result.freedMb, 7600);
    await svc.dispose();
  });
});

describe("remove gives the disk back, and says what would not go (R-43, R-45)", () => {
  it("removes the files it declared and reports what it freed", async () => {
    const root = await tempDir("arke-setup-");
    await mkdir(join(root, "models", "small"), { recursive: true });
    await writeFile(join(root, "models", "small", "s.bin"), Buffer.alloc(2 * 1024 * 1024));
    const { svc, status } = service([RUNTIME, SIBLING], root);
    await svc.detect();
    assert.equal(status().components.find((c) => c.id === SIBLING.id)?.state, "present");

    const result = await svc.remove(SIBLING.id);
    assert.deepEqual(result.leftovers, [], "nothing was held open");
    assert.equal(result.freedMb, 2);
    const after = status().components.find((c) => c.id === SIBLING.id)!;
    assert.equal(after.state, "available");
    assert.match(after.detail ?? "", /removed · 2 MB free/);
    await svc.dispose();
  });

  it("refuses to take a component an installed dependant still needs (R-44)", async () => {
    const root = await tempDir("arke-setup-");
    await mkdir(join(root, "models", "engine"), { recursive: true });
    await writeFile(join(root, "models", "engine", "e.bin"), Buffer.alloc(1024));
    await mkdir(join(root, "models", "weights"), { recursive: true });
    await writeFile(join(root, "models", "weights", "w.bin"), Buffer.alloc(1024));
    const { svc, status } = service([RUNTIME, WEIGHTS], root);
    await svc.detect();

    const result = await svc.remove(RUNTIME.id);
    assert.equal(result.freedMb, 0);
    const engine = status().components.find((c) => c.id === RUNTIME.id)!;
    assert.equal(engine.state, "present", "still here, because something still needs it");
    // The refusal names the dependant rather than the rule.
    assert.match(engine.detail ?? "", /Big weights needs this/);
    await svc.dispose();
  });
});

describe("one projection for a transfer, computed once (R-82)", () => {
  it("states percent, figures and rate from the component's own bytes", () => {
    const moving: SetupComponent = {
      id: "engine-weights-big",
      displayName: "Big weights",
      purpose: "Model files",
      sizeMb: 10_000,
      installLocation: "/models/weights",
      state: "downloading",
      bytesDone: 2.5 * 1024 * 1024 * 1024,
      bytesTotal: 10 * 1024 * 1024 * 1024,
      bytesPerSecond: 12 * 1024 * 1024,
    };
    assert.deepEqual(transferProgress(moving), { percent: 25, doneMb: 2560, mbPerSecond: 12, active: true });
    // A server that never said how big the file is gives 0 rather than a made-up denominator.
    assert.equal(transferProgress({ ...moving, bytesTotal: 0 }).percent, 0);
    assert.equal(transferProgress({ ...moving, state: "ready", bytesPerSecond: null }).active, false);
  });
});
