import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationId, RunId } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";

/**
 * The per-run scratch directory (#70 §8.2).
 *
 * Each run gets a fresh directory outside the world holding its session configuration and
 * nothing else. Outside the world matters: the harness treats its working directory as writable,
 * and a scratch directory inside the world would be a writable path in the one place this
 * feature promises never to write. The world is only ever changed by the accept gate.
 *
 * It holds no transcript authority either. The conversation log is the record; this is a
 * courier. Losing it costs a run, not a conversation.
 */

export function runRootDir(appRoot: string): string {
  return join(appRoot, "run", "world-chat");
}

export function conversationRunDir(appRoot: string, conversationId: ConversationId): string {
  return join(runRootDir(appRoot), conversationId);
}

export function runScratchDir(appRoot: string, conversationId: ConversationId, runId: RunId): string {
  return join(conversationRunDir(appRoot, conversationId), runId);
}

export interface ScratchOptions {
  appRoot: string;
  conversationId: ConversationId;
  runId: RunId;
  /** Session configuration, including the leased query URL whose token dies with the run. */
  config: Record<string, unknown>;
}

export async function createRunScratch(options: ScratchOptions): Promise<string> {
  const dir = runScratchDir(options.appRoot, options.conversationId, options.runId);
  await mkdir(toExtendedLength(dir), { recursive: true });
  await writeFile(
    toExtendedLength(join(dir, "opencode.json")),
    `${JSON.stringify(options.config, null, 2)}\n`,
    "utf8",
  );
  return dir;
}

/**
 * Remove one run's scratch. Best-effort by design: a run that finished but could not clean up
 * has still finished, and failing the turn over a leftover directory would be worse than the
 * directory. The startup sweep is the backstop.
 */
export async function removeRunScratch(
  appRoot: string,
  conversationId: ConversationId,
  runId: RunId,
): Promise<void> {
  await rm(toExtendedLength(runScratchDir(appRoot, conversationId, runId)), {
    recursive: true,
    force: true,
  }).catch(() => {});
}

/**
 * Clear everything left by runs that did not finish (§8.2).
 *
 * Called at startup, when by definition no run is in flight, so anything here belongs to a
 * process that is gone. Returns what it removed so the caller can record it rather than have
 * disk quietly reclaimed with no account of why.
 */
export async function sweepRunScratch(appRoot: string): Promise<string[]> {
  const root = runRootDir(appRoot);
  let conversations: string[];
  try {
    conversations = await readdir(toExtendedLength(root));
  } catch {
    return [];
  }

  const swept: string[] = [];
  for (const conversation of conversations) {
    const dir = join(root, conversation);
    let runs: string[] = [];
    try {
      runs = await readdir(toExtendedLength(dir));
    } catch {
      continue;
    }
    for (const run of runs) swept.push(`${conversation}/${run}`);
    await rm(toExtendedLength(dir), { recursive: true, force: true }).catch(() => {});
  }
  return swept;
}
