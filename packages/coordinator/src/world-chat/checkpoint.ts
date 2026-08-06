import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  WorldChatCheckpointSchema,
  type WorldChatCheckpoint,
  type WorldChatLoaded,
  type WorldChatProblem,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";

/**
 * `checkpoint.json` — a derived acceleration file, and nothing more (#70 §4.2).
 *
 * Everything here follows from one rule: the checkpoint is never allowed to be believed over the
 * log. Deleting it costs a fold, never data. So it is distrusted whenever it fails to parse, and
 * whenever it claims a sequence the log cannot account for — a checkpoint that runs *past* the
 * complete tail describes events that are no longer there, which is exactly what a torn write
 * leaves behind.
 *
 * A checkpoint behind the tail is fine and expected: the fold replays the remainder.
 */

const CHECKPOINT_FILE = "checkpoint.json";

export function checkpointPath(dir: string): string {
  return join(dir, CHECKPOINT_FILE);
}

export interface CheckpointRead {
  checkpoint: WorldChatCheckpoint | null;
  problems: WorldChatProblem[];
}

/**
 * Read a checkpoint that may be trusted as far as `tailSeq`.
 *
 * Returns null rather than throwing for every failure mode. A conversation whose accelerator is
 * unreadable must still open at full speed from its log.
 */
export async function readCheckpoint(dir: string, tailSeq: number): Promise<CheckpointRead> {
  const problems: WorldChatProblem[] = [];
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(checkpointPath(dir)), "utf8");
  } catch {
    return { checkpoint: null, problems }; // absent is ordinary, not a problem
  }

  let parsed;
  try {
    parsed = WorldChatCheckpointSchema.safeParse(JSON.parse(raw));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) {
    problems.push({
      kind: "checkpoint-invalid",
      detail: "The saved summary of this conversation could not be read, so it was rebuilt from the log.",
    });
    return { checkpoint: null, problems };
  }

  if (parsed.data.throughSeq > tailSeq) {
    problems.push({
      kind: "checkpoint-invalid",
      detail: `The saved summary describes events up to ${parsed.data.throughSeq}, but the log ends at ${tailSeq}. It was rebuilt from the log.`,
      atSeq: tailSeq,
    });
    return { checkpoint: null, problems };
  }

  return { checkpoint: parsed.data, problems };
}

/**
 * Replace the checkpoint atomically.
 *
 * Via the world's own atomic writer, which stages beside the target and renames — so a kill
 * leaves the previous checkpoint whole rather than a half-written one that would then be
 * distrusted on the next open.
 */
export async function writeCheckpoint(dir: string, view: WorldChatLoaded): Promise<void> {
  const checkpoint = WorldChatCheckpointSchema.parse({
    schemaVersion: 1,
    throughSeq: view.seq,
    view,
  });
  await atomicWriteFile(checkpointPath(dir), JSON.stringify(checkpoint));
}

/** Drop the checkpoint. The next open rebuilds it; nothing is lost. */
export async function clearCheckpoint(dir: string): Promise<void> {
  await rm(toExtendedLength(checkpointPath(dir)), { force: true });
}

/**
 * How many events, or how many bytes, before the checkpoint is rewritten (§19).
 *
 * Rewriting on every append would double the write cost of a conversation for an accelerator
 * that only matters when one is reopened.
 */
export const CHECKPOINT_EVERY_EVENTS = 100;
export const CHECKPOINT_EVERY_BYTES = 1024 * 1024;

export function shouldCheckpoint(eventsSince: number, bytesSince: number): boolean {
  return eventsSince >= CHECKPOINT_EVERY_EVENTS || bytesSince >= CHECKPOINT_EVERY_BYTES;
}
