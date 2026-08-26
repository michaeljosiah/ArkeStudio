import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ChangeRecordSchema, type ChangeRecord } from "@arke-studio/contracts";
import { toExtendedLength } from "./paths.js";

/**
 * changes.jsonl — append-only, tolerant of a truncated final line (SPEC-002 R-21, R-22).
 * A crash during an append leaves a partial line; the reader discards it and the next append
 * repairs the file by ensuring it begins on a fresh line. The file is never rewritten.
 */

export interface ChangeLine {
  ts: string;
  commitId?: string;
  entity?: string;
  [k: string]: unknown;
}

/** Read every complete line; a truncated tail is silently discarded (R-22). */
export async function readChanges(path: string): Promise<ChangeLine[]> {
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(path), "utf8");
  } catch {
    return [];
  }
  const out: ChangeLine[] = [];
  const lines = raw.split("\n");
  const endedClean = raw.endsWith("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const isLast = i === lines.length - 1 || (i === lines.length - 2 && lines[lines.length - 1] === "");
    try {
      out.push(JSON.parse(line) as ChangeLine);
    } catch {
      if (isLast && !endedClean) continue; // the crash signature — tolerated
      // A malformed line mid-file is corruption worth surfacing, but reading must not throw:
      // the log is an audit trail and the good lines still matter.
      continue;
    }
  }
  return out;
}

/**
 * Append lines, repairing a truncated tail first: if the file does not end with a newline,
 * one is written before the new records so the partial line is terminated, never merged into
 * a valid record.
 */
export async function appendChanges(path: string, records: object[]): Promise<void> {
  if (records.length === 0) return;
  const payload = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  let needsLeadingNewline = false;
  try {
    const info = await stat(toExtendedLength(path));
    if (info.size > 0) {
      const handle = await open(toExtendedLength(path), "r");
      try {
        const buf = Buffer.alloc(1);
        await handle.read(buf, 0, 1, info.size - 1);
        needsLeadingNewline = buf.toString("utf8") !== "\n";
      } finally {
        await handle.close();
      }
    }
  } catch {
    /* no file yet */
  }
  const handle = await open(toExtendedLength(path), "a");
  try {
    await handle.writeFile((needsLeadingNewline ? "\n" : "") + payload, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Bounded so one pathological entity cannot make a detail response unbounded. */
const ENTITY_HISTORY_MAX = 200;

/**
 * A single entity's change lines, newest last (issue 289).
 *
 * The client snapshot carries a tail of the whole log, which is a recent-activity window and
 * nothing more: a bulk write — a migration measuring a hundred legacy tracks, an import filing a
 * folder — pushes every earlier record out of it in one pass. Filtering that window per entity
 * then reports "no recorded changes" for an entry whose records are sitting intact on disk.
 *
 * So a detail surface that wants one entity's history reads the log for that entity, per
 * SPEC-006 §2.5.
 *
 * Not via `readChanges`, and not from the end of the file only (PR 540 review). Parsing every
 * record to keep a handful cost 750ms on a 200k-line log, and this runs on every entry open and
 * again whenever canon moves; but bounding the *read* to a tail of bytes would reintroduce this
 * issue's own bug one level down, since an entry last touched long ago has its records at the
 * front. So the whole file is scanned and almost none of it is parsed: lines are walked
 * backwards, skipped unless they carry the entity's characters at all, and the walk stops once
 * enough have been found. Same answer, a fiftieth of the work.
 */
export async function changesForEntity(worldDir: string, entity: string): Promise<ChangeRecord[]> {
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(join(worldDir, "changes.jsonl")), "utf8");
  } catch {
    return [];
  }
  /*
   * A record for this entity must contain the entity's own characters somewhere in its bytes,
   * whatever spacing or key order the line was written with — so a line without them cannot be
   * one, and need not be parsed to prove it. Only for an entity JSON leaves alone: one needing
   * an escape would be spelled differently on disk than here, and then every line is parsed
   * rather than a record being quietly missed.
   */
  const probe = JSON.stringify(entity) === `"${entity}"` ? entity : null;

  const out: ChangeRecord[] = [];
  let end = raw.length;
  while (end > 0 && out.length < ENTITY_HISTORY_MAX) {
    const newline = raw.lastIndexOf("\n", end - 1);
    const line = raw.slice(newline + 1, end).trim();
    end = newline; // -1 once the first line has been read, which ends the walk
    if (!line) continue;
    if (probe !== null && !line.includes(probe)) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A truncated final line is the crash signature (R-22) and a malformed one mid-file is
      // corruption; neither is this entity's history, and neither may make reading throw.
      continue;
    }
    if ((value as ChangeLine | null)?.entity !== entity) continue;
    const parsed = ChangeRecordSchema.safeParse(value);
    if (parsed.success) out.push(parsed.data);
  }
  // Walked newest first and handed back oldest first: the newest are the ones a bound keeps, and
  // a truncated tail of an entry's own history is a different thing from one evicted by
  // unrelated writes — which is the whole point of reading per entity.
  return out.reverse();
}

/** Whether the log already carries a line for this commit — the roll-forward idempotency probe. */
export async function hasCommitLine(path: string, commitId: string): Promise<boolean> {
  const lines = await readChanges(path);
  return lines.some((l) => l.commitId === commitId);
}
