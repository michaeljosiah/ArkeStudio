import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalSetupService, systemTar, type SetupDeps } from "../../src/setup/local-setup.js";
import { nodeSetupDeps } from "../../src/setup/node-deps.js";
import { SetupProcessRunner, SetupProcessCleanupPending } from "../../src/setup/process.js";
import type { CatalogueEntry } from "../../src/setup/catalogue.js";
import { AppStorageService } from "../../src/storage/service.js";
import { SetupArchiveStorage } from "../../src/storage/setup-archive.js";
import { SetupFileStorage } from "../../src/storage/setup-files.js";
import { tempDir } from "../tmp.js";

const MiB = 1024 ** 2, GiB = 1024 ** 3;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function storageFixture(root: string) {
  const started = Date.now(); let base = started, available = GiB + 10 * MiB;
  const now = () => base + Date.now() - started;
  const storage = new AppStorageService({ appRoot: root, now, native: { setRoots: () => {}, stop: async () => {},
    probe: async (rootId, _signal, after) => { base = Math.max(base + 1, (after ?? 0) + 1 - (Date.now() - started));
      return { state: "measured", source: "host-provided", limitations: [], capacity: {
        volumeId: "same-volume", mappingRevision: rootId, measuredAt: now(), availableBytes: available, totalBytes: 200 * GiB,
      } }; },
  } });
  return { storage, space: new SetupArchiveStorage(storage), capacity: (bytes: number) => { available = bytes; base += 1001; } };
}
async function payload(root: string, kind: "tree" | "archive" = "tree") {
  const source = join(root, "source"); await mkdir(source); await writeFile(join(source, "runtime.exe"), "verified runtime fixture");
  const archive = join(root, "source.tar.gz"), runner = new SetupProcessRunner();
  try { assert.equal((await runner.run(systemTar(), ["-czf", archive, "-C", source, "."], new AbortController().signal)).code, 0); }
  finally { await runner.dispose(); }
  const bytes = await readFile(archive), file = { url: "https://example.test/runtime.tar.gz", file: "runtime.tar.gz", sizeMb: 1,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  const entry: CatalogueEntry = { id: "test-runtime", displayName: "Test runtime", purpose: "Native phase fixture", sizeMb: 1, installedMb: 3,
    spec: kind === "tree" ? { kind, dir: "runtime", rootMarker: "runtime.exe", file } : { kind, dir: "runtime", executable: "runtime.exe", byArch: { x64: file, arm64: file } } };
  return { bytes, entry };
}
const response = (bytes: Uint8Array) => ({ ok: true, status: 200, contentLength: bytes.byteLength, acceptRanges: false, contentRangeStart: null,
  body: (async function* () { yield bytes; })() });

for (const kind of ["tree", "archive"] as const) it(`the real ${kind} owner reserves its archive and expansion, then activates only after native exit and settlement`, { timeout: 90000 }, async () => {
  const root = await tempDir("arke-archive-install-"), input = await payload(root, kind), h = storageFixture(root);
  let requests = 0, activated = false, lease = false;
  const deps: SetupDeps = { ...nodeSetupDeps(), fetchStream: async () => { requests++; assert(lease); assert.equal(h.storage.reservations.snapshot().records.length, 1); return response(input.bytes); }, diskFreeMb: async () => 1000000 };
  const service = new LocalSetupService(deps, () => {}, { appRoot: root, catalogue: [input.entry], archiveSpace: h.space, headroomMb: 1,
    beginComponentInstall: async () => { lease = true; return () => { lease = false; }; },
    onComponentReady: async () => { assert(!lease); assert.equal(h.storage.reservations.snapshot().records.length, 0); activated = true; },
  });
  try {
    await service.run(); assert.equal(service.status().components[0]!.state, "ready", service.status().components[0]!.detail); assert(activated); assert.equal(requests, 1);
    assert.equal(await readFile(join(root, "runtime", "runtime.exe"), "utf8"), "verified runtime fixture");
    assert.deepEqual(await readdir(join(root, ".setup-downloads")), []);
    assert(!(await readdir(join(root, "runtime"))).some(name => name.endsWith(".partial")));
  } finally { await service.dispose(); await h.storage.stop(); }
});

it("another file installer cannot spend the archive owner's retained expansion reservation", { timeout: 90000 }, async () => {
  const root = await tempDir("arke-archive-concurrent-"), input = await payload(root), h = storageFixture(root), entered = deferred(), finish = deferred(); let secondRequests = 0;
  const service = new LocalSetupService({ ...nodeSetupDeps(), fetchStream: async () => { entered.resolve(); await finish.promise; return response(input.bytes); }, diskFreeMb: async () => 1000000 }, () => {},
    { appRoot: root, catalogue: [input.entry], archiveSpace: h.space, headroomMb: 1 });
  const file: CatalogueEntry = { id: "weights", displayName: "Weights", purpose: "Competing owner", sizeMb: 8,
    spec: { kind: "files", dir: "weights", files: [{ url: "https://example.test/weights", file: "weights.bin", sizeMb: 8 }] } };
  const second = new LocalSetupService({ ...nodeSetupDeps(), fetchStream: async () => { secondRequests++; return response(new Uint8Array(16)); }, diskFreeMb: async () => 1000000 }, () => {},
    { appRoot: root, catalogue: [file], fileSpace: new SetupFileStorage(h.storage), headroomMb: 1 });
  const running = service.run();
  try { await entered.promise; await second.run(); assert.equal(secondRequests, 0); assert.equal(second.status().components[0]!.state, "blocked");
    finish.resolve(); await running; assert.equal(service.status().components[0]!.state, "ready");
  } finally { finish.resolve(); await running; await service.dispose(); await second.dispose(); await h.storage.stop(); }
});

it("a larger verified expansion holds before native writes, preserving one complete checkpoint for explicit Resume without HTTP", { timeout: 90000 }, async () => {
  const root = await tempDir("arke-archive-growth-"), input = await payload(root), h = storageFixture(root), base = nodeSetupDeps();
  let requests = 0, extracts = 0;
  const service = new LocalSetupService({ ...base, archiveBytes: async () => 20 * MiB, fetchStream: async () => { requests++; return response(input.bytes); },
    run: async (...args) => { extracts++; return base.run(...args); }, diskFreeMb: async () => 1000000 }, () => {},
    { appRoot: root, catalogue: [input.entry], archiveSpace: h.space, headroomMb: 1 });
  try {
    await service.run(); assert.equal(service.status().components[0]!.state, "blocked"); assert.equal(extracts, 0); assert.equal(requests, 1);
    const receipts = await readdir(join(root, ".setup-downloads")); assert.equal(receipts.length, 1);
    const receipt = JSON.parse(await readFile(join(root, ".setup-downloads", receipts[0]!), "utf8"));
    assert(receipt.downloadComplete); assert.equal((await stat(receipt.partialPath)).size, input.bytes.length);
    h.capacity(GiB + 30 * MiB); await service.detect(); assert.equal(service.status().components[0]!.state, "paused");
    assert(service.resume(input.entry.id)); await service.run();
    assert.equal(service.status().components[0]!.state, "ready", service.status().components[0]!.detail); assert.equal(requests, 1); assert.equal(extracts, 1);
  } finally { await service.dispose(); await h.storage.stop(); }
});

it("unconfirmed extraction retains its disk and install leases and verified archive until owner cleanup confirms exit", { timeout: 90000 }, async () => {
  const root = await tempDir("arke-archive-unknown-"), input = await payload(root), h = storageFixture(root); let allow = false, released = 0;
  const service = new LocalSetupService({ ...nodeSetupDeps(), archiveBytes: async () => 1024,
    run: async () => { throw new SetupProcessCleanupPending(); }, confirmProcessCleanup: async () => { if (!allow) throw new SetupProcessCleanupPending(); },
    fetchStream: async () => response(input.bytes), diskFreeMb: async () => 1000000 }, () => {},
    { appRoot: root, catalogue: [input.entry], archiveSpace: h.space, headroomMb: 1, beginComponentInstall: async () => () => { released++; } });
  try {
    await service.run(); assert.equal(service.status().components[0]!.state, "failed"); assert.equal(released, 0); assert.equal(h.storage.reservations.snapshot().records.length, 1);
    const names = await readdir(join(root, ".setup-downloads")); const receipt = JSON.parse(await readFile(join(root, ".setup-downloads", names[0]!), "utf8"));
    await assert.rejects(service.cancel(), SetupProcessCleanupPending); assert.equal((await stat(receipt.partialPath)).size, input.bytes.length);
    allow = true; await service.dispose(); assert.equal(released, 1); assert.equal(h.storage.reservations.snapshot().records.length, 0);
    assert.equal((await stat(receipt.partialPath)).size, input.bytes.length, "shutdown does not discard a verified retained archive");
  } finally { allow = true; await service.dispose(); await h.storage.stop(); }
});

it("unknown expansion metadata holds a verified checkpoint without extracting it or exposing native failure text", { timeout: 90000 }, async () => {
  const root = await tempDir("arke-archive-unavailable-"), input = await payload(root), h = storageFixture(root); let extracts = 0;
  const service = new LocalSetupService({ ...nodeSetupDeps(), archiveBytes: async () => { throw new Error("private-native-path-and-secret-canary"); },
    run: async () => { extracts++; return { code: 0, output: "" }; }, fetchStream: async () => response(input.bytes), diskFreeMb: async () => 1000000 }, () => {},
    { appRoot: root, catalogue: [input.entry], archiveSpace: h.space, headroomMb: 1 });
  try {
    await service.run(); const component = service.status().components[0]!;
    assert.equal(component.state, "blocked"); assert.match(component.detail!, /expansion size is unavailable/); assert(!component.detail!.includes("canary")); assert.equal(extracts, 0);
    const names = await readdir(join(root, ".setup-downloads")); assert.equal(names.length, 1);
    const receipt = JSON.parse(await readFile(join(root, ".setup-downloads", names[0]!), "utf8"));
    assert(receipt.downloadComplete); assert.equal((await stat(receipt.partialPath)).size, input.bytes.length);
    assert.equal(h.storage.reservations.snapshot().records.length, 0, "the known-unstarted extraction owner can settle its completed read/HTTP phase");
  } finally { await service.dispose(); await h.storage.stop(); }
});
