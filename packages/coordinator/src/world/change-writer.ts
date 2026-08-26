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
 * SPEC-006 §2.5. The whole file is read: it is one small append-only file, and reading it in
 * full is what makes the answer independent of how much else has happened since.
 */
export async function changesForEntity(worldDir: string, entity: string): Promise<ChangeRecord[]> {
  const lines = await readChanges(join(worldDir, "changes.jsonl"));
  const out: ChangeRecord[] = [];
  for (const line of lines) {
    if (line.entity !== entity) continue;
    const parsed = ChangeRecordSchema.safeParse(line);
    if (parsed.success) out.push(parsed.data);
  }
  // The newest are the ones kept: the panel reads newest first, and a truncated tail of an
  // entry's own history is a different thing from a history evicted by unrelated writes.
  return out.slice(-ENTITY_HISTORY_MAX);
}

/** Whether the log already carries a line for this commit — the roll-forward idempotency probe. */
export async function hasCommitLine(path: string, commitId: string): Promise<boolean> {
  const lines = await readChanges(path);
  return lines.some((l) => l.commitId === commitId);
}
