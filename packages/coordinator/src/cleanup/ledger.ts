import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CleanupClass } from "@arke-studio/contracts";
import { appendFlushed } from "../flushed-append.js";
import { toExtendedLength } from "../world/paths.js";

/**
 * `cleanup.jsonl` at the world's root (SPEC-066 R-19): every run, restore, expiry and Empty now,
 * append-only. Each line is written, file-synced and closed before what it records is done, so
 * an intent with no outcome after it is exactly the step a crash interrupted, and recovery on the
 * next open settles it (R-24). No line holds an absolute path or a file identity: paths are
 * world-relative, and a file is named by its size and modified time.
 */
export const LEDGER = "cleanup.jsonl";

export type LedgerOp = "run" | "restore" | "expire" | "empty" | "auto";

const PLAN_ID = /^cp_[0-9A-HJKMNP-TV-Z]{26}$/;
/** A world-relative path: forward slashes, no `.` or `..` segment, no drive, no absolute start. */
export const isWorldPath = (path: unknown): path is string =>
  typeof path === "string" && path.length > 0 && path.length <= 1024 && !/[\\:]/.test(path) && !path.includes("\u0000") &&!path.startsWith("/") &&
  path.split("/").every(part => part !== "" && part !== "." && part !== "..");
/**
 * A ledger travels with a world, so an imported one is read as untrusted: a line whose plan id
 * or paths could reach outside the world is skipped, never acted on (Codex on PR 3052).
 */
function wellFormed(line: LedgerLine): boolean {
  if (line.kind === "setting") return typeof line.autoMixes === "boolean";
  if (!PLAN_ID.test(line.planId)) return false;
  if (line.kind !== "intent") return true;
  const item = line.item;
  return !!item && typeof item.id === "string" && Array.isArray(item.paths) && Array.isArray(item.files) &&
    item.paths.every(isWorldPath) && item.files.every(file => isWorldPath(file?.path)) &&
    (item.keep === undefined || isWorldPath(item.keep)) &&
    (item.sidecar === undefined || (isWorldPath(item.sidecar.path) && /^artifacts\/[^/]+\.json$/.test(item.sidecar.path))) &&
    (item.bench === undefined || (/^sess_[0-9A-HJKMNP-TV-Z]{26}$/.test(item.bench.sessionId) && /^tk_[0-9A-HJKMNP-TV-Z]{26}$/.test(item.bench.takeId)));
}
export interface LedgerFile { path: string; size: number; mtimeMs: number }
/** What one item does, written before it is done: enough to finish it or undo it after a crash. */
export interface LedgerItem {
  id: string; class: CleanupClass; action: "link" | "clear" | "hold"; label: string; bytes: number;
  paths: string[]; files: LedgerFile[];
  /** A link: the file every other name becomes, and the bytes' full SHA-256 checked at its turn. */
  keep?: string; sha256?: string;
  /** A held artifact's sidecar, removed through a commit and committed back on Restore (R-39). */
  sidecar?: { path: string; text: string };
  /** A held Bench take, deleted from its session and restored to it (R-37). */
  bench?: { sessionId: string; takeId: string };
}
export type LedgerLine =
  | { v: 1; kind: "plan"; at: string; planId: string; holdUntil: string | null; items: number }
  | { v: 1; kind: "intent"; at: string; op: LedgerOp; planId: string; item: LedgerItem }
  | { v: 1; kind: "outcome"; at: string; op: LedgerOp; planId: string; itemId: string; result: "done" | "skipped" | "failed" | "undone" | "recovered"; reason?: string }
  | { v: 1; kind: "end"; at: string; op: LedgerOp; planId: string; stopped?: string }
  | { v: 1; kind: "setting"; at: string; autoMixes: boolean };

/** Every whole line; a truncated last line is skipped here and repaired by the next append. */
export async function readLedger(worldDir: string): Promise<LedgerLine[]> {
  const raw = await readFile(toExtendedLength(join(worldDir, LEDGER)), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const lines: LedgerLine[] = [];
  for (const text of raw.split("\n")) {
    if (!text.trim()) continue;
    try { const line = JSON.parse(text) as LedgerLine; if (line && line.v === 1 && typeof line.kind === "string" && wellFormed(line)) lines.push(line); }
    catch { /* The torn tail of a crash; its step is recovered from the intent before it. */ }
  }
  return lines;
}

const key = (op: string, planId: string, itemId: string) => `${op}|${planId}|${itemId}`;

/** Intents whose outcome never landed (R-24), oldest first. */
export function unsettled(lines: readonly LedgerLine[]): Array<Extract<LedgerLine, { kind: "intent" }>> {
  const open = new Map<string, Extract<LedgerLine, { kind: "intent" }>>();
  for (const line of lines) {
    if (line.kind === "intent") open.set(key(line.op, line.planId, line.item.id), line);
    else if (line.kind === "outcome") open.delete(key(line.op, line.planId, line.itemId));
  }
  return [...open.values()];
}

/** World import refuses a world a run was cut short in (R-46). */
export async function cleanupUnsettled(worldDir: string): Promise<boolean> {
  return unsettled(await readLedger(worldDir)).length > 0;
}

/** One writer per world: lines land in the order they were asked for. */
export class Ledger {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly worldDir: string, private readonly now: () => string) {}

  append(line: DistributiveOmit<LedgerLine, "v" | "at">): Promise<void> {
    const run = this.queue.catch(() => {}).then(async () => {
      const path = join(this.worldDir, LEDGER);
      await mkdir(toExtendedLength(this.worldDir), { recursive: true });
      // A crash mid-line leaves no newline: the next line starts on its own, and the torn one is skipped on read.
      const torn = await lastByte(path).then(byte => byte !== null && byte !== 0x0a);
      await appendFlushed(path, `${torn ? "\n" : ""}${JSON.stringify({ v: 1, at: this.now(), ...line })}\n`);
    });
    this.queue = run;
    return run;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

async function lastByte(path: string): Promise<number | null> {
  const handle = await open(toExtendedLength(path), "r").catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    if (size === 0) return null;
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, size - 1);
    return buffer[0]!;
  } finally { await handle.close(); }
}
