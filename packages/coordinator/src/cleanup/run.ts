import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, readdir, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ulid } from "@arke-studio/contracts";
import { BenchStore, sessionDir } from "../bench/store.js";
import { BENCH_TAKE_RESTORED_SCHEMA_VERSION } from "../world/commit.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { sha256 } from "../world/text-files.js";
import { isWorldPath, type Ledger, type LedgerFile, type LedgerItem, type LedgerOp } from "./ledger.js";
import type { PlannedFile, PlannedItem } from "./plan.js";

/**
 * One item at a time, each checked again at its turn, its intent flushed before anything moves
 * and its outcome after (SPEC-066 R-20, R-21). Nothing here is recursive or goes through a shell:
 * a run names every file it touches (R-26). Media moves by rename inside the world, so a hold is
 * instant and never copies; only a sidecar's removal or return goes through a commit (R-5, R-25).
 */
export interface RunContext {
  store: WorldStore;
  ledger: Ledger;
  now(): string;
  /** A held or restored take's session changed under the Bench's feet: it reads it again. */
  benchChanged(sessionId: string): Promise<void>;
  /** A cached mix a player or a run holds now (R-21). */
  pinned(path: string): boolean;
}

export type ItemResult = { result: "done" } | { result: "skipped" | "failed"; reason: string; stopClass?: boolean };

/** Every path a run touches is the world's own: anything else is refused before the disk is touched (R-26). */
const abs = (dir: string, path: string) => {
  if (!isWorldPath(path)) throw new Error("Clean up refused a path outside the world.");
  return toExtendedLength(join(dir, ...path.split("/")));
};
export const heldPath = (planId: string, path: string) => `.held/${planId}/${path}`;

async function unchanged(dir: string, file: PlannedFile): Promise<boolean> {
  const info = await lstat(abs(dir, file.path)).catch(() => null);
  return !!info && info.isFile() && !info.isSymbolicLink() && info.size === file.size && info.mtimeMs === file.mtimeMs && info.ino === file.ino && info.dev === file.dev;
}

export function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("error", reject).on("data", chunk => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

const ledgerFiles = (files: readonly PlannedFile[]): LedgerFile[] => files.map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs }));
const ledgerItem = (item: PlannedItem, extra: Partial<LedgerItem> = {}): LedgerItem => ({
  id: item.view.id, class: item.view.class, action: item.action, label: item.view.label, bytes: item.view.bytes,
  paths: item.view.paths, files: ledgerFiles(item.files), ...(item.sidecar ? { sidecar: item.sidecar } : {}), ...(item.bench ? { bench: item.bench } : {}), ...extra,
});

export async function runItem(ctx: RunContext, planId: string, item: PlannedItem): Promise<ItemResult> {
  const dir = ctx.store.dir, op: LedgerOp = "run";
  await ctx.store.assertOwnership();
  for (const file of item.files) if (!(await unchanged(dir, file))) return { result: "skipped", reason: "Changed since plan" };
  if (item.action === "link") {
    const keep = item.keep!, copy = item.files[0]!;
    if (!(await unchanged(dir, keep))) return { result: "skipped", reason: "Changed since plan" };
    // The sidecar's hash is a 64-bit prefix: both files are read whole now (R-21).
    const [a, b] = await Promise.all([fileSha256(abs(dir, keep.path)), fileSha256(abs(dir, copy.path))]);
    if (a !== b) return { result: "skipped", reason: "Changed since plan" };
    // Hashing takes time: the world may have closed, or another Studio taken it, meanwhile.
    await ctx.store.assertOwnership();
    if (!(await unchanged(dir, keep)) || !(await unchanged(dir, copy))) return { result: "skipped", reason: "Changed since plan" };
    const tmp = `${copy.path}.tmp-${ulid()}`;
    await ctx.ledger.append({ kind: "intent", op, planId, item: ledgerItem(item, { keep: keep.path, sha256: a, paths: [copy.path, tmp] }) });
    try { await link(abs(dir, keep.path), abs(dir, tmp)); }
    catch (error) {
      await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.view.id, result: "failed", reason: "Not on this drive" });
      // A drive that cannot hold a link stops its class; a file held open only skips this item.
      return { result: "failed", reason: "Not on this drive", stopClass: !["EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") };
    }
    try { await rename(abs(dir, tmp), abs(dir, copy.path)); }
    catch {
      await unlink(abs(dir, tmp)).catch(() => {});
      await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.view.id, result: "failed", reason: "In use" });
      return { result: "failed", reason: "In use" };
    }
    await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.view.id, result: "done" });
    return { result: "done" };
  }
  if (item.action === "clear") {
    if (item.files.some(file => ctx.pinned(file.path))) return { result: "skipped", reason: "In use" };
    await ctx.ledger.append({ kind: "intent", op, planId, item: ledgerItem(item) });
    for (const file of item.files) {
      try { await unlink(abs(dir, file.path)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.view.id, result: "failed", reason: "In use" });
        return { result: "failed", reason: "In use" };
      }
    }
    await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.view.id, result: "done" });
    return { result: "done" };
  }
  // A hold: the unit whole or not at all (R-27).
  if (item.unit && !(await sameUnit(dir, item.unit, item.files))) return { result: "skipped", reason: "Changed since plan" };
  if (item.sidecar) {
    const live = await readFile(abs(dir, item.sidecar.path), "utf8").catch(() => null);
    if (live !== item.sidecar.text) return { result: "skipped", reason: "Changed since plan" };
  }
  if (item.bench) {
    const session = await new BenchStore(sessionDir(dir, item.bench.sessionId as never)).fold().catch(() => null);
    const take = session?.takes.find(t => t.id === item.bench!.takeId);
    if (!take || take.disposition === "filed" || take.keptArtifactId) return { result: "skipped", reason: "Changed since plan" };
  }
  await ctx.store.assertOwnership();
  await ctx.ledger.append({ kind: "intent", op, planId, item: ledgerItem(item, item.unit ? { paths: [item.unit] } : {}) });
  const moves = item.unit ? [item.unit] : item.files.map(f => f.path);
  const moved: string[] = [];
  try {
    for (const path of moves) { await mkdir(dirname(abs(dir, heldPath(planId, path))), { recursive: true }); await rename(abs(dir, path), abs(dir, heldPath(planId, path))); moved.push(path); }
  } catch {
    for (const path of moved.reverse()) await rename(abs(dir, heldPath(planId, path)), abs(dir, path)).catch(() => {});
    await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.view.id, result: "failed", reason: "In use" });
    return { result: "failed", reason: "In use" };
  }
  try {
    // The record follows its media into the hold: a sidecar left naming a file in `.held` would be a live record without media.
    if (item.sidecar) await ctx.store.commit({ kind: "cleanup-hold", source: "cleanup", files: [{ path: item.sidecar.path, action: "delete", baseHash: sha256(item.sidecar.text) }] });
    if (item.bench) { await benchAppend(dir, item.bench, "take-deleted", ctx.now()); await ctx.benchChanged(item.bench.sessionId); }
  } catch {
    // A write can land and still report an error (a failed sync or tail read). When the record
    // shows the item gone, the hold stands: moving the files back would hand a deleted take's
    // folder to the Bench's sweep (Codex on PR 3052).
    const landed = item.sidecar ? !(await lstat(abs(dir, item.sidecar.path)).catch(() => null))
      : item.bench ? !(await new BenchStore(sessionDir(dir, item.bench.sessionId as never)).fold().catch(() => null))?.takes.some(t => t.id === item.bench!.takeId) : false;
    if (landed) {
      if (item.bench) await ctx.benchChanged(item.bench.sessionId);
      await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.view.id, result: "done" });
      return { result: "done" };
    }
    for (const path of moves) await rename(abs(dir, heldPath(planId, path)), abs(dir, path)).catch(() => {});
    await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.view.id, result: "failed", reason: "Record changed" });
    return { result: "failed", reason: "Record changed" };
  }
  await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.view.id, result: "done" });
  return { result: "done" };
}

async function sameUnit(dir: string, unit: string, files: readonly PlannedFile[]): Promise<boolean> {
  const info = await lstat(abs(dir, unit)).catch(() => null);
  if (!info || info.isSymbolicLink()) return false;
  if (!info.isDirectory()) return true;
  const found: string[] = [];
  const walk = async (rel: string): Promise<boolean> => {
    for (const entry of await readdir(abs(dir, rel), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) { if (!(await walk(`${rel}/${entry.name}`))) return false; }
      else found.push(`${rel}/${entry.name}`);
    }
    return true;
  };
  if (!(await walk(unit))) return false;
  const planned = new Set(files.map(f => f.path));
  return found.length === planned.size && found.every(path => planned.has(path));
}

async function benchAppend(dir: string, bench: { sessionId: string; takeId: string }, type: "take-deleted" | "take-restored", at: string): Promise<void> {
  await new BenchStore(sessionDir(dir, bench.sessionId as never)).append({ type, takeId: bench.takeId as never }, { at, requestId: `cleanup:${type}:${bench.takeId}:${ulid()}` });
}

/** Moves a held item's files back, its record first (R-29). */
export async function restoreItem(ctx: RunContext, planId: string, item: LedgerItem): Promise<ItemResult> {
  const dir = ctx.store.dir, op: LedgerOp = "restore";
  await ctx.store.assertOwnership();
  const moves = item.files.length && item.paths.length === 1 && !item.files.some(f => f.path === item.paths[0]) ? item.paths : item.files.map(f => f.path);
  for (const path of moves) if (await lstat(abs(dir, path)).catch(() => null)) return { result: "skipped", reason: "Name taken" };
  for (const file of item.files) {
    const held = await lstat(abs(dir, heldPath(planId, file.path))).catch(() => null);
    if (!held || held.size !== file.size || held.mtimeMs !== file.mtimeMs) return { result: "skipped", reason: "Not where it was held" };
  }
  if (item.sidecar && await lstat(abs(dir, item.sidecar.path)).catch(() => null)) return { result: "skipped", reason: "Name taken" };
  await ctx.ledger.append({ kind: "intent", op, planId, item });
  try {
    if (item.sidecar) await ctx.store.commit({ kind: "cleanup-restore", source: "cleanup", files: [{ path: item.sidecar.path, action: "create", content: item.sidecar.text, baseHash: null }] });
    if (item.bench) {
      // An older build would skip `take-restored` and sweep the files back out (R-37).
      await ctx.store.ensureSchemaVersion(BENCH_TAKE_RESTORED_SCHEMA_VERSION, "cleanup");
      await benchAppend(dir, item.bench, "take-restored", ctx.now());
    }
  } catch {
    await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.id, result: "failed", reason: "Record changed" });
    return { result: "failed", reason: "Record changed" };
  }
  const back: string[] = [];
  try {
    for (const path of moves) { await mkdir(dirname(abs(dir, path)), { recursive: true }); await rename(abs(dir, heldPath(planId, path)), abs(dir, path)); back.push(path); }
  } catch {
    // A unit is restored whole or not at all: what already moved goes back into the hold (Codex on PR 3052).
    for (const path of back.reverse()) await rename(abs(dir, path), abs(dir, heldPath(planId, path))).catch(() => {});
    // Nothing is left live with its media in `.held`: the record goes again (R-29).
    if (item.sidecar) await ctx.store.commit({ kind: "cleanup-hold", source: "cleanup", files: [{ path: item.sidecar.path, action: "delete", baseHash: sha256(item.sidecar.text) }] }).catch(() => {});
    if (item.bench) await benchAppend(dir, item.bench, "take-deleted", ctx.now()).catch(() => {});
    await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.id, result: "failed", reason: "In use" });
    return { result: "failed", reason: "In use" };
  }
  await pruneHeld(dir, planId, moves);
  if (item.bench) await ctx.benchChanged(item.bench.sessionId);
  await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.id, result: "done" });
  return { result: "done" };
}

/** A held item's files go for good: its hold ended, or Empty now (R-30, R-31). */
export async function removeHeld(ctx: RunContext, planId: string, item: LedgerItem, op: "expire" | "empty"): Promise<ItemResult> {
  const dir = ctx.store.dir;
  await ctx.store.assertOwnership();
  // Only while its records still show it gone: a sidecar back, or a take restored by other means, keeps it.
  if (item.sidecar && await lstat(abs(dir, item.sidecar.path)).catch(() => null)) return { result: "skipped", reason: "Back in use" };
  if (item.bench) {
    const session = await new BenchStore(sessionDir(dir, item.bench.sessionId as never)).fold().catch(() => null);
    if (!session || session.takes.some(t => t.id === item.bench!.takeId)) return { result: "skipped", reason: "Back in use" };
  }
  await ctx.ledger.append({ kind: "intent", op, planId, item });
  await removeFiles(dir, planId, item);
  await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.id, result: "done" });
  return { result: "done" };
}

async function removeFiles(dir: string, planId: string, item: LedgerItem): Promise<void> {
  for (const file of item.files) await unlink(abs(dir, heldPath(planId, file.path))).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  await pruneHeld(dir, planId, item.files.map(f => f.path));
}

/** Folders a hold left empty go when they are empty, deepest first, never past `.held` (R-26). */
async function pruneHeld(dir: string, planId: string, paths: readonly string[]): Promise<void> {
  const folders = new Set<string>();
  for (const path of paths) for (let at = dirname(path); at && at !== "."; at = dirname(at)) folders.add(at);
  for (const folder of [...folders].sort((a, b) => b.length - a.length)) await rmdir(abs(dir, heldPath(planId, folder))).catch(() => {});
  await rmdir(abs(dir, `.held/${planId}`)).catch(() => {});
  await rmdir(abs(dir, ".held")).catch(() => {});
}

/**
 * Every step a crash cut short, settled on open (R-24): a link's temporary name goes, a clear is
 * finished, a hold whose record never changed comes back, a restore whose record landed finishes
 * moving its files, and an expiry finishes removing them. Safe to run again.
 */
export async function recoverIntent(ctx: RunContext, line: { op: LedgerOp; planId: string; item: LedgerItem }): Promise<boolean> {
  const dir = ctx.store.dir, { op, planId, item } = line;
  const there = async (path: string) => !!(await lstat(abs(dir, path)).catch(() => null));
  const recordGone = async () => item.sidecar ? !(await there(item.sidecar.path))
    : item.bench ? !(await new BenchStore(sessionDir(dir, item.bench.sessionId as never)).fold().catch(() => null))?.takes.some(t => t.id === item.bench!.takeId) : true;
  const moves = item.action === "hold" && item.paths.length === 1 && !item.files.some(f => f.path === item.paths[0]) ? item.paths : item.files.map(f => f.path);
  // Which way it settled: a hold rolled forward still holds; one rolled back, or a restore whose record never landed, does not.
  let result: "recovered" | "undone" = "recovered";
  try {
    await ctx.store.assertOwnership();
    if (op === "run" && item.action === "link") { const tmp = item.paths[1]; if (tmp && await there(tmp)) await unlink(abs(dir, tmp)); }
    else if ((op === "run" || op === "auto") && item.action === "clear") { for (const f of item.files) await unlink(abs(dir, f.path)).catch(() => {}); }
    else if (op === "run") {
      // The record never changed: the hold is undone. It changed: the files finish moving into the hold.
      const gone = await recordGone();
      if (!gone) result = "undone";
      for (const path of moves) {
        if (!gone && await there(heldPath(planId, path)) && !(await there(path))) { await mkdir(dirname(abs(dir, path)), { recursive: true }); await rename(abs(dir, heldPath(planId, path)), abs(dir, path)); }
        if (gone && await there(path) && !(await there(heldPath(planId, path)))) { await mkdir(dirname(abs(dir, heldPath(planId, path))), { recursive: true }); await rename(abs(dir, path), abs(dir, heldPath(planId, path))); }
      }
    } else if (op === "restore" && !item.sidecar && !item.bench) {
      // An export has no record: a restore cut short finishes moving whatever is still held (Codex on PR 3052).
      for (const path of moves) if (await there(heldPath(planId, path)) && !(await there(path))) { await mkdir(dirname(abs(dir, path)), { recursive: true }); await rename(abs(dir, heldPath(planId, path)), abs(dir, path)); }
    } else if (op === "restore") {
      if (await recordGone()) result = "undone";
      else {
        for (const path of moves) if (await there(heldPath(planId, path)) && !(await there(path))) { await mkdir(dirname(abs(dir, path)), { recursive: true }); await rename(abs(dir, heldPath(planId, path)), abs(dir, path)); }
      }
    } else if (op === "expire" || op === "empty") await removeFiles(dir, planId, item);
  } catch { return false; }
  await ctx.ledger.append({ kind: "outcome", op, planId, itemId: item.id, result });
  return true;
}
