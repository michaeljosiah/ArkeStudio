import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationActionCard, WorldChatSummary } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import { readCheckpoint } from "./checkpoint.js";
import { foldConversation, summarise } from "./fold.js";
import { conversationsDir, WorldChatStore } from "./store.js";

/**
 * The conversation rows a world snapshot carries (#70 §4.5, phase 1).
 *
 * Opening a world must not cost every conversation ever had, so this reads summaries and never
 * transcripts. Where a checkpoint exists it is used as-is — that is the entire reason it exists —
 * and where one does not, the log is folded once and the row taken from that.
 *
 * A conversation that will not read at all is still listed, with whatever its header knows. A
 * world with one damaged conversation must not lose the other nine from the picker.
 */

export interface DiscoveredConversations {
  summaries: WorldChatSummary[];
  /** Authority bindings for live work, without publishing other conversations' transcripts. */
  activeActions: ConversationActionCard[];
}

const DELETED_DIR = ".deleted";

export async function discoverConversations(worldPath: string): Promise<DiscoveredConversations> {
  const root = conversationsDir(worldPath);
  let entries: string[];
  try {
    entries = await readdir(toExtendedLength(root));
  } catch {
    return { summaries: [], activeActions: [] }; // no conversations yet is the ordinary case, not a problem
  }

  const summaries: WorldChatSummary[] = [];
  const activeActions: ConversationActionCard[] = [];
  for (const entry of entries) {
    // Tombstoned directories are mid-deletion; a startup sweep removes them.
    if (entry === DELETED_DIR || entry.startsWith(".")) continue;
    const found = await summariseOne(join(root, entry));
    if (found) {
      summaries.push(found.summary);
      activeActions.push(...found.activeActions);
    }
  }
  return { summaries: sortByPendingConsequence(summaries), activeActions };
}

async function summariseOne(dir: string): Promise<{ summary: WorldChatSummary; activeActions: ConversationActionCard[] } | null> {
  const store = new WorldChatStore(dir);
  const meta = await store.readMeta();
  if (!meta) return null; // a directory without a header is not a conversation

  const { events } = await store.read();
  const tailSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;

  const { checkpoint } = await readCheckpoint(dir, tailSeq);
  const view = checkpoint && checkpoint.throughSeq === tailSeq
    ? checkpoint.view
    : foldConversation(meta.id, meta.createdAt, events).view;
  return {
    summary: summarise(view),
    activeActions: view.actions.filter((action) => ["approved", "queued", "running", "awaiting-host"].includes(action.status)),
  };
}

/**
 * Ordered by what is waiting on the user, not by recency alone.
 *
 * A conversation with proposals at the gate is the one you must go back to; one with live
 * propositions can wait indefinitely without consequence; one with neither is history. Recency
 * breaks ties, because within a tier it is the only thing that distinguishes them.
 */
function tier(row: WorldChatSummary): number {
  if (row.openProposalCount > 0) return 0;
  if (row.pointCount > 0) return 1;
  return 2;
}

export function sortByPendingConsequence(rows: WorldChatSummary[]): WorldChatSummary[] {
  return rows.toSorted((a, b) => tier(a) - tier(b) || b.updatedAt.localeCompare(a.updatedAt));
}
