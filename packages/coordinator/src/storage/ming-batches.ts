import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldWork, setTimeout as pause } from "node:timers/promises";
import type { AppStorageService } from "./service.js";
import { ImportStorageHeld } from "./import-files.js";
import { mingOwnerSettled } from "../local-ai/ming-owner.js";

const PREFIX = "ming_batch_", MiB = 1024 ** 2;
// This is an additional-growth estimate, not existing cache size or OS allocation. The
// private native cache is monitored; exceeding the estimate cancels only its original batch.
export const MING_CACHE_GROWTH_BYTES = 2 * 1024 ** 3;
export const MING_BATCH_AUDIO_BYTES = 64 * MiB;
const active = new Set<string>();
export interface MingBatchSpaceLease {
  consumed(bytes: number): Promise<void>;
  start(signal: AbortSignal): Promise<AbortSignal>;
  stop(): Promise<void>;
  writeFailed(): void;
  uncertain(): Promise<void>;
  settle(): Promise<void>;
}
export interface MingBatchSpace {
  reserve(staging: string, cache: string, bytes: number, signal: AbortSignal): Promise<MingBatchSpaceLease>;
}

/** Metadata only, only the private runtime cache. No media content, world scan or deletion.
 * A slow syscall can outlive observation; its original chain remains held until it closes. */
export async function mingCacheBytes(root: string, signal: AbortSignal): Promise<number> {
  const pending = [root]; let bytes = 0, entries = 0, slice = 0, since = performance.now();
  while (pending.length) {
    signal.throwIfAborted(); const directory = pending.pop()!;
    const info = await lstat(directory).catch(error => {
      if (directory !== root && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }); signal.throwIfAborted();
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Ming cache measurement is unavailable.");
    const dir = await opendir(directory).catch(error => {
      if (directory !== root && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!dir) continue;
    for await (const entry of dir) {
      signal.throwIfAborted();
      if (++entries > 50_000) throw new Error("Ming cache measurement exceeds its supported scope.");
      const path = join(directory, entry.name), item = await lstat(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }); signal.throwIfAborted();
      if (!item) continue;
      if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) throw new Error("Ming cache measurement is unavailable.");
      if (item.isDirectory()) pending.push(path); else bytes += item.size;
      if (!Number.isSafeInteger(bytes)) throw new Error("Ming cache measurement is unavailable.");
      if (++slice >= 1000 || performance.now() - since >= 50) { await yieldWork(); slice = 0; since = performance.now(); }
    }
  }
  return bytes;
}

/** Shared admission for known batch payloads and monitored compiler-cache growth. A new
 * process never treats an empty in-memory worker list as proof of the old native owner's exit. */
export class MingBatchStorage implements MingBatchSpace {
  constructor(private readonly storage: AppStorageService, private readonly ownerId: string, private readonly ports: {
    ownerSettled?: typeof mingOwnerSettled; cacheBytes?: typeof mingCacheBytes; cacheGrowthBytes?: number; intervalMs?: number;
  } = {}) {}
  async reconcile(signal: AbortSignal): Promise<void> {
    await this.storage.start(); signal.throwIfAborted();
    const outcomes = new Map<string, boolean>();
    for (const record of this.storage.reservations.snapshot().records) {
      if (record.owner.kind !== "scratch" || !/^ming_batch_[a-f0-9-]{36}$/.test(record.id) || active.has(record.id)) continue;
      signal.throwIfAborted();
      if (!outcomes.has(record.owner.id)) {
        if (outcomes.size >= 16) break;
        outcomes.set(record.owner.id, await (this.ports.ownerSettled ?? mingOwnerSettled)(record.owner.id, signal));
      }
      if (outcomes.get(record.owner.id)) await this.storage.reservations.settle(record.id, record.owner);
    }
  }
  async reserve(staging: string, cache: string, bytes: number, signal: AbortSignal): Promise<MingBatchSpaceLease> {
    signal.throwIfAborted();
    const cacheBudget = this.ports.cacheGrowthBytes ?? MING_CACHE_GROWTH_BYTES;
    if (![bytes, cacheBudget].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid Ming storage plan.");
    const id = PREFIX + randomUUID(), owner = {kind: "scratch" as const, id: this.ownerId};
    active.add(id);
    const roots: Array<ReturnType<AppStorageService["acquireRoot"]>> = [];
    let stopWriting: (() => void) | undefined, remaining = bytes, settled = false, started = false;
    const stop = new AbortController(), failed = new AbortController();
    let monitor: Promise<void> | undefined, scan: Promise<number> | undefined;
    const release = () => { active.delete(id); stopWriting?.(); for (const root of roots) root.release(); };
    const demands = () => [{rootId: roots[0]!.rootId, remainingBytes: remaining},
      {rootId: roots[1]!.rootId, remainingBytes: cacheBudget + 32 * MiB + 65536}];
    const measure = async (caller: AbortSignal) => {
      const combined = AbortSignal.any([caller, stop.signal, AbortSignal.timeout(15_000)]);
      scan = (this.ports.cacheBytes ?? mingCacheBytes)(cache, combined);
      let abort!: () => void;
      try { return await Promise.race([scan, new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Ming temporary-file measurement is unavailable."));
        combined.addEventListener("abort", abort, {once: true}); if (combined.aborted) abort();
      })]); } finally { combined.removeEventListener("abort", abort); }
    };
    const endMonitor = async () => { stop.abort(); await monitor; await scan?.catch(() => {}); };
    try {
      await this.reconcile(signal);
      await mkdir(staging, {recursive: true}); await mkdir(cache, {recursive: true}); signal.throwIfAborted();
      roots.push(this.storage.acquireRoot(staging, "working-files"), this.storage.acquireRoot(cache, "local-ai"));
      const result = await this.storage.reservations.reserve({id, owner, demands: demands()}, signal);
      if (result.status !== "reserved") throw new ImportStorageHeld(result, "Ming narration");
      signal.throwIfAborted(); stopWriting = this.storage.beginWrite();
      return {
        consumed: async count => {
          if (settled || !Number.isSafeInteger(count) || count < 0 || count > remaining) throw new Error("Ming writes exceed their admitted plan.");
          remaining -= count;
          if (!await this.storage.reservations.reduce(id, owner, {[roots[0]!.rootId]: remaining})) throw new ImportStorageHeld(undefined, "Ming narration");
        },
        start: async caller => {
          if (settled || started) throw new Error("Ming storage ownership changed before launch."); started = true;
          const combined = AbortSignal.any([signal, caller, stop.signal]); combined.throwIfAborted();
          const baseline = await measure(combined);
          const checked = await this.storage.reservations.replan({id, owner, demands: demands()}, combined);
          if (checked.status !== "reserved") throw new ImportStorageHeld(checked, "Ming narration");
          combined.throwIfAborted();
          monitor = (async () => {
            try {
              while (!combined.aborted) {
                await pause(this.ports.intervalMs ?? 2000, undefined, {signal: combined});
                if (await measure(combined) - baseline > cacheBudget) throw new Error("Ming's temporary files exceeded its planned growth. Try a shorter passage.");
              }
            } catch (error) {
              if (!combined.aborted) { for (const root of roots) this.storage.writeFailed(root.rootId); failed.abort(error); }
            }
          })();
          return failed.signal;
        },
        stop: endMonitor,
        writeFailed: () => { for (const root of roots) this.storage.writeFailed(root.rootId); },
        uncertain: async () => { await this.storage.reservations.retainUncertain(id, owner); },
        settle: async () => {
          if (settled) return; await endMonitor();
          if (!await this.storage.reservations.settle(id, owner)) throw new ImportStorageHeld(undefined, "Ming narration");
          settled = true; release();
        },
      };
    } catch (error) {
      await endMonitor();
      try { await this.storage.reservations.settle(id, owner); } finally { release(); }
      throw error;
    }
  }
}
