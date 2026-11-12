import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { mkdir, symlink } from "node:fs/promises";
import { WindowsVolumeProbe, queryWindowsStorageVolumes } from "../../src/storage/windows-volume.js";
import { tempDir } from "../tmp.js";

const canonical = "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\world";
const roots = [{ rootId: "media", path: "C:\\private\\world" }, { rootId: "exports", path: "D:\\alias" }];
const row = (rootId: string, extra: Record<string, unknown> = {}) => ({ rootId, state: "measured", error: 0, canonical, fileId: "root-file-id", availableBytes: 30 * 1024 ** 3, measuredAt: 600_000, ...extra });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe("Windows volume identity port", () => {
  it("keeps unchanged destinations in flight across sibling root registration and release", async () => {
    const entered = deferred(), finish = deferred(); let calls = 0, aborted = false;
    const port = new WindowsVolumeProbe({ platform: "win32", now: () => 600_000, query: async (input, signal) => {
      calls++;
      if (calls === 1) {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        entered.resolve(); await finish.promise;
      }
      return JSON.stringify(input.map(root => row(root.rootId)));
    } });
    port.setRoots([roots[0]!]);
    const first = port.probe("media", new AbortController().signal); await entered.promise;
    port.setRoots(roots);
    const second = port.probe("exports", new AbortController().signal);
    finish.resolve();
    try {
      assert.equal((await first).state, "measured");
      assert.equal((await second).state, "measured");
      assert.equal(aborted, false);
      assert.equal(calls, 2, "the newly registered destination gets its own bounded read");
      port.setRoots([roots[0]!]);
      assert.equal((await port.probe("media", new AbortController().signal)).state, "measured");
      assert.equal(calls, 2, "releasing a sibling does not discard the unchanged destination's cache");
    } finally { await port.stop(); }
  });
  it("rejects an old read when its root was replaced and registered again", async () => {
    const entered = deferred(), finish = deferred(); let calls = 0;
    const port = new WindowsVolumeProbe({ platform: "win32", now: () => 600_000, query: async () => {
      if (++calls === 1) { entered.resolve(); await finish.promise; }
      return JSON.stringify([row("media")]);
    } });
    port.setRoots([roots[0]!]);
    const old = port.probe("media", new AbortController().signal); await entered.promise;
    port.setRoots([{ rootId: "media", path: "D:\\replacement" }]);
    port.setRoots([roots[0]!]); finish.resolve();
    try {
      assert.equal((await old).capacity, null);
      assert.equal((await port.probe("media", new AbortController().signal)).state, "measured");
      assert.equal(calls, 2, "an identical path after replacement still needs a new measurement");
    } finally { await port.stop(); }
  });

  it("drains a cancelled real reader and its pending leash helper", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
    const dir = await tempDir("arke-volume-cancel-"), control = new AbortController();
    const timer = setTimeout(() => control.abort(), 20);
    try { await assert.rejects(queryWindowsStorageVolumes([{ rootId: "cancelled", path: dir }], control.signal)); }
    finally { clearTimeout(timer); }
    const next = JSON.parse(await queryWindowsStorageVolumes([{ rootId: "replacement", path: dir }], new AbortController().signal));
    assert.equal(next[0]!.state, "measured");
  });

  it("coalesces registered roots and exports opaque volume/root identities with explicit limits", async () => {
    let calls = 0, now = 600_000;
    const port = new WindowsVolumeProbe({ platform: "win32", now: () => now, query: async input => {
      calls++; assert.deepEqual(input, roots); return JSON.stringify(input.map(root => row(root.rootId)));
    } });
    port.setRoots(roots);
    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([port.probe("media", signal), port.probe("exports", signal)]);
    assert.equal(calls, 1); assert.equal(a.state, "measured"); assert.equal(a.capacity!.volumeId, b.capacity!.volumeId);
    assert.equal(a.capacity!.mappingRevision, b.capacity!.mappingRevision);
    assert.equal(a.capacity!.totalBytes, null); assert.deepEqual(a.limitations, ["total-unavailable"]);
    assert(!JSON.stringify(a).includes("world")); assert(!JSON.stringify(a).includes("12345678"));
    await port.probe("media", signal); assert.equal(calls, 1);
    now += 1_000; await port.probe("media", signal); assert.equal(calls, 2);
    await port.stop();
  });

  it("changes a root mapping when identity changes on the same volume", async () => {
    let now = 600_000, fileId = "root-first";
    const port = new WindowsVolumeProbe({ platform: "win32", now: () => now, query: async () => JSON.stringify([row("media", { fileId })]) });
    port.setRoots([roots[0]!]); const signal = new AbortController().signal;
    const first = await port.probe("media", signal); now += 1_000; fileId = "root-replaced";
    const second = await port.probe("media", signal);
    assert.equal(first.capacity!.volumeId, second.capacity!.volumeId); assert.notEqual(first.capacity!.mappingRevision, second.capacity!.mappingRevision);
    await port.stop();
  });

  it("keeps malformed, duplicate, foreign, denied and failed reads unavailable", async () => {
    for (const text of ["{", JSON.stringify([row("media"), row("media")]), JSON.stringify([row("foreign")]), JSON.stringify([row("media"), row("foreign")]), JSON.stringify([row("media", { availableBytes: -1 })]), JSON.stringify([row("media", { canonical: "C:\\private" })])]) {
      const port = new WindowsVolumeProbe({ platform: "win32", query: async () => text }); port.setRoots([roots[0]!]);
      assert.equal((await port.probe("media", new AbortController().signal)).capacity, null); await port.stop();
    }
    const port = new WindowsVolumeProbe({ platform: "win32", query: async () => JSON.stringify([{ rootId: "media", state: "unavailable", error: 5 }]) });
    port.setRoots([roots[0]!]); assert.deepEqual((await port.probe("media", new AbortController().signal)).limitations, ["permission-denied"]); await port.stop();
  });

  it("never invokes the native query for unregistered or unsupported roots", async () => {
    let calls = 0; const signal = new AbortController().signal;
    const port = new WindowsVolumeProbe({ platform: "win32", query: async () => { calls++; return "[]"; } }); port.setRoots([roots[0]!]);
    assert.equal((await port.probe("C:\\private\\other", signal)).state, "unavailable"); assert.equal(calls, 0); await port.stop();
    const unsupported = new WindowsVolumeProbe({ platform: "linux", query: async () => { calls++; return "[]"; } }); unsupported.setRoots([roots[0]!]);
    assert.equal((await unsupported.probe("media", signal)).state, "unsupported"); assert.equal(calls, 0); await unsupported.stop();
  });

  it("cancels and drains native reads without publishing an old registration", async () => {
    const entered = deferred(), finish = deferred(); let aborted = false;
    const port = new WindowsVolumeProbe({ platform: "win32", query: async (_roots, signal) => {
      entered.resolve(); signal.addEventListener("abort", () => { aborted = true; }, { once: true }); await finish.promise; return JSON.stringify([row("media")]);
    } });
    port.setRoots([roots[0]!]); const pending = port.probe("media", new AbortController().signal); await entered.promise;
    port.setRoots([]); const stopping = port.stop(); assert(aborted); finish.resolve(); await stopping;
    assert.equal((await pending).capacity, null);
  });

  it("does not let abandoned observation work seed a replacement batch's cache", async () => {
    const entered = deferred(), finish = deferred(); let calls = 0, aborted = false;
    const port = new WindowsVolumeProbe({ platform: "win32", now: () => 600_000, query: async (_roots, signal) => {
      calls++;
      if (calls === 1) { entered.resolve(); signal.addEventListener("abort", () => { aborted = true; }, { once: true }); await finish.promise; return JSON.stringify([row("media")]); }
      return JSON.stringify([row("media", { availableBytes: 5 * 1024 ** 3 })]);
    } }); port.setRoots([roots[0]!]);
    const control = new AbortController(), old = port.probe("media", control.signal); await entered.promise;
    control.abort(); assert(aborted); assert.equal((await old).capacity, null);
    assert.equal((await port.probe("media", new AbortController().signal)).capacity!.availableBytes, 5 * 1024 ** 3);
    finish.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await port.probe("media", new AbortController().signal)).capacity!.availableBytes, 5 * 1024 ** 3);
    assert.equal(calls, 2); await port.stop();
  });

  it("continues a coalesced read for callers that remain active", async () => {
    const entered = deferred(), finish = deferred(); let calls = 0, aborted = false;
    const port = new WindowsVolumeProbe({ platform: "win32", now: () => 600_000, query: async (_roots, signal) => {
      calls++; signal.addEventListener("abort", () => { aborted = true; }, { once: true }); entered.resolve(); await finish.promise;
      return JSON.stringify([row("media")]);
    } }); port.setRoots([roots[0]!]);
    const control = new AbortController();
    const cancelled = port.probe("media", control.signal), active = port.probe("media", new AbortController().signal);
    await entered.promise; control.abort(); assert.equal(aborted, false); assert.equal((await cancelled).capacity, null);
    finish.resolve(); assert.equal((await active).state, "measured");
    assert.equal((await port.probe("media", new AbortController().signal)).state, "measured");
    assert.equal(calls, 1); await port.stop();
  });

  it("bypasses a completed cache whose measurement predates a failure or wake fence", async () => {
    let now = 600_000, calls = 0;
    const port = new WindowsVolumeProbe({ platform: "win32", now: () => now, query: async () => { calls++; return JSON.stringify([row("media", { measuredAt: now })]); } });
    port.setRoots([roots[0]!]); await port.probe("media", new AbortController().signal);
    now += 100;
    const next = await port.probe("media", new AbortController().signal, 600_050);
    assert.equal(next.capacity!.measuredAt, now); assert.equal(calls, 2); await port.stop();
  });

  it("measures real Windows junction aliases without creating a compiler or temporary assembly", { skip: process.platform !== "win32" }, async () => {
    const dir = await tempDir("arke-volume-native-"), target = join(dir, "target"), alias = join(dir, "alias");
    await mkdir(target); await symlink(target, alias, "junction");
    const port = new WindowsVolumeProbe(); port.setRoots([{ rootId: "target", path: target }, { rootId: "alias", path: alias }]);
    try {
      const [a, b] = await Promise.all([port.probe("target", new AbortController().signal), port.probe("alias", new AbortController().signal)]);
      assert.equal(a.state, "measured"); assert.equal(b.state, "measured");
      assert.equal(a.capacity!.volumeId, b.capacity!.volumeId); assert.equal(a.capacity!.mappingRevision, b.capacity!.mappingRevision);
      assert(a.capacity!.availableBytes! > 0);
    } finally { await port.stop(); }
  });
});
