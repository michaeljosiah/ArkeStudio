import type { Stats } from "node:fs";
import { lstat, readdir, unlink, utimes } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { containedWorldFilePath } from "../world/contained-file.js";

/**
 * A folder of derived media in the world's `.cache` (#2824): files named by what they were made
 * from, so asking again finds them, held to a byte and file budget by evicting the least recently
 * used. The media route serves `.cache`, and a file deleted under a player breaks its next range
 * request, so what is playing is pinned, and what was just made or used has a grace period in
 * which nothing evicts it.
 *
 * A file and its receipt — `<name>.wav` and `<name>.json` — are one entry: pinned, aged and
 * evicted together, so a receipt is never left describing a file that has gone, or a file left
 * without the receipt that lets it be found again.
 *
 * Taken from the audio studio's mix cache, which first had to keep playback safe from eviction.
 */
export interface DerivedCacheBudget {
  bytes: number;
  files: number;
  graceMs: number;
}

export type DerivedCacheProblem = "too-large" | "unsafe" | "changed" | "full";

interface Entry {
  id: string;
  files: Array<{ file: string; info: Stats }>;
  size: number;
  mtimeMs: number;
}

export class DerivedCache {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly reserved = new Map<string, Set<{ bytes: number; files: number }>>();
  private readonly pins = new Map<string, number>();
  private readonly lifetimes = new WeakMap<AbortSignal, Set<string>>();
  private readonly making = new Map<string, Promise<unknown>>();

  constructor(
    /** World-relative, under `.cache/`. */
    readonly folder: string,
    private readonly options: {
      /** The names this cache made. Anything else in the folder, a render's scratch file included, is never counted or evicted. */
      owns: RegExp;
      budget: DerivedCacheBudget;
      /** Names the folder in a containment refusal. */
      label: string;
      refuse?: (problem: DerivedCacheProblem) => Error;
    },
  ) {}

  /** The folder on disk, made if it is missing, and inside the world. */
  async path(dir: string): Promise<string> {
    return dirname(await containedWorldFilePath(dir, `${this.folder}/placeholder`, true, this.options.label, true));
  }

  /** Two asks for one key share one make rather than racing to write the same file. */
  once<T>(dir: string, key: string, make: () => Promise<T>): Promise<T> {
    const id = `${resolve(dir)}|${key}`;
    const held = this.making.get(id) as Promise<T> | undefined;
    if (held !== undefined) return held;
    const run = make().finally(() => this.making.delete(id));
    this.making.set(id, run);
    return run;
  }

  /** Pinned until the returned release is called. */
  hold(dir: string, file: string): () => void {
    const key = this.identity(dir, file);
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    let held = true;
    return () => {
      if (held) { held = false; this.release(key); }
    };
  }

  /** Pinned until the signal aborts: a player's Stop, or the world closing. */
  retain(dir: string, file: string, signal?: AbortSignal): void {
    if (!signal || signal.aborted) return;
    let held = this.lifetimes.get(signal);
    if (!held) {
      const keys = new Set<string>();
      held = keys;
      this.lifetimes.set(signal, keys);
      signal.addEventListener("abort", () => { for (const key of keys) this.release(key); keys.clear(); }, { once: true });
    }
    const key = this.identity(dir, file);
    if (!held.has(key)) { held.add(key); this.pins.set(key, (this.pins.get(key) ?? 0) + 1); }
  }

  /** Pinned now, by a player or a run: Clean up leaves it alone (SPEC-066 R-21, R-34). */
  pinned(dir: string, file: string): boolean {
    return this.pins.has(this.identity(dir, file));
  }

  /** Used now: last in line for eviction, and in its grace period again. */
  async touch(dir: string, file: string): Promise<void> {
    const path = await containedWorldFilePath(dir, file, false, this.options.label);
    const now = new Date();
    await utimes(path, now, now);
  }

  /**
   * Room for `bytes` and `files` more, reserved before a render so that concurrent jobs cannot each
   * claim the same free space. Refused when evicting everything neither pinned nor recent is still
   * not enough, rather than breaking a player's next range request.
   */
  reserve(dir: string, bytes: number, files: number, signal: AbortSignal, budget = this.options.budget): Promise<() => void> {
    return this.queued(dir, async (folder, key) => {
      signal.throwIfAborted();
      if (bytes > budget.bytes || files > budget.files) throw this.refuse("too-large");
      const pending = this.reserved.get(key) ?? new Set<{ bytes: number; files: number }>();
      const left = await this.evict(dir, folder, bytes + total(pending, "bytes"), files + total(pending, "files"), signal, budget);
      if (left.bytes > budget.bytes || left.files > budget.files) throw this.refuse("full");
      const reservation = { bytes, files };
      pending.add(reservation);
      this.reserved.set(key, pending);
      return () => {
        pending.delete(reservation);
        if (!pending.size) this.reserved.delete(key);
      };
    });
  }

  /**
   * Back within budget as far as eviction allows, after a render has landed. It refuses nothing
   * and fails nothing: what was just made stands, and a cleanup that cannot finish is tried again
   * after the next render.
   */
  async trim(dir: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
    await this.queued(dir, async (folder, key) => {
      const pending = this.reserved.get(key) ?? new Set<{ bytes: number; files: number }>();
      await this.evict(dir, folder, total(pending, "bytes"), total(pending, "files"), signal, this.options.budget);
    }).catch(() => {});
  }

  private refuse(problem: DerivedCacheProblem): Error {
    return this.options.refuse?.(problem) ?? new Error(`${this.options.label}: ${problem}`);
  }

  /** One identity for a file and its receipt: the path without its extension. */
  private identity(dir: string, file: string): string {
    return resolve(dir, file).replace(/\.[^.\\/]+$/, "");
  }

  private release(key: string): void {
    const count = (this.pins.get(key) ?? 1) - 1;
    if (count) this.pins.set(key, count);
    else this.pins.delete(key);
  }

  /** One eviction at a time per folder. */
  private async queued<T>(dir: string, work: (folder: string, key: string) => Promise<T>): Promise<T> {
    const folder = await this.path(dir), key = resolve(folder);
    const run = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => work(folder, key));
    this.queues.set(key, run);
    try { return await run; } finally { if (this.queues.get(key) === run) this.queues.delete(key); }
  }

  /** The least recently used entries evicted until `bytes` and `files` more fit; what is left over is returned. */
  private async evict(dir: string, folder: string, bytes: number, files: number, signal: AbortSignal, budget: DerivedCacheBudget): Promise<{ bytes: number; files: number }> {
    const entries = new Map<string, Entry>();
    for (const found of await readdir(folder, { withFileTypes: true })) {
      if (!this.options.owns.test(found.name)) continue;
      if (!found.isFile() || found.isSymbolicLink()) throw this.refuse("unsafe");
      const file = `${this.folder}/${found.name}`, info = await lstat(await containedWorldFilePath(dir, file, false, this.options.label));
      const id = this.identity(dir, file), entry = entries.get(id) ?? { id, files: [], size: 0, mtimeMs: 0 };
      entry.files.push({ file, info });
      entry.size += info.size;
      entry.mtimeMs = Math.max(entry.mtimeMs, info.mtimeMs);
      entries.set(id, entry);
    }
    let size = bytes, count = files;
    for (const entry of entries.values()) { size += entry.size; count += entry.files.length; }
    for (const entry of [...entries.values()].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (size <= budget.bytes && count <= budget.files) break;
      if (this.pins.has(entry.id) || Date.now() - entry.mtimeMs < budget.graceMs) continue;
      for (const { file, info } of entry.files) {
        signal.throwIfAborted();
        const path = await containedWorldFilePath(dir, file, false, this.options.label), current = await lstat(path);
        if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) throw this.refuse("changed");
        // Pinned while this walk awaited: a player asked for it after the walk began.
        if (this.pins.has(entry.id)) break;
        await unlink(path);
        size -= info.size;
        count--;
      }
    }
    return { bytes: size, files: count };
  }
}

const total = (pending: ReadonlySet<{ bytes: number; files: number }>, field: "bytes" | "files") => [...pending].reduce((sum, entry) => sum + entry[field], 0);
