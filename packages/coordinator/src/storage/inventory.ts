import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setImmediate as yieldWork } from "node:timers/promises";
import { STORAGE_CATEGORIES, type StorageCategory, type StorageInventory } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";

export interface InventoryRoot { path: string; kind: StorageCategory | "world" | "comfyui" }
type Counts = Partial<Record<StorageCategory, { bytes: number; files: number }>>;
export interface InventoryReading { counts: Counts; complete: boolean; at: number }
const worldCategories: StorageCategory[] = ["artifacts", "takes", "publications", "temporary", "other"];
const categories = (kind: InventoryRoot["kind"]): StorageCategory[] => kind === "world" ? worldCategories : kind === "comfyui" ? ["models", "other", "downloads"] : kind === "models" ? ["models", "other", "downloads"] : [kind];
const inside = (root: string, path: string) => { const part = relative(root, path); return !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep); };
const pathKey = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

function category(kind: InventoryRoot["kind"], path: string): StorageCategory {
  const parts = path.split(sep);
  if ((kind === "models" || kind === "comfyui") && (parts.includes(".staging") || /\.[a-f0-9-]{36}\.partial$/.test(parts.at(-1)!))) return "downloads";
  if (kind === "world") {
    if (parts[0] === "artifacts") return "artifacts";
    if (parts[0] === "productions" && parts[2] === "takes") return "takes";
    if (parts[0] === "exports") return "publications";
    if ([".cache", ".staging", ".stage"].includes(parts[0]!)) return "temporary";
    return "other";
  }
  if (kind === "comfyui") return parts[0] === "ComfyUI" && parts[1] === "models" ? "models" : "other";
  // Ming overlays are runtime dependencies, rather than model weights.
  if (kind === "models" && parts[0] === "ming" && parts[1] === "runtime") return "other";
  return kind;
}

/** Metadata only. The async walk resumes between bounded slices; it never reads media.
 * Path checks detect ordinary replacement, not an OS sandbox against hostile ancestor swaps. */
export async function readStorageInventory(root: InventoryRoot, signal: AbortSignal, excluded: readonly string[] = [], ports: {
  now?: () => number; yield?: () => Promise<void>; progress?: () => void;
} = {}): Promise<InventoryReading> {
  const counts: Counts = Object.fromEntries(categories(root.kind).map(key => [key, { bytes: 0, files: 0 }]));
  let complete = true, opened = false, entries = 0, slice = 0, since = performance.now();
  const base = resolve(root.path);
  let canonical: string | null = null;
  const walk = async (directory: string, depth: number): Promise<void> => {
    signal.throwIfAborted(); ports.progress?.();
    if (depth > 64 || entries > 250_000) { complete = false; return; }
    let info;
    try { info = await lstat(toExtendedLength(directory)); }
    catch (error) { if (directory !== base || (error as NodeJS.ErrnoException).code !== "ENOENT") complete = false; return; }
    signal.throwIfAborted();
    ports.progress?.();
    if (info.isSymbolicLink() || !info.isDirectory()) { complete = false; return; }
    const actual = await realpath(toExtendedLength(directory)); canonical ??= actual;
    if (!inside(canonical, actual)) { complete = false; return; }
    signal.throwIfAborted(); ports.progress?.();
    const dir = await opendir(toExtendedLength(directory), { bufferSize: 16 });
    if (signal.aborted) { await dir.close(); signal.throwIfAborted(); }
    ports.progress?.();
    if (directory === base) opened = true;
    for await (const entry of dir) {
      signal.throwIfAborted();
      if (++entries > 250_000) { complete = false; break; }
      const path = join(directory, entry.name);
      if (excluded.some(value => pathKey(path) === pathKey(value))) continue;
      try {
        const item = await lstat(toExtendedLength(path)); signal.throwIfAborted(); ports.progress?.();
        if (item.isSymbolicLink()) complete = false;
        else if (item.isDirectory()) await walk(path, depth + 1);
        else if (item.isFile()) {
          const key = category(root.kind, relative(base, path)), row = counts[key] ??= { bytes: 0, files: 0 };
          if (!Number.isSafeInteger(item.size) || item.size < 0 || !Number.isSafeInteger(row.bytes + item.size)) complete = false;
          else { row.bytes += item.size; row.files++; }
        } else complete = false;
      } catch { signal.throwIfAborted(); complete = false; }
      if (++slice >= 1000 || performance.now() - since >= 50) {
        await (ports.yield ?? yieldWork)(); signal.throwIfAborted(); slice = 0; since = performance.now();
      }
    }
  };
  try { await walk(base, 0); } catch { signal.throwIfAborted(); complete = false; }
  return { counts: !opened && !complete ? {} : counts, complete, at: (ports.now ?? Date.now)() };
}

/** One background reader. A timed-out filesystem call retains its slot until it settles,
 * so refresh cannot accumulate abandoned reads. No paths or file names leave this owner. */
export class StorageInventoryCollector {
  private roots: InventoryRoot[] = [];
  private readings = new Map<string, InventoryReading>();
  private recorded = new Map<string, { root: InventoryRoot; reading: InventoryReading | null }>();
  private work: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private version = 0;
  private started = false;
  private stopped = false;
  private nextAt = 0;
  constructor(private readonly deps: {
    changed(): void; now?: () => number; read?: typeof readStorageInventory; timeoutMs?: number;
  }) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private allRoots(): InventoryRoot[] { return [...new Map([...this.roots, ...[...this.recorded.values()].map(value => value.root)].map(root => [pathKey(root.path), root])).values()]; }
  /** Existing receipt owners provide incremental logical sizes; their subtree is not rescanned. */
  record(root: InventoryRoot, reading: InventoryReading | null): void {
    if (this.stopped) return;
    const normalized = { ...root, path: resolve(root.path) }, key = pathKey(root.path), previous = this.recorded.get(key);
    if (!previous && this.recorded.size >= 16) throw new Error("Too many inventory receipt owners.");
    if (reading && (!Number.isSafeInteger(reading.at) || reading.at < 0 || Object.values(reading.counts).some(row => !Number.isSafeInteger(row!.bytes) || row!.bytes < 0 || !Number.isSafeInteger(row!.files) || row!.files < 0))) reading = null;
    this.recorded.set(key, { root: normalized, reading });
    if (JSON.stringify(previous?.reading?.counts ?? null) !== JSON.stringify(reading?.counts ?? null)) this.publish();
  }
  setRoots(roots: readonly InventoryRoot[]): void {
    const next = [...new Map(roots.map(root => [pathKey(root.path), { ...root, path: resolve(root.path) }])).values()];
    if (JSON.stringify(next) === JSON.stringify(this.roots) || this.stopped) return;
    if (next.length > 64) throw new Error("Storage inventory scope exceeds its supported bound.");
    this.version++; this.abort?.abort(); this.roots = next;
    this.readings.clear(); this.nextAt = 0; this.publish(); this.schedule();
  }
  start(): void { if (!this.stopped) { this.started = true; this.schedule(); } }
  /** Coalesced event hint; completion does not await a directory walk. */
  refresh(): void { if (!this.stopped) { this.nextAt = Math.min(this.nextAt, this.now() + 30_000); this.schedule(); } }
  snapshot(): StorageInventory {
    const now = this.now();
    return { scanning: this.work !== null, allocatedBytes: null, reclaimableBytes: null,
      categories: STORAGE_CATEGORIES.map(key => {
        const relevant = this.allRoots().filter(root => categories(root.kind).includes(key));
        const values = relevant.map(root => this.recorded.has(pathKey(root.path)) ? this.recorded.get(pathKey(root.path))!.reading : this.readings.get(root.path));
        const known = values.filter((value): value is InventoryReading => !!value?.counts[key] && value.at <= now);
        const bytes = known.reduce((sum, value) => sum + (value.counts[key]?.bytes ?? 0), 0), files = known.reduce((sum, value) => sum + (value.counts[key]?.files ?? 0), 0);
        const safe = Number.isSafeInteger(bytes) && Number.isSafeInteger(files);
        return { category: key, state: !known.length || !safe ? "unmeasured" : known.length < values.length || known.some(value => !value.complete) ? "partial" : "measured",
          logicalBytes: known.length && safe ? bytes : null, files: known.length && safe ? files : null,
          measuredAt: known.length ? Math.min(...known.map(value => value.at)) : null };
      }) };
  }
  private publish(): void { if (!this.stopped) { try { this.deps.changed(); } catch { /* Observation does not depend on a view. */ } } }
  private schedule(): void {
    if (!this.started || this.stopped || this.work) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.collect(); }, Math.max(0, this.nextAt - this.now())); this.timer.unref();
  }
  private collect(): void {
    if (this.stopped || this.work) return;
    const version = this.version, control = new AbortController(); this.abort = control;
    this.nextAt = this.now() + 5 * 60_000;
    this.work = (async () => {
      for (const root of this.roots) {
        if (control.signal.aborted) break;
        if (this.recorded.has(pathKey(root.path))) continue;
        const timeout = new AbortController(), signal = AbortSignal.any([control.signal, timeout.signal]);
        let timer: NodeJS.Timeout;
        const progress = () => {
          if (signal.aborted) return;
          clearTimeout(timer);
          timer = setTimeout(() => { timeout.abort(); this.readings.delete(root.path); this.publish(); }, this.deps.timeoutMs ?? 15_000); timer.unref();
        };
        progress();
        try {
          const excluded = this.allRoots().filter(other => other.path !== root.path && inside(root.path, other.path)).map(other => other.path);
          const result = await (this.deps.read ?? readStorageInventory)(root, signal, excluded, { now: () => this.now(), progress });
          if (!signal.aborted && version === this.version && !this.stopped) this.readings.set(root.path, result);
        } catch { if (version === this.version) this.readings.delete(root.path); }
        finally { clearTimeout(timer!); }
        if (version === this.version) this.publish();
      }
    })().finally(() => { this.work = null; this.abort = null; this.publish(); this.schedule(); });
    this.publish();
  }
  stop(): void {
    this.stopped = true; this.abort?.abort(); if (this.timer) clearTimeout(this.timer); this.timer = null;
    // The in-flight metadata call may settle later; it can only close its own directory
    // handles. Its aborted chain cannot publish, start another read or grant any action.
  }
}
