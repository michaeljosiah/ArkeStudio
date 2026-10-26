import assert from "node:assert/strict";
import { it } from "node:test";
import { once } from "node:events";
import WebSocket from "ws";
import { join } from "node:path";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { CatalogueEntry } from "../../src/setup/catalogue.js";
import { LocalSetupService, type SetupDeps } from "../../src/setup/local-setup.js";
import { AppStorageService } from "../../src/storage/service.js";
import { SetupFileStorage } from "../../src/storage/setup-files.js";
import type { StorageReservation } from "../../src/storage/reservations.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";

const MiB = 1024 ** 2, GiB = 1024 ** 3;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const entry = (id: string, sizeMb = 6): CatalogueEntry => ({ id, displayName: id, purpose: "Synthetic storage fixture", sizeMb,
  spec: { kind: "files", dir: id, files: [{ url: `https://example.test/${id}`, file: "weights.bin", sizeMb }] } });
const deps = (fetchStream: SetupDeps["fetchStream"]): SetupDeps => ({ fetchStream, run: async () => ({ code: 0, output: "" }),
  which: async () => null, probeUrl: async () => false, diskFreeMb: async () => 1_000_000 });
function fixture(root: string, availableBytes = GiB + 10 * MiB) {
  const started = Date.now(); let base = started, available = availableBytes;
  const now = () => base + Date.now() - started;
  const storage = new AppStorageService({ appRoot: root, now, native: {
    setRoots: () => {}, stop: async () => {}, probe: async (rootId, _signal, after) => {
      base = Math.max(base + 1, (after ?? 0) + 1 - (Date.now() - started));
      return { state: "measured", source: "host-provided", limitations: [], capacity: {
        volumeId: "same-mounted-volume", mappingRevision: rootId, measuredAt: now(), availableBytes: available, totalBytes: 500 * GiB,
      } };
    },
  } });
  return { storage, capacity: (value: number) => { available = value; base += 1001; }, space: new SetupFileStorage(storage) };
}
function response(body: AsyncIterable<Uint8Array>, length: number | null = 16) {
  return { ok: true, status: 200, contentLength: length, acceptRanges: true, contentRangeStart: null, validator: '"synthetic-version"', body };
}

it("a complete file on a full mounted destination does not block a missing file on another volume", async () => {
  const root = await tempDir("arke-setup-complete-volume-"), directory = join(root, "models", "split");
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, "complete.bin"), new Uint8Array([1, 2, 3]));
  let clock = Date.now(), roots: readonly { rootId: string; path: string }[] = [], requests = 0;
  const storage = new AppStorageService({ appRoot: root, now: () => clock, native: {
    setRoots: value => { roots = value; }, stop: async () => {}, probe: async rootId => {
      const path = roots.find(value => value.rootId === rootId)!.path, completeOnly = path.endsWith("split");
      return { state: "measured", source: "host-provided", limitations: [], capacity: { volumeId: completeOnly ? "full-volume" : "roomy-volume",
        mappingRevision: rootId, measuredAt: ++clock, availableBytes: completeOnly ? 0 : 100 * GiB, totalBytes: 200 * GiB } };
    },
  } });
  const catalogue: CatalogueEntry = { id: "split", displayName: "Split model", purpose: "Mounted destination fixture", sizeMb: 2,
    spec: { kind: "files", dir: "split", files: [
      { url: "https://example.test/complete", file: "complete.bin", sizeMb: 1 },
      { url: "https://example.test/pending", file: "../pending/weights.bin", sizeMb: 1 },
    ] } };
  const service = new LocalSetupService(deps(async url => { assert.equal(url, "https://example.test/pending"); requests++;
    return response((async function* () { yield new Uint8Array(16); })()); }), () => {},
    { appRoot: root, catalogue: [catalogue], headroomMb: 1, fileSpace: new SetupFileStorage(storage) });
  try {
    await service.run(); assert.equal(service.status().components[0]!.state, "ready"); assert.equal(requests, 1);
    assert.deepEqual([...await readFile(join(directory, "complete.bin"))], [1, 2, 3]);
    assert.equal((await readFile(join(root, "models", "pending", "weights.bin"))).length, 16);
  } finally { await service.dispose(); await storage.stop(); }
});

it("two actual file installers share one volume's remaining peak before either can overcommit it", async () => {
  const root = await tempDir("arke-setup-space-concurrent-"), h = fixture(root), entered = deferred(), finish = deferred(); let requests = 0;
  const first = new LocalSetupService(deps(async () => { requests++; entered.resolve(); return response((async function* () { await finish.promise; yield new Uint8Array(16); })()); }), () => {},
    { appRoot: root, catalogue: [entry("first")], headroomMb: 1, fileSpace: h.space });
  const second = new LocalSetupService(deps(async () => { requests++; return response((async function* () { yield new Uint8Array(16); })()); }), () => {},
    { appRoot: root, catalogue: [entry("second")], headroomMb: 1, fileSpace: h.space });
  const running = first.run();
  try {
    await entered.promise; assert.equal(h.storage.reservations.snapshot().records.length, 1);
    await second.run(); assert.equal(second.status().components[0]!.state, "blocked"); assert.equal(second.status().components[0]!.blockedBy, "disk");
    assert.equal(requests, 1, "the held component made no HTTP request");
    finish.resolve(); await running; assert.equal(first.status().components[0]!.state, "ready");
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
    h.capacity(GiB + 10 * MiB - 16); second.retry("second"); await second.run();
    assert.equal(second.status().components[0]!.state, "ready"); assert.equal(requests, 2);
    assert.equal((await readFile(join(root, "models", "first", "weights.bin"))).byteLength, 16);
    assert.equal((await readFile(join(root, "models", "second", "weights.bin"))).byteLength, 16);
  } finally { finish.resolve(); await running; await first.dispose(); await second.dispose(); await h.storage.stop(); }
});

it("rechecks a larger server-declared file before reading its body or writing beyond its reserved estimate", async () => {
  const root = await tempDir("arke-setup-space-grow-"), h = fixture(root, GiB + 4 * MiB); let readBody = false, cancelled = false;
  const service = new LocalSetupService(deps(async (_url, signal) => {
    signal.addEventListener("abort", () => { cancelled = true; }, { once: true });
    return response((async function* () { readBody = true; yield new Uint8Array(16); })(), 9 * MiB);
  }), () => {}, { appRoot: root, catalogue: [entry("growing", 1)], headroomMb: 1, fileSpace: h.space });
  try {
    await service.run(); assert.equal(service.status().components[0]!.state, "blocked"); assert(!readBody); assert(cancelled);
    assert.equal(await stat(join(root, "models", "growing", "weights.bin")).catch(() => null), null);
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await service.dispose(); await h.storage.stop(); }
});

it("an unknown-length response cannot write an unbounded file and preserves its valid resumable prefix", async () => {
  const root = await tempDir("arke-setup-space-bound-"), h = fixture(root); const first = new Uint8Array(MiB); let requests = 0;
  const details: string[] = [];
  const service = new LocalSetupService(deps(async (_url, _signal, start) => {
    if (++requests === 1) return response((async function* () { yield first; yield new Uint8Array(1); })(), null);
    assert.equal(start, MiB);
    return { ...response((async function* () { yield new Uint8Array([7]); })(), 1), status: 206,
      contentRangeStart: MiB, contentRangeEnd: MiB, contentRangeTotal: MiB + 1 };
  }), event => { if (event.type === "setup.status") for (const component of event.setup.components) if (component.detail) details.push(component.detail); },
    { appRoot: root, catalogue: [entry("bounded", 1)], headroomMb: 1, fileSpace: h.space });
  try {
    await service.run(); const component = service.status().components[0]!;
    assert.equal(component.state, "paused"); assert.equal(component.bytesDone, MiB); assert(component.pauseSupported);
    assert.equal(await stat(join(root, "models", "bounded", "weights.bin")).catch(() => null), null);
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
    const folder = join(root, "models", "bounded"), partials = (await readdir(folder)).filter(name => name.endsWith(".partial"));
    assert.equal(partials.length, 1); assert.equal((await stat(join(folder, partials[0]!))).size, MiB);
    // The existing prefix already occupies the volume. Only the last byte needs fresh
    // planning on an explicit Resume; reserving the prefix again would incorrectly hold it.
    h.capacity(GiB + 2); assert(service.resume("bounded")); await service.run();
    assert.equal(service.status().components[0]!.state, "ready", details.join(" / ")); assert.equal(requests, 2);
    const bytes = await readFile(join(folder, "weights.bin")); assert.equal(bytes.byteLength, MiB + 1); assert.equal(bytes[MiB], 7);
  } finally { await service.dispose(); await h.storage.stop(); }
});

it("the production host's install command uses shared file admission and resumes only after the competing owner settles", { timeout: 30000 }, async () => {
  const { root } = await makeTempRoot(), h = fixture(root, 2010 * MiB), provider = new FsWorldProvider(root);
  let requests = 0;
  const setup = { ...deps(async () => { requests++; return response((async function* () { yield new Uint8Array(16); })()); }),
    externallyPresent: async (id: string) => id !== "host-file" };
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth: h.storage, recoveryHistory: null,
    setup, setupExtraEntries: [{ ...entry("host-file"), optional: true }], changeLogPath: join(root, "log.jsonl"), appVersion: "setup-space-test" });
  let client: WebSocket | undefined;
  const state = () => coordinator.getState().app.setup?.components.find(value => value.id === "host-file");
  const other = h.storage.acquireRoot(join(root, "creative-scratch"), "generated-media"), owner = { kind: "job" as const, id: "synthetic-job" };
  try {
    const session = await coordinator.start(0); await h.storage.start();
    assert.equal((await h.storage.reservations.reserve({ id: "other-owner", owner, demands: [{ rootId: other.rootId, remainingBytes: 6 * MiB }] })).status, "reserved");
    client = new WebSocket(`ws://127.0.0.1:${session.port}`); const frames: unknown[] = [];
    client.on("message", raw => frames.push(JSON.parse(raw.toString()))); await once(client, "open");
    client.send(JSON.stringify({ kind: "hello", token: session.token, lastSeq: 0 }));
    await until(() => frames.some(value => (value as { kind?: string }).kind === "snapshot"), "authenticated host");
    client.send(JSON.stringify({ kind: "setup-install", componentId: "host-file" }));
    await until(() => state()?.state === "blocked", "shared storage hold before HTTP"); assert.equal(requests, 0); assert.equal(state()!.blockedBy, "disk");
    assert.equal(await h.storage.reservations.settle("other-owner", owner), true); h.capacity(2010 * MiB);
    client.send(JSON.stringify({ kind: "setup-retry", componentId: "host-file" }));
    await until(() => state()?.state === "ready" || state()?.state === "present", "explicit retry after confirmed capacity release");
    assert.equal(requests, 1); assert.equal((await readFile(join(root, "models", "host-file", "weights.bin"))).byteLength, 16);
    await until(() => h.storage.reservations.snapshot().records.length === 0, "flushed owner settlement after verified publication");
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
    assert(!JSON.stringify(coordinator.getState().app.storageHealth).includes(root));
  } finally { client?.close(); other.release(); await coordinator.stop(); await provider.close(); }
});

it("a qualified native port with unavailable capacity holds the file owner without opening a transfer", async () => {
  const root = await tempDir("arke-setup-space-unknown-"); let requests = 0;
  const storage = new AppStorageService({ appRoot: root, native: { setRoots: () => {}, stop: async () => {},
    probe: async () => ({ state: "unavailable", capacity: null, source: "host-provided", limitations: ["permission-denied"] }) } });
  const service = new LocalSetupService(deps(async () => { requests++; throw new Error("a transfer must not start"); }), () => {},
    { appRoot: root, catalogue: [entry("unknown")], fileSpace: new SetupFileStorage(storage) });
  try { await service.run(); assert.equal(requests, 0); assert.equal(service.status().components[0]!.state, "blocked"); }
  finally { await service.dispose(); await storage.stop(); }
});

it("refuses a body larger than its complete length without writing the excess or retaining an untrusted receipt", async () => {
  const root = await tempDir("arke-setup-space-length-"), h = fixture(root); let cancelled = false;
  const service = new LocalSetupService(deps(async (_url, signal) => {
    signal.addEventListener("abort", () => { cancelled = true; }, { once: true });
    return response((async function* () { yield new Uint8Array([1]); yield new Uint8Array(32); })(), 16);
  }), () => {}, { appRoot: root, catalogue: [entry("invalid-length", 1)], headroomMb: 1, fileSpace: h.space });
  try {
    await service.run(); assert.equal(service.status().components[0]!.state, "failed"); assert(cancelled);
    const folder = join(root, "models", "invalid-length"); assert.equal((await readdir(folder)).filter(name => name.endsWith(".partial")).length, 0);
    assert.equal(await stat(join(folder, "weights.bin")).catch(() => null), null); assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await service.dispose(); await h.storage.stop(); }
});

it("does not reserve a completed existing file again when another file in its component is missing", async () => {
  const root = await tempDir("arke-setup-space-existing-"), h = fixture(root, GiB + 2 * MiB), folder = join(root, "models", "existing");
  await mkdir(folder, { recursive: true }); await writeFile(join(folder, "existing.bin"), new Uint8Array([1, 2, 3])); let requests = 0;
  const component: CatalogueEntry = { ...entry("existing", 7), spec: { kind: "files", dir: "existing", files: [
    { url: "https://example.test/existing", file: "existing.bin", sizeMb: 6 },
    { url: "https://example.test/missing", file: "missing.bin", sizeMb: 1 },
  ] } };
  const service = new LocalSetupService(deps(async url => { requests++; assert.equal(url, "https://example.test/missing");
    return response((async function* () { yield new Uint8Array(16); })()); }), () => {},
    { appRoot: root, catalogue: [component], headroomMb: 1, fileSpace: h.space });
  try {
    await service.run(); assert.equal(service.status().components[0]!.state, "ready"); assert.equal(requests, 1);
    assert.deepEqual(await readFile(join(folder, "existing.bin")), Buffer.from([1, 2, 3]));
  } finally { await service.dispose(); await h.storage.stop(); }
});

it("host shutdown preserves a file checkpoint and ends admission when its progress-accounting write stays blocked", { timeout: 30000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root), entered = deferred(), finish = deferred();
  let disk: unknown = { version: 2, records: [], consumed: [] }, block = true;
  const storage = new AppStorageService({ appRoot: root, store: {
    load: async () => disk,
    save: async (records, consumed) => {
      const next = structuredClone({ version: 2, records, consumed });
      if (block && records.some(value => value.owner.kind === "setup" && value.demands.some(demand => demand.remainingBytes < MiB))) {
        entered.resolve(); await finish.promise;
      }
      disk = next;
    },
  }, native: { setRoots: () => {}, stop: async () => {}, probe: async rootId => ({ state: "measured", source: "host-provided", limitations: [],
    capacity: { volumeId: "shutdown-volume", mappingRevision: rootId, measuredAt: Date.now(), availableBytes: 20 * GiB, totalBytes: 500 * GiB } }) } });
  const setup = { ...deps(async () => response((async function* () { yield new Uint8Array(16); yield new Uint8Array(16); })(), 32)),
    externallyPresent: async (id: string) => id !== "shutdown-file" };
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth: storage, recoveryControl: null, recoveryHistory: null,
    setup, setupExtraEntries: [{ ...entry("shutdown-file", 1), optional: true }], changeLogPath: join(root, "log.jsonl"), appVersion: "setup-shutdown-test" });
  let client: WebSocket | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const session = await coordinator.start(0); client = new WebSocket(`ws://127.0.0.1:${session.port}`); const frames: unknown[] = [];
    client.on("message", raw => frames.push(JSON.parse(raw.toString()))); await once(client, "open");
    client.send(JSON.stringify({ kind: "hello", token: session.token, lastSeq: 0 }));
    await until(() => frames.some(value => (value as { kind?: string }).kind === "snapshot"), "authenticated shutdown fixture");
    client.send(JSON.stringify({ kind: "setup-install", componentId: "shutdown-file" })); await entered.promise;
    await Promise.race([coordinator.stop(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("storage accounting held host shutdown")), 15000); })]);
    assert.equal(storage.reservations.snapshot().auditAvailable, false);
    const folder = join(root, "models", "shutdown-file"), partials = (await readdir(folder)).filter(name => name.endsWith(".partial"));
    assert.equal(partials.length, 1); assert.equal((await stat(join(folder, partials[0]!))).size, 16);
    assert.equal(await stat(join(folder, "weights.bin")).catch(() => null), null);
    block = false; finish.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await storage.reservations.reserve({ id: "late", owner: { kind: "job", id: "late" }, demands: [{ rootId: "unused", remainingBytes: 1 }] })).status, "held");
    assert.equal((disk as { records: StorageReservation[] }).records[0]!.owner.kind, "setup");
  } finally { if (timeout) clearTimeout(timeout); block = false; finish.resolve(); client?.close(); await coordinator.stop(); await provider.close(); }
});
