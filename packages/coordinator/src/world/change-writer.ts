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

/** Read backwards a block at a time; a log big enough to matter is never held whole. */
const ENTITY_HISTORY_CHUNK = 64 * 1024;

const NEWLINE_BYTE = 0x0a;

export interface EntityHistory {
  /** The entity's own change lines, oldest first, at most `ENTITY_HISTORY_MAX` of them. */
  records: ChangeRecord[];
  /** Whether older records for this entity exist that the bound left out. Exact, not a guess. */
  truncated: boolean;
}

/**
 * A single entity's change lines, newest last (issue 289).
 *
 * The client snapshot carries a tail of the whole log, which is a recent-activity window and
 * nothing more: a bulk write — a migration measuring a hundred legacy tracks, an import filing a
 * folder — pushes every earlier record out of it in one pass. Filtering that window per entity
 * then reports "no recorded changes" for an entry whose records are sitting intact on disk.
 *
 * So a detail surface that wants one entity's history reads the log for that entity, per
 * SPEC-006 §2.5. Three things that read has to be at once (PR 540 review):
 *
 * **Complete.** Not the end of the file only. An entry last touched long ago has its records at
 * the front, and it is the entry most in need of a history panel — bounding the read to a tail of
 * bytes would reintroduce this issue's own bug one level down.
 *
 * **Cheap.** Parsing every record to keep a handful cost 750ms on a 200k-line log, and this runs
 * on every entry open and again whenever canon moves. A line whose bytes do not carry the
 * entity's own cannot be its record, and is skipped without being decoded or parsed — which is
 * most of them, and which took that 750ms to about 120ms.
 *
 * **Small.** Reading the file whole allocated it whole: 251MB of heap for a 62MB log, once per
 * request, however few records survived the filter. Blocks are read from the end backwards and
 * let go of as the walk passes them, so what is held is one block and the records kept — 14MB
 * for that same log, for the same answer in about the same time.
 *
 * Together: the walk starts at the newest and stops as soon as it has enough, so a recently
 * touched entity costs a block or two; an old one costs a pass over the file, a block at a time.
 */
export async function changesForEntity(worldDir: string, entity: string): Promise<EntityHistory> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(toExtendedLength(join(worldDir, "changes.jsonl")), "r");
  } catch {
    return { records: [], truncated: false };
  }
  /*
   * A record for this entity must contain the entity's own characters somewhere in its bytes,
   * whatever spacing or key order the line was written with — so a line without them cannot be
   * one, and need not be parsed to prove it. Only for an entity JSON leaves alone: one needing
   * an escape would be spelled differently on disk than here, and then every line is parsed
   * rather than a record being quietly missed.
   */
  const probe = JSON.stringify(entity) === `"${entity}"` ? Buffer.from(entity, "utf8") : null;

  // One more than the bound is collected, so "there are older ones" is something this saw rather
  // than something it inferred from having stopped early.
  const wanted = ENTITY_HISTORY_MAX + 1;
  const found: ChangeRecord[] = [];

  const take = (bytes: Buffer): void => {
    // Tested on the bytes, before anything is decoded. Decoding every line to ask whether it is
    // wanted costs more than the parsing this was meant to avoid — the whole-file read was eight
    // times faster until this moved down here.
    if (probe !== null && !bytes.includes(probe)) return;
    const line = bytes.toString("utf8").trim();
    if (!line) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A truncated final line is the crash signature (R-22) and a malformed one mid-file is
      // corruption; neither is this entity's history, and neither may make reading throw.
      return;
    }
    if ((value as ChangeLine | null)?.entity !== entity) return;
    const parsed = ChangeRecordSchema.safeParse(value);
    if (parsed.success) found.push(parsed.data);
  };

  try {
    let position = (await handle.stat()).size;
    /*
     * The bytes before the first newline of the block just read: a line split across the boundary,
     * whose front lives in the block that has not been read yet. Carried as bytes rather than as
     * text — decoding half a line can cut a character in two, while a newline byte never appears
     * inside a UTF-8 sequence, so splitting on it and decoding whole lines is always safe.
     */
    let carry = Buffer.alloc(0);
    while (position > 0 && found.length < wanted) {
      const length = Math.min(ENTITY_HISTORY_CHUNK, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      const block = carry.length > 0 ? Buffer.concat([buffer, carry]) : buffer;
      let end = block.length;
      // `end > 0` is load-bearing, not defensive: Buffer.lastIndexOf reads a negative offset as
      // one from the end of the buffer — where String.lastIndexOf clamps it to zero — so asking
      // from -1 finds the last newline again, forever.
      while (found.length < wanted && end > 0) {
        const newline = block.lastIndexOf(NEWLINE_BYTE, end - 1);
        if (newline < 0) break;
        take(block.subarray(newline + 1, end));
        end = newline;
      }
      carry = Buffer.from(block.subarray(0, end));
    }
    // The first line of the file has no newline before it, so the walk never reached it.
    if (position === 0 && carry.length > 0 && found.length < wanted) take(carry);
  } finally {
    await handle.close();
  }

  // Walked newest first and handed back oldest first. The newest are the ones a bound keeps: a
  // truncated tail of an entry's own history is a different thing from one evicted by unrelated
  // writes, and the caller is told which it is holding rather than left to assume.
  return {
    records: found.slice(0, ENTITY_HISTORY_MAX).reverse(),
    truncated: found.length > ENTITY_HISTORY_MAX,
  };
}

/** Whether the log already carries a line for this commit — the roll-forward idempotency probe. */
export async function hasCommitLine(path: string, commitId: string): Promise<boolean> {
  const lines = await readChanges(path);
  return lines.some((l) => l.commitId === commitId);
}
