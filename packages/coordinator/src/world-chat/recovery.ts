import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { WorldChatRun } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import { foldConversation } from "./fold.js";
import { conversationsDir, WorldChatStore } from "./store.js";
import { preserveConversationActionTombstones } from "../arke-actions/tombstones.js";
import { recoverWorldChatInputs } from "./input-recovery.js";

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
 * The caller owes one precondition this module cannot check: **the world must not already be
 * open.** A run marked running is indistinguishable from a live one here, so running this against
 * the open world would close a turn somebody is waiting on. Coordinator.openWorld holds that.
 */

export interface RecoveryOutcome {
  /** Conversations whose interrupted run was made durable on this pass. */
  repaired: string[];
  /** Conversations whose queued or uncertain input state was recovered on this pass. */
  inputQueues: string[];
  /** Tombstoned directories a previous deletion left behind, now removed. */
  sweptTombstones: string[];
}

export async function recoverConversations(
  worldPath: string,
  now: () => string = () => new Date().toISOString(),
): Promise<RecoveryOutcome> {
  const outcome: RecoveryOutcome = { repaired: [], inputQueues: [], sweptTombstones: [] };
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
    const repaired = await repairConversation(join(root, entry), now);
    if (repaired.run) outcome.repaired.push(entry);
    if (repaired.inputs) outcome.inputQueues.push(entry);
  }
  return outcome;
}

/** Input-state repair and interrupted-run repair are independent recovery outcomes. */
async function repairConversation(dir: string, now: () => string): Promise<{ run: boolean; inputs: boolean }> {
  const store = new WorldChatStore(dir);
  const meta = await store.readMeta();
  if (!meta) return { run: false, inputs: false };

  const inputsRepaired = await recoverWorldChatInputs(store, now);
  const { events, problems } = await store.read();
  const folded = foldConversation(meta.id, meta.createdAt, events);
  if ([...problems, ...folded.problems].some(one => one.kind !== "torn-tail")) return { run: false, inputs: inputsRepaired };
  if (!folded.needsInterruptedRunRepair) return { run: false, inputs: inputsRepaired };

  const run = folded.view.activeRun;
  if (!run) return { run: false, inputs: inputsRepaired };

  // The fold has already set the status; persisting the same run record is what makes it true
  // for the next reader, and what stops a second pass finding anything to repair.
  const terminal: WorldChatRun = {
    ...run,
    status: "interrupted",
    endedAt: run.endedAt ?? now(),
    safeDetail: run.safeDetail ?? "the app closed mid-turn",
  };
  await store.append({ type: "run.finished", run: terminal }, { at: now() });
  return { run: true, inputs: inputsRepaired };
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
