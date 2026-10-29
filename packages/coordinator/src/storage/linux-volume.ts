import { createHash } from "node:crypto";
import { open, realpath, stat, statfs } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import type { StorageProbeResult } from "./monitor.js";

const rootSchema = z.object({ rootId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), path: z.string().min(1).max(4096).refine(posix.isAbsolute) }).strict();
type Root = z.infer<typeof rootSchema>;
interface Mount { id: string; device: string; root: string; point: string; options: string; type: string; source: string; superOptions: string }
export interface LinuxStorageCalls {
  read(path: string, maximum: number, signal: AbortSignal): Promise<string>;
  realpath(path: string): Promise<string>;
  identity(path: string): Promise<{ device: bigint; inode: bigint; directory: boolean }>;
  capacity(path: string): Promise<{ type: bigint; bsize: bigint; blocks: bigint; bavail: bigint }>;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const unknown = (limitation: "cancelled" | "probe-failed" | "permission-denied" | "unsupported-filesystem" = "probe-failed"): StorageProbeResult => ({
  state: limitation === "unsupported-filesystem" ? "unsupported" : "unavailable", source: "linux-mountinfo", capacity: null, limitations: [limitation],
});
const calls: LinuxStorageCalls = {
  async read(path, maximum, signal) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maximum + 1); let offset = 0;
      while (offset < buffer.length) {
        signal.throwIfAborted(); const next = await handle.read(buffer, offset, Math.min(64 * 1024, buffer.length - offset), null);
        if (!next.bytesRead) break; offset += next.bytesRead;
      }
      if (offset > maximum) throw new Error("Storage metadata exceeds its bound.");
      return buffer.toString("utf8", 0, offset);
    } finally { await handle.close(); }
  },
  realpath,
  async identity(path) { const value = await stat(path, { bigint: true }); return { device: value.dev, inode: value.ino, directory: value.isDirectory() }; },
  capacity: path => statfs(path, { bigint: true }),
};
function unescapeMount(value: string): string {
  if (/\\(?!040|011|012|134)/.test(value)) throw new Error("Invalid mount metadata.");
  return value.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}
function mounts(text: string): Mount[] {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Mount metadata exceeds its bound.");
  const lines = text.trim().split("\n");
  if (lines.length > 8192) throw new Error("Too many mounted filesystems.");
  return lines.map(line => {
    const parts = line.split(" "), separator = parts.indexOf("-");
    if (separator < 6 || parts.length !== separator + 4 || !/^\d+$/.test(parts[0]!) || !/^\d+:\d+$/.test(parts[2]!)) throw new Error("Invalid mount metadata.");
    const root = unescapeMount(parts[3]!), point = unescapeMount(parts[4]!);
    if (!posix.isAbsolute(root) || !posix.isAbsolute(point)) throw new Error("Invalid mount identity.");
    return { id: parts[0]!, device: parts[2]!, root, point, options: parts[5]!, type: parts[separator + 1]!, source: unescapeMount(parts[separator + 2]!), superOptions: parts[separator + 3]! };
  });
}
function deviceKey(device: bigint): string {
  // Linux's gnu_dev_major/minor layout; do not confuse two bind mounts with two disks.
  return `${(device >> 8n & 0xfffn) | (device >> 32n & 0xfffff000n)}:${(device & 0xffn) | (device >> 12n & 0xffffff00n)}`;
}
const same = (a: { device: bigint; inode: bigint }, b: { device: bigint; inode: bigint }) => a.device === b.device && a.inode === b.inode;
const localTypes = new Map<string, bigint>([["ext2", 0xef53n], ["ext3", 0xef53n], ["ext4", 0xef53n], ["xfs", 0x58465342n], ["tmpfs", 0x01021994n]]);

/** Mount metadata and Node's native statfs, never df output or path-prefix volume guesses.
 * Unqualified network/FUSE/overlay and multi-device/subvolume filesystems remain unsupported. */
export async function queryLinuxStorageRoot(root: Root, signal: AbortSignal, io: LinuxStorageCalls = calls, now = Date.now): Promise<StorageProbeResult> {
  try {
    signal.throwIfAborted();
    const boot = (await io.read("/proc/sys/kernel/random/boot_id", 128, signal)).trim();
    if (!/^[a-f0-9-]{36}$/.test(boot)) return unknown();
    signal.throwIfAborted(); const table = await io.read("/proc/self/mountinfo", 1024 * 1024, signal); signal.throwIfAborted();
    const path = await io.realpath(root.path); signal.throwIfAborted();
    const mount = mounts(table).filter(row => path === row.point || path.startsWith(row.point === "/" ? "/" : row.point + "/")).sort((a, b) => b.point.length - a.point.length || Number(b.id) - Number(a.id))[0];
    if (!mount || !localTypes.has(mount.type)) return unknown("unsupported-filesystem");
    if (mount.options.split(",").includes("ro") || mount.superOptions.split(",").includes("ro")) return unknown("permission-denied");
    const before = await io.identity(path); signal.throwIfAborted();
    if (!before.directory || deviceKey(before.device) !== mount.device) return unknown();
    const measuredAt = now(), capacity = await io.capacity(path); signal.throwIfAborted();
    const again = await io.realpath(root.path); signal.throwIfAborted(); const after = await io.identity(again); signal.throwIfAborted();
    if (path !== again || !after.directory || !same(before, after) || table !== await io.read("/proc/self/mountinfo", 1024 * 1024, signal)) return unknown();
    signal.throwIfAborted();
    const available = capacity.bsize * capacity.bavail, total = capacity.bsize * capacity.blocks;
    if (capacity.type !== localTypes.get(mount.type) || capacity.bsize <= 0n || available < 0n || total < available || total > BigInt(Number.MAX_SAFE_INTEGER)) return unknown();
    // statfs.bavail excludes privileged reserved blocks; it does not prove user/project quota.
    return { state: "measured", source: "linux-mountinfo", limitations: ["quota-unavailable"], capacity: {
      volumeId: hash(`${boot}\0${mount.device}\0${mount.type}`),
      mappingRevision: hash(`${path}\0${before.device}\0${before.inode}\0${JSON.stringify(mount)}`),
      availableBytes: Number(available), totalBytes: Number(total), measuredAt,
    } };
  } catch (error) {
    if (signal.aborted) return unknown("cancelled");
    return unknown(error && typeof error === "object" && "code" in error && (error.code === "EACCES" || error.code === "EPERM") ? "permission-denied" : "probe-failed");
  }
}

/** One outstanding native metadata chain, even after abandonment. Native filesystem calls
 * cannot be cancelled mid-syscall: late results are discarded and no replacement overlaps.
 * Shutdown abandons the read; these Node calls cannot leave an external child behind. */
export class LinuxVolumeProbe {
  private roots: Root[] = [];
  private version = 0;
  private readonly lifetime = new AbortController();
  private readonly cache = new Map<string, { at: number; result: StorageProbeResult }>();
  private native: { work: Promise<void>; control: AbortController } | null = null;
  constructor(private readonly deps: { platform?: string; now?: () => number; observationMs?: number; query?: typeof queryLinuxStorageRoot } = {}) {}
  setRoots(input: readonly Root[]): void {
    const roots = z.array(rootSchema).max(128).parse(input);
    if (new Set(roots.map(root => root.rootId)).size !== roots.length) throw new Error("Repeated storage root.");
    if (this.lifetime.signal.aborted || JSON.stringify(roots) === JSON.stringify(this.roots)) return;
    this.roots = roots; this.version++; this.cache.clear(); this.native?.control.abort();
  }
  async probe(rootId: string, signal: AbortSignal, after = -Infinity): Promise<StorageProbeResult> {
    if ((this.deps.platform ?? process.platform) !== "linux") return unknown("unsupported-filesystem");
    const root = this.roots.find(value => value.rootId === rootId);
    if (!root) return unknown();
    const bounded = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.deps.observationMs ?? 4_000)]);
    while (!bounded.aborted) {
      const now = (this.deps.now ?? Date.now)(), cached = this.cache.get(rootId);
      if (cached && now >= cached.at && now - cached.at < 1_000) return structuredClone(cached.result.capacity && cached.result.capacity.measuredAt <= after ? unknown() : cached.result);
      if (!this.native) {
        const version = this.version, control = new AbortController();
        const entry = { work: null! as Promise<void>, control }; this.native = entry;
        entry.work = Promise.resolve().then(() => (this.deps.query ?? queryLinuxStorageRoot)(root, control.signal, undefined, this.deps.now ?? Date.now)).then(result => {
          if (!control.signal.aborted && !this.lifetime.signal.aborted && this.version === version) this.cache.set(rootId, { at: (this.deps.now ?? Date.now)(), result });
        }).catch(() => {
          if (!control.signal.aborted && !this.lifetime.signal.aborted && this.version === version) this.cache.set(rootId, { at: (this.deps.now ?? Date.now)(), result: unknown() });
        }).finally(() => { if (this.native === entry) this.native = null; });
      }
      const entry = this.native;
      await new Promise<void>(resolve => {
        const done = () => { bounded.removeEventListener("abort", done); resolve(); };
        bounded.addEventListener("abort", done, { once: true }); void entry.work.then(done);
        if (bounded.aborted) done();
      });
      if (bounded.aborted) { entry.control.abort(); return unknown("cancelled"); }
      if (!this.roots.some(value => value.rootId === rootId && value.path === root.path)) return unknown();
    }
    return unknown("cancelled");
  }
  async stop(): Promise<void> { this.lifetime.abort(); this.native?.control.abort(); this.cache.clear(); }
}
