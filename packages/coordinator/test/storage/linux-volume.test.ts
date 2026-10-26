import assert from "node:assert/strict";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { describe, it } from "node:test";
import { StorageProbeResultSchema } from "../../src/storage/monitor.js";
import { LinuxVolumeProbe, queryLinuxStorageRoot, type LinuxStorageCalls } from "../../src/storage/linux-volume.js";
import { tempDir } from "../tmp.js";

const root = { rootId: "media", path: "/world/media" }, signal = () => new AbortController().signal;
const boot = "12345678-1234-1234-1234-123456789abc";
const line = (extra: Partial<{ id: number; device: string; point: string; type: string; source: string; options: string; subroot: string }> = {}) => `${extra.id ?? 29} 1 ${extra.device ?? "8:1"} ${extra.subroot ?? "/"} ${extra.point ?? "/"} ${extra.options ?? "rw"} shared:1 - ${extra.type ?? "ext4"} ${extra.source ?? "/dev/private"} rw\n`;
function fixture() {
  let table = line(), canonical = root.path, inode = 11n, device = 2049n, available = 2_000_000n, type = 0xef53n;
  let identityCalls = 0, tableReads = 0, afterIdentity: (() => void) | undefined;
  const io: LinuxStorageCalls = {
    read: async path => { if (path.endsWith("boot_id")) return boot; tableReads++; return table; },
    realpath: async () => canonical,
    identity: async () => { identityCalls++; const value = { device, inode, directory: true }; afterIdentity?.(); return value; },
    capacity: async () => ({ type, bsize: 4096n, blocks: 30_000_000n, bavail: available }),
  };
  return { io, table: (value: string) => { table = value; }, path: (value: string) => { canonical = value; },
    inode: (value: bigint) => { inode = value; }, device: (value: bigint) => { device = value; }, available: (value: bigint) => { available = value; },
    type: (value: bigint) => { type = value; }, afterIdentity: (fn: () => void) => { afterIdentity = fn; }, identities: () => identityCalls, reads: () => tableReads };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe("Linux mounted-volume storage port", () => {
  it("groups real devices across bind aliases while retaining distinct mapping proofs and quota limits", async () => {
    const f = fixture(); f.table(line() + line({ id: 30, point: "/alias", subroot: "/world", source: "/dev/disk/by-uuid/private" }));
    const first = await queryLinuxStorageRoot(root, signal(), f.io, () => 600_000);
    f.path("/alias/media"); const second = await queryLinuxStorageRoot({ ...root, path: "/alias/media" }, signal(), f.io, () => 600_001);
    assert.equal(first.state, "measured"); assert.equal(first.capacity!.volumeId, second.capacity!.volumeId);
    assert.notEqual(first.capacity!.mappingRevision, second.capacity!.mappingRevision);
    assert.equal(first.capacity!.availableBytes, 2_000_000 * 4096); assert.deepEqual(first.limitations, ["quota-unavailable"]);
    assert.equal(first.capacity!.measuredAt, 600_000); StorageProbeResultSchema.parse(first);
    assert(!JSON.stringify(first).includes("world")); assert(!JSON.stringify(first).includes("private")); assert(!JSON.stringify(first).includes(boot));
  });

  it("maps escaped mounted directories and keeps separate devices independent", async () => {
    const f = fixture(); f.table(line() + line({ id: 31, device: "8:2", point: "/my\\040disk" })); f.path("/my disk/media"); f.device(2050n);
    const second = await queryLinuxStorageRoot(root, signal(), f.io);
    f.path(root.path); f.device(2049n); const first = await queryLinuxStorageRoot(root, signal(), f.io);
    assert.equal(second.state, "measured"); assert.notEqual(first.capacity!.volumeId, second.capacity!.volumeId);
    f.inode(99n); const changed = await queryLinuxStorageRoot(root, signal(), f.io);
    assert.equal(first.capacity!.volumeId, changed.capacity!.volumeId); assert.notEqual(first.capacity!.mappingRevision, changed.capacity!.mappingRevision);
  });

  it("refuses remounts, retargets and replaced directories across the native capacity read", async () => {
    for (const mutate of ["mount", "path", "inode"] as const) {
      const f = fixture(); f.afterIdentity(() => { if (f.identities() !== 1) return;
        if (mutate === "mount") f.table(line({ id: 99 })); else if (mutate === "path") f.path("/changed"); else f.inode(99n);
      });
      const result = await queryLinuxStorageRoot(root, signal(), f.io); assert.equal(result.capacity, null, mutate);
    }
  });

  it("does not stat capacity on unqualified network, FUSE, subvolume or read-only mounts", async () => {
    for (const type of ["nfs4", "cifs", "fuse", "overlay", "btrfs", "zfs"]) {
      const f = fixture(); f.table(line({ type })); f.io.capacity = async () => { throw new Error("Must not reach this filesystem."); };
      const result = await queryLinuxStorageRoot(root, signal(), f.io); assert.equal(result.state, "unsupported", type); assert.equal(f.identities(), 0);
    }
    const f = fixture(); f.table(line({ options: "ro" })); assert.deepEqual((await queryLinuxStorageRoot(root, signal(), f.io)).limitations, ["permission-denied"]);
  });

  it("rejects malformed/oversized metadata, mismatched devices and unsafe capacities", async () => {
    for (const table of ["not mountinfo", line({ point: "/bad\\777path" }), "x".repeat(1024 * 1024 + 1)]) {
      const f = fixture(); f.table(table); assert.equal((await queryLinuxStorageRoot(root, signal(), f.io)).capacity, null);
    }
    const f = fixture(); f.device(2050n); assert.equal((await queryLinuxStorageRoot(root, signal(), f.io)).capacity, null);
    f.device(2049n); f.available(-1n); assert.equal((await queryLinuxStorageRoot(root, signal(), f.io)).capacity, null);
    f.available(2n ** 60n); assert.equal((await queryLinuxStorageRoot(root, signal(), f.io)).capacity, null);
    f.available(1n); f.type(1234n); assert.equal((await queryLinuxStorageRoot(root, signal(), f.io)).capacity, null);
    f.io.realpath = async () => { throw Object.assign(new Error("private path"), { code: "EACCES" }); };
    assert.deepEqual((await queryLinuxStorageRoot(root, signal(), f.io)).limitations, ["permission-denied"]);
  });

  it("coalesces native chains, enforces freshness and never probes a supplied unknown path", async () => {
    let count = 0, now = 600_000; const f = fixture();
    const port = new LinuxVolumeProbe({ platform: "linux", now: () => now, query: async (...args) => { count++; return queryLinuxStorageRoot(args[0], args[1], f.io, () => now); } });
    port.setRoots([root]); const [a, b] = await Promise.all([port.probe(root.rootId, signal()), port.probe(root.rootId, signal())]);
    assert.equal(count, 1); assert.deepEqual(a, b);
    assert.equal((await port.probe("/private", signal())).capacity, null); assert.equal(count, 1);
    assert.equal((await port.probe(root.rootId, signal(), now)).capacity, null); assert.equal(count, 1);
    now += 1000; assert.equal((await port.probe(root.rootId, signal())).state, "measured"); assert.equal(count, 2);
    await port.stop(); assert.equal((await port.probe(root.rootId, signal())).capacity, null); assert.equal(count, 2);
  });

  it("abandons a slow native call without overlap, late publication or an unbounded stop", async () => {
    let count = 0; const gate = deferred(), f = fixture();
    const port = new LinuxVolumeProbe({ platform: "linux", observationMs: 20, query: async (input, control) => { count++; await gate.promise; return queryLinuxStorageRoot(input, control, f.io); } });
    port.setRoots([root]);
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      assert.equal((await port.probe(root.rootId, signal())).capacity, null); assert.equal(count, 1);
      port.setRoots([{ rootId: "replacement", path: "/changed" }]);
      assert.equal((await port.probe("replacement", signal())).capacity, null); assert.equal(count, 1);
      await port.stop(); gate.resolve(); await pause(0);
      assert.equal((await port.probe("replacement", signal())).capacity, null); assert.equal(count, 1);
    } finally { gate.resolve(); clearTimeout(keepAlive); await port.stop(); }
  });

  it("caches failed native reads rather than looping and never runs on another platform", async () => {
    let count = 0;
    const port = new LinuxVolumeProbe({ platform: "linux", query: async () => { count++; throw new Error("Private native failure"); } }); port.setRoots([root]);
    assert.equal((await port.probe(root.rootId, signal())).capacity, null); assert.equal(count, 1); await port.stop();
    const other = new LinuxVolumeProbe({ platform: "darwin", query: async () => { count++; throw new Error(); } }); other.setRoots([root]);
    assert.equal((await other.probe(root.rootId, signal())).state, "unsupported"); assert.equal(count, 1); await other.stop();
  });

  it("checks real native mount/device facts and symlink aliases without reading media", { skip: process.platform !== "linux", timeout: 15_000 }, async t => {
    const dir = await tempDir("arke-linux-volume-"), destination = join(dir, "media"), alias = join(dir, "alias");
    await mkdir(destination); await symlink(destination, alias, "dir");
    const a = await queryLinuxStorageRoot({ rootId: "direct", path: destination }, signal());
    const b = await queryLinuxStorageRoot({ rootId: "alias", path: alias }, signal());
    StorageProbeResultSchema.parse(a); StorageProbeResultSchema.parse(b);
    t.diagnostic(JSON.stringify({ nativeState: a.state, source: a.source, limitations: a.limitations, measured: a.capacity !== null }));
    assert.equal(a.state, b.state);
    if (a.state === "unsupported") { assert.equal(a.capacity, null); assert.deepEqual(a.limitations, ["unsupported-filesystem"]); }
    else { assert.equal(a.state, "measured"); assert(a.capacity!.totalBytes! > 0); assert.equal(a.capacity!.volumeId, b.capacity!.volumeId); assert.equal(a.capacity!.mappingRevision, b.capacity!.mappingRevision); }
  });
});
