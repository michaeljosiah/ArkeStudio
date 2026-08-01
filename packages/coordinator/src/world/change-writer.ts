import { open, readFile, stat } from "node:fs/promises";
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

/** Whether the log already carries a line for this commit — the roll-forward idempotency probe. */
export async function hasCommitLine(path: string, commitId: string): Promise<boolean> {
  const lines = await readChanges(path);
  return lines.some((l) => l.commitId === commitId);
}
