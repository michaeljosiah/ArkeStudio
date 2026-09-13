import { createHash } from "node:crypto";
import {
  WorldChatInputAttemptSchema, WorldChatInputConstraintsSchema, WorldChatInputRequestSchema,
  WorldChatInputRoutingSchema, WorldChatRunSchema, WorldChatStoredEventSchema,
  WORLD_CHAT_INPUT_SCHEMA_VERSION, newId, worldChatInputRouting,
  type ConversationId, type WorldChatEventEnvelope, type WorldChatInputAttempt,
  type WorldChatInputPauseReason, type WorldChatInputQueue, type WorldChatInputRecord,
  type WorldChatInputRequest, type WorldChatInputRouting, type WorldChatRun,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { stableJson } from "../arke-actions/digest.js";
import { foldConversation } from "./fold.js";
import { foldWorldChatInputs, isInputEvent, type InputStoredEvent } from "./input-fold.js";
import { conversationDir, ConversationSequenceError, WorldChatStore } from "./store.js";

export function inputCommandDigest(command: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(command)).digest("hex")}`;
}

export class WorldChatInputError extends Error {
  constructor(readonly reason: "conflict" | "stale" | "unavailable" | "integrity", message: string) {
    super(message);
    this.name = "WorldChatInputError";
  }
}

type InputWorld = Pick<WorldStore, "dir" | "closingSignal" | "ownedWrite" | "raiseSchemaBoundary">;
type WithoutTransition<T> = T extends InputStoredEvent ? Omit<T, "queueRevision" | "commandDigest"> : never;
type Change = WithoutTransition<InputStoredEvent>;
export interface InputJournalReceipt {
  event: InputStoredEvent;
  sequence: number;
  queue: WorldChatInputQueue;
  deduplicated: boolean;
}

/**
 * Durable input transitions, not an execution loop (SPEC-045 T-3). Every method ends after a
 * flushed append; callers must release this transaction before waiting on an engine. Promotion
 * commits the original message and its primary run together, so restart cannot pop an input
 * without retaining the turn it became. No method dispatches, retries or interrupts a model.
 */
export class WorldChatInputJournal {
  readonly log: WorldChatStore;
  constructor(private readonly world: InputWorld, readonly conversationId: ConversationId,
    private readonly now: () => string = () => new Date().toISOString()) {
    this.log = new WorldChatStore(conversationDir(world.dir, conversationId));
  }

  async read(): Promise<WorldChatInputQueue> {
    const { events, problems } = await this.log.read();
    const folded = foldWorldChatInputs(events);
    if (problems.length || folded.problems.length) throw new WorldChatInputError("integrity", "This conversation's input history needs repair.");
    return folded.queue;
  }

  record(raw: WorldChatInputRequest, capture: { routing: WorldChatInputRouting; constraints: WorldChatInputRecord["constraints"] }): Promise<InputJournalReceipt> {
    const request = WorldChatInputRequestSchema.parse(raw);
    const routing = WorldChatInputRoutingSchema.parse(capture.routing);
    const constraints = WorldChatInputConstraintsSchema.parse(capture.constraints);
    return this.change(`record:${request.submissionId}`, request, ({ events, at }) => {
      const view = foldConversation(this.conversationId, at, events, { messageLimit: Number.MAX_SAFE_INTEGER }).view;
      if (view.status !== "open") throw new WorldChatInputError("unavailable", "Restore or reopen this conversation before adding a message.");
      if ((request.subject !== undefined && stableJson(request.subject) !== stableJson(constraints.subject)) ||
        (request.replyOnly !== undefined && request.replyOnly !== constraints.replyOnly)) {
        throw new WorldChatInputError("conflict", "The captured constraints do not match this message.");
      }
      const attachments = request.attachmentIds.map(id => {
        const attachment = view.attachments.find(one => one.id === id);
        if (!attachment) throw new WorldChatInputError("unavailable", "An attachment is no longer in this conversation.");
        return { id, contentHash: attachment.contentHash };
      });
      return { type: "input.recorded", input: { messageId: newId("msg"), request, createdAt: at,
        routing, constraints, attachments } };
    });
  }

  pause(reason: WorldChatInputPauseReason, operationId: string): Promise<InputJournalReceipt> {
    return this.change(`control:${operationId}`, { kind: "pause", reason }, () => ({ type: "input-queue.paused", reason }));
  }

  continue(expectedRevision: number, routing: WorldChatInputRouting, operationId: string): Promise<InputJournalReceipt> {
    const capturedRouting = WorldChatInputRoutingSchema.parse(routing);
    return this.change(`control:${operationId}`, { kind: "continue", expectedRevision, routing: capturedRouting }, ({ queue, events }) => {
      this.expectRevision(queue, expectedRevision);
      if (foldWorldChatInputs(events).running.size > 0) throw new WorldChatInputError("unavailable", "Wait for the active reply to settle before continuing.");
      const view = foldConversation(this.conversationId, this.now(), events).view;
      if (view.status !== "open") throw new WorldChatInputError("unavailable", "Restore this conversation before continuing.");
      return { type: "input-queue.resumed", routing: capturedRouting };
    });
  }

  remove(messageId: string, expectedRevision: number, operationId: string): Promise<InputJournalReceipt> {
    return this.change(`control:${operationId}`, { kind: "remove", messageId, expectedRevision }, ({ queue }) => {
      this.expectRevision(queue, expectedRevision);
      return { type: "input.removed", messageId };
    });
  }

  offer(messageId: string, expectedRevision: number, attempt: WorldChatInputAttempt, operationId: string): Promise<InputJournalReceipt> {
    const capturedAttempt = WorldChatInputAttemptSchema.parse(attempt);
    return this.change(`native:${operationId}`, { kind: "offer", messageId, expectedRevision, attempt: capturedAttempt }, ({ queue }) => {
      this.expectRevision(queue, expectedRevision);
      return { type: "input.offer-started", messageId, attempt: capturedAttempt };
    });
  }

  settle(input: { messageId: string; attempt: WorldChatInputAttempt; operationId: string } & (
    { status: "accepted" | "not-delivered" | "delivery-unknown" } | { status: "included"; boundary: string }
  )): Promise<InputJournalReceipt> {
    const captured = structuredClone(input);
    return this.change(`native:${captured.operationId}`, captured, () => captured.status === "included"
      ? { type: "input.included", messageId: captured.messageId, attempt: captured.attempt, boundary: captured.boundary }
      : { type: `input.${captured.status}`, messageId: captured.messageId, attempt: captured.attempt });
  }

  promote(messageId: string, expectedRevision: number, run: WorldChatRun,
    routing: WorldChatInputRouting, operationId: string): Promise<InputJournalReceipt> {
    const capturedRun = WorldChatRunSchema.parse(run);
    const capturedRouting = WorldChatInputRoutingSchema.parse(routing);
    return this.change(`promote:${operationId}`, { messageId, expectedRevision, run: capturedRun, routing: capturedRouting }, ({ queue, events }) => {
      this.expectRevision(queue, expectedRevision);
      const row = queue.inputs.find(one => one.input.messageId === messageId);
      if (!row) throw new WorldChatInputError("stale", "That queued message is no longer here.");
      const expected = worldChatInputRouting(queue, row);
      if (stableJson(expected) !== stableJson(capturedRouting) || capturedRun.adapter !== capturedRouting.adapter ||
        (capturedRun.model ?? null) !== capturedRouting.modelId) {
        throw new WorldChatInputError("stale", "The writing engine or model changed. Review the target before continuing.");
      }
      const view = foldConversation(this.conversationId, this.now(), events).view;
      if (view.status !== "open") throw new WorldChatInputError("unavailable", "Restore this conversation before continuing.");
      for (const captured of row.input.attachments) {
        if (!view.attachments.some(one => one.id === captured.id && one.contentHash === captured.contentHash)) {
          throw new WorldChatInputError("stale", "A queued attachment changed. The input was left waiting.");
        }
      }
      return { type: "input.promoted", messageId, turnId: capturedRun.turnId, runId: capturedRun.id, run: capturedRun,
        message: { id: messageId, turnId: capturedRun.turnId, role: "user", text: row.input.request.text,
          attachmentIds: row.input.request.attachmentIds, createdAt: row.input.createdAt },
        constraints: row.input.constraints,
      };
    });
  }

  private expectRevision(queue: WorldChatInputQueue, expected: number): void {
    if (queue.revision !== expected) throw new WorldChatInputError("stale", "The queued messages changed. Look again before continuing.");
  }

  private async change(operationId: string, command: unknown,
    build: (state: { queue: WorldChatInputQueue; events: WorldChatEventEnvelope[]; at: string }) => Change,
  ): Promise<InputJournalReceipt> {
    if (operationId.length > 700 || !/^[a-z-]+:.+$/s.test(operationId)) {
      throw new WorldChatInputError("conflict", "The input operation identity is invalid.");
    }
    const requestId = `world-chat-input:${operationId}`;
    const commandDigest = inputCommandDigest(command);
    if (this.world.closingSignal.aborted) throw new WorldChatInputError("unavailable", "This world closed.");
    // The boundary uses the world's commit queue; ownedWrite uses the same queue, so this must
    // happen before entering it. Ownership is checked again by ownedWrite, including after close.
    await this.world.raiseSchemaBoundary(WORLD_CHAT_INPUT_SCHEMA_VERSION, "world-chat-input");
    return this.world.ownedWrite(async () => {
      for (;;) {
        if (this.world.closingSignal.aborted) throw new WorldChatInputError("unavailable", "This world closed.");
        if (!await this.log.readMeta()) throw new WorldChatInputError("unavailable", "That conversation is no longer here.");
        const { events, problems } = await this.log.read();
        const folded = foldWorldChatInputs(events);
        if (problems.length || folded.problems.length) throw new WorldChatInputError("integrity", "This conversation's input history needs repair.");
        const original = events.find(envelope => envelope.requestId === requestId);
        if (original) {
          if (!isInputEvent(original.event) || original.event.commandDigest !== commandDigest) {
            throw new WorldChatInputError("conflict", "That submission identity was already used for different content.");
          }
          // A prior failed fsync can leave a readable event. Reconfirm durability before issuing
          // a receipt; merely finding the line is not enough to allow a native side effect.
          await this.log.append(original.event, { at: this.now(), requestId });
          return { event: original.event, sequence: original.seq, queue: folded.queue, deduplicated: true };
        }
        const at = this.now();
        const event = WorldChatStoredEventSchema.parse({ ...build({ queue: folded.queue, events, at }),
          queueRevision: folded.queue.revision + 1, commandDigest });
        if (!isInputEvent(event)) throw new WorldChatInputError("integrity", "Expected an input transition.");
        const seq = events.reduce((max, envelope) => Math.max(max, envelope.seq), 0);
        const proposed: WorldChatEventEnvelope = { schemaVersion: 1, seq: seq + 1, eventId: newId("wce"), at, requestId, event };
        const advanced = foldWorldChatInputs([...events, proposed]);
        if (advanced.problems.length) throw new WorldChatInputError("stale", advanced.problems[0]!.detail);
        try {
          const result = await this.log.append(event, { at, requestId, expectedSeq: seq });
          // Non-input writers share the append queue. A sequence conflict repeats preflight;
          // a disk error does not: its outcome may be uncertain and needs an explicit retry.
          if (result.deduplicated) continue;
          return { event, sequence: result.envelope.seq, queue: advanced.queue, deduplicated: false };
        } catch (error) {
          if (error instanceof ConversationSequenceError) continue;
          throw error;
        }
      }
    });
  }
}
