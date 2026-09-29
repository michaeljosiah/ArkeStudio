import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationId, WorldChatRun } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import { foldConversation } from "./fold.js";
import { conversationsDir, WorldChatStore } from "./store.js";
import { preserveConversationActionTombstones } from "../arke-actions/tombstones.js";

/**
 * What startup has to put right before anything new can happen (#70 phase 1, §7.2).
 *
 * A run left `running` has no terminal event: the process died mid-turn. The fold already shows
 * it as interrupted, but only in memory — and the next thing the app does is offer to start
 * another turn. So the terminal event is made durable here, once, before that can happen.
 *
 * Idempotence is the whole difficulty. Recovery runs on every open, and appending a second
 * terminal event for the same run would make the log say the turn ended twice. The guard is the
 * fold itself: after one repair no run is `running`, so a second pass finds nothing to do.
 *
 * The caller owes one precondition this module cannot check: **no turn may be live in the
 * world.** A run marked running is indistinguishable on disk from a live one, so running this
 * against a world with a turn in flight would close a turn somebody is waiting on.
 * Coordinator.openWorld holds that by skipping recovery for a world that was already open, and
 * by holding turns sent during an open until it settles — the store is installed part-way
 * through, so "not already open" alone let a line sent in that gap be closed as a crash
 * (2026-09-26). `isLive` is the second line: the runner knows which of its turns are really in
 * flight, and a conversation it names is left alone whatever the log says.
 */

export interface RecoveryOptions {
  /** Whether this process has a turn in flight on the conversation right now. */
  isLive?: (conversationId: ConversationId) => boolean;
}

export interface RecoveryOutcome {
  /** Conversations whose interrupted run was made durable on this pass. */
  repaired: string[];
  /** Tombstoned directories a previous deletion left behind, now removed. */
  sweptTombstones: string[];
}

export async function recoverConversations(
  worldPath: string,
  now: () => string = () => new Date().toISOString(),
  options: RecoveryOptions = {},
): Promise<RecoveryOutcome> {
  const outcome: RecoveryOutcome = { repaired: [], sweptTombstones: [] };
  const root = conversationsDir(worldPath);

  let entries: string[];
  try {
    entries = await readdir(toExtendedLength(root));
  } catch {
    return outcome;
  }

  for (const entry of entries) {
    if (entry === ".deleted") {
      outcome.sweptTombstones.push(...(await sweepTombstones(worldPath, join(root, entry))));
      continue;
    }
    if (entry.startsWith(".")) continue;
    if (await repairInterruptedRun(join(root, entry), now, options.isLive)) outcome.repaired.push(entry);
  }
  return outcome;
}

/** Returns true when this pass wrote a terminal event that was previously missing. */
async function repairInterruptedRun(
  dir: string,
  now: () => string,
  isLive: (conversationId: ConversationId) => boolean = () => false,
): Promise<boolean> {
  const store = new WorldChatStore(dir);
  const meta = await store.readMeta();
  if (!meta) return false;

  // Asked on both sides of the read. The runner registers a turn before appending its running
  // run and lets go only after appending its end, so a turn live at either moment is one this
  // log may show mid-flight — or, if it ended in between, already ended by its own hand. A turn
  // that started and finished wholly between the two would slip past; the coordinator's hold on
  // turns during an open is what keeps one from starting at all.
  if (isLive(meta.id)) return false;
  const { events } = await store.read();
  if (isLive(meta.id)) return false;
  const folded = foldConversation(meta.id, meta.createdAt, events);
  if (!folded.needsInterruptedRunRepair) return false;

  const run = folded.view.activeRun;
  if (!run) return false;

  // The fold has already set the status; persisting the same run record is what makes it true
  // for the next reader, and what stops a second pass finding anything to repair.
  const terminal: WorldChatRun = {
    ...run,
    status: "interrupted",
    endedAt: run.endedAt ?? now(),
    safeDetail: run.safeDetail ?? "the app closed mid-turn",
  };
  await store.append({ type: "run.finished", run: terminal }, { at: now() });
  return true;
}

/**
 * Remove directories a deletion renamed aside but never got to delete.
 *
 * The rename is the authoritative moment of a deletion, so anything under `.deleted` is already
 * gone as far as the app is concerned — this is only reclaiming the bytes.
 */
async function sweepTombstones(worldPath: string, deletedDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(toExtendedLength(deletedDir));
  } catch {
    return [];
  }
  const swept: string[] = [];
  for (const entry of entries) {
    try {
      await preserveConversationActionTombstones(worldPath, join(deletedDir, entry));
      await rm(toExtendedLength(join(deletedDir, entry)), { recursive: true, force: true });
      swept.push(entry);
    } catch {
      // A file still held open by a scanner will be swept on the next start; failing here would
      // stop the world opening over bytes nobody is waiting for.
    }
  }
  return swept;
}
