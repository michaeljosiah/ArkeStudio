import { lstat, readdir, unlink, utimes } from "node:fs/promises";
import { resolve } from "node:path";
import { AudioArrangementRefusal } from "@arke-studio/contracts";
import { containedWorldFilePath } from "../world/contained-file.js";
import { audioStudioCache } from "./audio-studio-source.js";

const limits = { bytes: 8 * 1024 ** 3, files: 256, graceMs: 10 * 60 * 1000 };
const queues = new Map<string, Promise<unknown>>();
const reserved = new Map<string, Set<{ bytes: number; files: number }>>();
const pins = new Map<string, number>();
const lifetimes = new WeakMap<AbortSignal, Set<string>>();
const identity = (dir: string, file: string) => resolve(dir, file).replace(/\.json$/, ".wav");
function release(key: string) { const count = (pins.get(key) ?? 1) - 1; if (count) pins.set(key, count); else pins.delete(key); }
/** A pin covers the WAV and its receipt. Playback pins last until Stop or world close. */
export function holdAudioStudioCache(dir: string, file: string): () => void {
  const key = identity(dir, file); pins.set(key, (pins.get(key) ?? 0) + 1);
  let held = true; return () => { if (held) { held = false; release(key); } };
}
export function retainAudioStudioCache(dir: string, file: string, signal?: AbortSignal): void {
  if (!signal || signal.aborted) return;
  let held = lifetimes.get(signal);
  if (!held) {
    held = new Set(); lifetimes.set(signal, held);
    signal.addEventListener("abort", () => { for (const key of held!) release(key); held!.clear(); }, { once: true });
  }
  const key = identity(dir, file);
  if (!held.has(key)) { held.add(key); pins.set(key, (pins.get(key) ?? 0) + 1); }
}
export async function touchAudioStudioCache(dir: string, file: string): Promise<void> {
  const path = await containedWorldFilePath(dir, file, false, "audio cache");
  const now = new Date(); await utimes(path, now, now);
}

/** Reserve completed output before rendering. Concurrent jobs cannot each claim the same free space.
 * Recent exports get a copy grace period; active auditions/Listen are explicitly pinned. If those
 * fill the budget, refuse more work instead of breaking a player's next HTTP range request. */
export async function reserveAudioStudioCache(dir: string, bytes: number, files: number, signal: AbortSignal, budget = limits): Promise<() => void> {
  const folder = await audioStudioCache(dir, "mix"), key = resolve(folder);
  const work = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    signal.throwIfAborted();
    const entries = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}\.(wav|json)$/.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new AudioArrangementRefusal("The audio cache contains an unsafe file");
      const file = `.cache/audio-studio/mix/${entry.name}`, path = await containedWorldFilePath(dir, file, false, "audio cache"), info = await lstat(path);
      entries.push({ file, path, info });
    }
    const pending = reserved.get(key) ?? new Set<{ bytes: number; files: number }>();
    let total = entries.reduce((sum, entry) => sum + entry.info.size, bytes) + [...pending].reduce((sum, entry) => sum + entry.bytes, 0);
    let count = entries.length + files + [...pending].reduce((sum, entry) => sum + entry.files, 0);
    for (const entry of entries.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
      if (total <= budget.bytes && count <= budget.files) break;
      if (pins.has(identity(dir, entry.file)) || Date.now() - entry.info.mtimeMs < budget.graceMs) continue;
      signal.throwIfAborted();
      const path = await containedWorldFilePath(dir, entry.file, false, "audio cache"), current = await lstat(path);
      if (current.isSymbolicLink() || current.dev !== entry.info.dev || current.ino !== entry.info.ino) throw new AudioArrangementRefusal("The audio cache changed during cleanup");
      if (pins.has(identity(dir, entry.file))) continue;
      await unlink(path); total -= entry.info.size; count--;
    }
    if (total > budget.bytes || count > budget.files) throw new AudioArrangementRefusal("Audio cache is full of recent or playing mixes; stop auditions or reopen the world before preparing more audio");
    const reservation = { bytes, files }; pending.add(reservation); reserved.set(key, pending);
    return () => { pending.delete(reservation); if (!pending.size) reserved.delete(key); };
  });
  queues.set(key, work);
  try { return await work; } finally { if (queues.get(key) === work) queues.delete(key); }
}
