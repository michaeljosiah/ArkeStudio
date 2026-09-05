import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  newId,
  type ConversationId,
  type WorldChatContext,
  type WorldChatInitiative,
  type WorldChatDeletionBlock,
  type WorldChatLoaded,
  type WorldChatSummary,
} from "@arke-studio/contracts";
import { renameWithRetry } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import { readCheckpoint, shouldCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { foldConversation, summarise } from "./fold.js";
import { ConversationSequenceError, conversationDir, conversationsDir, WorldChatStore } from "./store.js";
import { preserveConversationActionTombstones } from "../arke-actions/tombstones.js";

/**
 * Creating, reading and disposing of conversations (#70 phase 1, §15.1).
 *
 * A thin layer over the store, and deliberately thin: everything durable is still an appended
 * event, so this adds preconditions and convenience rather than a second source of truth.
 *
 * Deletion is the part with teeth. It is permanent, so it refuses while anything still depends on
 * the conversation, and it happens by renaming the directory aside rather than deleting in place.
 * The rename is the authoritative moment: a crash before it leaves the conversation whole, a
 * crash after leaves it gone with only bytes to reclaim, and there is no in-between state where
 * half a conversation exists.
 */

export class ConversationInUseError extends Error {
  constructor(readonly reason: WorldChatDeletionBlock) {
    super(REASONS[reason]);
    this.name = "ConversationInUseError";
  }
}

/** The refusals, in the words the row shows before the button is pressed rather than after. */
const REASONS: Record<WorldChatDeletionBlock, string> = {
  "active-run": "A turn is still running. Cancel it before deleting this conversation.",
  "wrap-up-in-flight": "This conversation is being turned into proposals. Wait for that to finish.",
  "unresolved-proposals":
    "Proposals from this conversation are still waiting on a decision. Accept or discard them first.",
  "pending-actions": "Actions from this conversation are still waiting. Deny or cancel them before deleting.",
} as const;

export interface CreateOptions {
  title: string;
  entryContext?: WorldChatContext;
  at?: string;
  requestId?: string;
}

export class WorldChatService {
  constructor(
    readonly worldPath: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private store(id: ConversationId): WorldChatStore {
    return new WorldChatStore(conversationDir(this.worldPath, id));
  }

  async create(options: CreateOptions): Promise<WorldChatSummary> {
    const id = newId("cv") as ConversationId;
    const at = options.at ?? this.now();
    const store = this.store(id);
    await store.create(id, at);
    await store.append(
      {
        type: "conversation.created",
        title: options.title,
        entryContext: options.entryContext ?? { kind: "world" },
      },
      { at, ...(options.requestId ? { requestId: options.requestId } : {}) },
    );
    return summarise((await this.load(id))!);
  }

  /**
   * The whole workspace for one conversation.
   *
   * Uses the checkpoint when it is exactly current and folds otherwise, then writes a new
   * checkpoint if enough has happened since — so the cost of reopening a long conversation is
   * paid once rather than on every visit.
   */
  async load(
    id: ConversationId,
    options: { messageLimit?: number; before?: number } = {},
  ): Promise<WorldChatLoaded | null> {
    const store = this.store(id);
    const meta = await store.readMeta();
    if (!meta) return null;

    const { events, problems } = await store.read();
    const tailSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;

    // A paged read is a different window over the same log, so the checkpoint — which only ever
    // holds the default window — cannot answer it.
    if (options.before === undefined && options.messageLimit === undefined) {
      const { checkpoint, problems: checkpointProblems } = await readCheckpoint(store.dir, tailSeq);
      if (checkpoint && checkpoint.throughSeq === tailSeq) {
        return { ...checkpoint.view, problems: [...problems, ...checkpointProblems] };
      }
      const folded = foldConversation(meta.id, meta.createdAt, events, options);
      const view = { ...folded.view, problems: [...problems, ...checkpointProblems, ...folded.problems] };
      if (shouldCheckpoint(tailSeq - (checkpoint?.throughSeq ?? 0), 0)) {
        await writeCheckpoint(store.dir, view);
      }
      return view;
    }

    const folded = foldConversation(meta.id, meta.createdAt, events, options);
    return { ...folded.view, problems: [...problems, ...folded.problems] };
  }

  async rename(id: ConversationId, title: string, requestId?: string): Promise<void> {
    await this.store(id).append(
      { type: "conversation.metadata-updated", title },
      { at: this.now(), ...(requestId ? { requestId } : {}) },
    );
  }

  async setContext(id: ConversationId, entryContext: WorldChatContext): Promise<void> {
    await this.store(id).append({ type: "conversation.metadata-updated", entryContext }, { at: this.now() });
  }

  /** The mode changes initiative, never acceptance authority (SPEC-023 R-21). */
  async setInitiative(id: ConversationId, initiative: WorldChatInitiative, requestId?: string): Promise<void> {
    await this.store(id).append(
      { type: "conversation.metadata-updated", initiative },
      { at: this.now(), ...(requestId ? { requestId } : {}) },
    );
  }

  /** Archiving is reversible and loses nothing; it is the safe alternative to deleting. */
  async archive(id: ConversationId): Promise<void> {
    await this.store(id).append({ type: "conversation.archived" }, { at: this.now() });
  }

  async unarchive(id: ConversationId): Promise<void> {
    await this.store(id).append({ type: "conversation.unarchived" }, { at: this.now() });
  }

  /**
   * Why this conversation cannot be deleted yet, or null when it can (R-50).
   *
   * Separate from `delete` so the reason can be shown before the button is pressed, rather than
   * as an error after somebody has already decided. The answer itself comes from the fold, which
   * is also what puts it on the summary row — the button and the refusal read the same value, so
   * they cannot drift apart.
   *
   * The log cannot distinguish a run that is happening now from one abandoned by a crash — both
   * are a start with no terminal event — so an open run blocks either way. That is not a
   * compromise: startup recovery closes the abandoned ones before anyone can reach a delete
   * button, so by the time this is asked, an open run really is a live one.
   */
  async blockedFromDeletion(id: ConversationId): Promise<ConversationInUseError["reason"] | null> {
    const store = this.store(id);
    const meta = await store.readMeta();
    if (!meta) return null;
    const { events } = await store.read();
    return foldConversation(meta.id, meta.createdAt, events).view.deletionBlock;
  }

  /**
   * Delete permanently.
   *
   * The intent is recorded inside the conversation before the rename, which makes it recovery
   * context rather than the deletion itself — the record travels with the directory it describes,
   * so a tombstone found at startup explains why it is there.
   */
  async delete(id: ConversationId, requestId: string): Promise<void> {
    const store = this.store(id);
    for (;;) {
      const meta = await store.readMeta();
      if (!meta) return; // already gone: a repeated Delete is not an error
      const events = (await store.read()).events;
      const blocked = foldConversation(meta.id, meta.createdAt, events).view.deletionBlock;
      if (blocked) throw new ConversationInUseError(blocked);
      try {
        const appended = await store.append(
          { type: "deletion.intent-recorded", requestId },
          { at: this.now(), requestId, expectedSeq: events.reduce((seq, event) => Math.max(seq, event.seq), 0) },
        );
        if (
          appended.envelope.event.type !== "deletion.intent-recorded" ||
          appended.envelope.event.requestId !== requestId
        ) {
          throw new Error("That deletion request ID was already used by another operation.");
        }
        break;
      } catch (error) {
        if (error instanceof ConversationSequenceError) continue;
        throw error;
      }
    }
    await store.drain();

    const tomb = join(conversationsDir(this.worldPath), ".deleted", `${id}-${requestId}`);
    await mkdir(toExtendedLength(join(tomb, "..")), { recursive: true });
    await renameWithRetry(store.dir, tomb);
    // The transcript and rich preview may now go, but the minimal approval audit may not.
    await preserveConversationActionTombstones(this.worldPath, tomb);
    // Past the rename the conversation is gone as far as the app is concerned; the bytes are
    // reclaimed here if they can be, and by the startup sweep if they cannot.
    await rm(toExtendedLength(tomb), { recursive: true, force: true }).catch(() => {});
  }
}
