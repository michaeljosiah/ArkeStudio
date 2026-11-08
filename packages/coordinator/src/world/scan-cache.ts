import { readFile, stat } from "node:fs/promises";
import { toExtendedLength } from "./paths.js";

/** The cheap proxy a file's bytes are trusted by: the same three `hashMedia` uses (scan.ts). */
export interface FileIdentity { size: number; mtimeMs: number; ctimeMs: number }

const same = (a: FileIdentity, b: FileIdentity) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const identityOf = (s: FileIdentity): FileIdentity => ({ size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });

/**
 * What an open world's scans already read, keyed by file identity (issue 2793). Every authored
 * write rescanned the whole world, and a rescan reread, rehashed and reparsed every record file
 * and every conversation log: about a second on a world of 4,000 artifacts and 1,000 takes.
 *
 * A rescan still lists every directory and stats every file, so an edit made outside the app, an
 * addition or a deletion is seen exactly as before; only a file whose size, mtime and ctime all
 * match what was read is not read again. ctime moves whenever the bytes are written, so a tool
 * that restores mtime cannot hide an edit. Owned by one open store and dropped with it.
 */
export class ScanCache {
  private readonly files = new Map<string, { identity: FileIdentity; raw: string; hash: string; parsed?: { value: unknown } | { error: unknown } }>();
  private readonly memo = new Map<string, { key: string; value: unknown }>();
  private readonly touched = new Set<string>();

  /** A record file's text and its manifest hash, read again only when its identity changed. */
  async read(path: string, hash: (raw: string) => string, signal?: AbortSignal): Promise<{ raw: string; hash: string }> {
    signal?.throwIfAborted();
    return this.readKnown(path, identityOf(await stat(toExtendedLength(path))), hash, signal);
  }

  /**
   * The same for a record whose absence is ordinary: null when it cannot be stat'd, which is what
   * the scan's `exists` decided, so one stat answers both questions. A read that fails still throws.
   */
  async readIfPresent(path: string, hash: (raw: string) => string, signal?: AbortSignal): Promise<{ raw: string; hash: string } | null> {
    signal?.throwIfAborted();
    let identity: FileIdentity;
    try { identity = identityOf(await stat(toExtendedLength(path))); } catch { signal?.throwIfAborted(); return null; }
    return this.readKnown(path, identity, hash, signal);
  }

  private async readKnown(path: string, identity: FileIdentity, hash: (raw: string) => string, signal?: AbortSignal): Promise<{ raw: string; hash: string }> {
    const target = toExtendedLength(path);
    this.touched.add(path);
    const held = this.files.get(path);
    if (held && same(held.identity, identity)) return held;
    const raw = await readFile(target, { encoding: "utf8", signal });
    // A file written between the stat and the read carries the newer bytes under the older
    // identity; the next scan's stat disagrees with it and reads again, so it is never kept stale.
    const entry = { identity, raw, hash: hash(raw) };
    this.files.set(path, entry);
    return entry;
  }

  /**
   * The parsed record for text this cache returned, reused while the file is unchanged. Only for
   * records nothing writes into after the scan: the same object is handed to every scan.
   */
  parsed<T>(path: string, raw: string, parse: (raw: string) => T): T {
    const held = this.files.get(path);
    if (!held || held.raw !== raw) return parse(raw);
    if (!held.parsed) {
      try { held.parsed = { value: parse(raw) }; } catch (error) { held.parsed = { error }; }
    }
    if ("error" in held.parsed) throw held.parsed.error;
    return held.parsed.value as T;
  }

  /** A value derived from files, reused while every one of them keeps its identity. */
  async derived<T>(name: string, paths: readonly string[], derive: () => Promise<T>): Promise<T> {
    const identities = await Promise.all(paths.map(async (path) => {
      try { return JSON.stringify(identityOf(await stat(toExtendedLength(path)))); } catch { return "absent"; }
    }));
    const key = identities.join("|");
    this.touched.add(name);
    const held = this.memo.get(name);
    if (held && held.key === key) return held.value as T;
    const value = await derive();
    this.memo.set(name, { key, value });
    return value;
  }

  /** After a complete scan: forget the files and values it did not ask for, which are gone or renamed. */
  sweep(): void {
    for (const path of this.files.keys()) if (!this.touched.has(path)) this.files.delete(path);
    for (const name of this.memo.keys()) if (!this.touched.has(name)) this.memo.delete(name);
    this.touched.clear();
  }
}
