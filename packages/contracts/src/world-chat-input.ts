import { z } from "zod";
import { WorldChatSubjectSchema } from "./editor-request.js";
import { ChatAttachmentIdSchema, IsoDateTimeSchema, MessageIdSchema, RunIdSchema, Sha256Schema, TurnIdSchema } from "./ids.js";

/**
 * Additional conversation input (SPEC-045, issue 1138): a message an author submits while a reply
 * is running, or explicitly for the next reply.
 *
 * Inputs exist before they belong to a turn. The strict transcript message requires a turn id, and
 * inventing one to store a queue row would corrupt history, so an input is its own record until it
 * is promoted to a primary turn or confirmed as included in a running one.
 */
export const WORLD_CHAT_INPUT_BOUNDS = { text: 16_000, attachments: 20, unresolved: 10, settled: 10 } as const;
/**
 * The world boundary raised before the first input event is written (SPEC-045 R-27). A build that
 * predates these events reads the conversation log tolerantly and would skip them — losing queued
 * words and their restrictions — so the world refuses that build by name instead. Everything up
 * to 43 is claimed on main; this is the next number clear of them.
 */
export const WORLD_CHAT_INPUT_SCHEMA_VERSION = 44;

export const WorldChatInputRequestSchema = z.object({
  submissionId: z.string().min(1).max(200),
  text: z.string().min(1).max(WORLD_CHAT_INPUT_BOUNDS.text).refine(text => text.trim().length > 0),
  attachmentIds: z.array(ChatAttachmentIdSchema).max(WORLD_CHAT_INPUT_BOUNDS.attachments).default([]),
  delivery: z.enum(["current", "next"]),
  expectedRunId: RunIdSchema.nullable(),
  subject: WorldChatSubjectSchema.optional(),
  replyOnly: z.boolean().optional(),
  modelId: z.string().min(1).max(200).optional(),
}).strict();
export type WorldChatInputRequest = z.infer<typeof WorldChatInputRequestSchema>;

/** Captured routing is the policy/configuration fingerprint, never credentials or paths. */
export const WorldChatInputRoutingSchema = z.object({
  adapter: z.string().min(1).max(100),
  modelId: z.string().min(1).max(200).nullable(),
  fingerprint: Sha256Schema,
}).strict();
export type WorldChatInputRouting = z.infer<typeof WorldChatInputRoutingSchema>;

export const WorldChatInputConstraintsSchema = z.object({
  subject: WorldChatSubjectSchema.optional(),
  replyOnly: z.boolean(),
}).strict();
export type WorldChatInputConstraints = z.infer<typeof WorldChatInputConstraintsSchema>;

export const WorldChatInputRecordSchema = z.object({
  messageId: MessageIdSchema,
  request: WorldChatInputRequestSchema,
  createdAt: IsoDateTimeSchema,
  routing: WorldChatInputRoutingSchema,
  constraints: WorldChatInputConstraintsSchema,
  attachments: z.array(z.object({ id: ChatAttachmentIdSchema, contentHash: Sha256Schema }).strict())
    .max(WORLD_CHAT_INPUT_BOUNDS.attachments),
}).strict();
export type WorldChatInputRecord = z.infer<typeof WorldChatInputRecordSchema>;

/** A structured-result repair is a different attempt even when the engine reuses its session. */
export const WorldChatInputAttemptSchema = z.object({
  runId: RunIdSchema,
  turnId: TurnIdSchema,
  ordinal: z.number().int().min(1),
  sessionId: z.string().min(1).max(500),
  executionId: z.string().min(1).max(500),
  inputId: z.string().min(1).max(500),
  directionRevision: z.number().int().min(1),
}).strict();
export type WorldChatInputAttempt = z.infer<typeof WorldChatInputAttemptSchema>;

export const WorldChatInputPauseReasonSchema = z.enum([
  "stopped", "failed", "timeout", "budget-exceeded", "restart", "world-closed", "ownership-lost",
  "archived", "unavailable", "routing-changed", "delivery-unknown", "integrity",
]);
export type WorldChatInputPauseReason = z.infer<typeof WorldChatInputPauseReasonSchema>;

const transition = {
  queueRevision: z.number().int().min(1),
  /** Hash of the original command: a replayed request id cannot carry different content. */
  commandDigest: Sha256Schema,
};
const disposition = { ...transition, messageId: MessageIdSchema, attempt: WorldChatInputAttemptSchema };

export const WorldChatInputEventSchemas = [
  z.object({ type: z.literal("input.recorded"), ...transition, input: WorldChatInputRecordSchema }).strict(),
  z.object({ type: z.literal("input.offer-started"), ...disposition }).strict(),
  z.object({ type: z.literal("input.accepted"), ...disposition }).strict(),
  z.object({ type: z.literal("input.included"), ...disposition,
    /** Engine-owned evidence of model-input inclusion, never an assistant quotation. */
    boundary: z.string().min(1).max(500),
  }).strict(),
  z.object({ type: z.literal("input.not-delivered"), ...disposition }).strict(),
  z.object({ type: z.literal("input.delivery-unknown"), ...disposition }).strict(),
  z.object({ type: z.literal("input.removed"), ...transition, messageId: MessageIdSchema }).strict(),
  z.object({ type: z.literal("input-queue.paused"), ...transition, reason: WorldChatInputPauseReasonSchema }).strict(),
  z.object({ type: z.literal("input-queue.resumed"), ...transition, routing: WorldChatInputRoutingSchema }).strict(),
] as const;
export const WorldChatInputEventSchema = z.discriminatedUnion("type", WorldChatInputEventSchemas);
export type WorldChatInputEvent = z.infer<typeof WorldChatInputEventSchema>;

/** The persisted event also carries the primary message and run, in one record (world-chat.ts). */
export const WorldChatInputPromotionSchema = z.object({
  type: z.literal("input.promoted"), ...transition,
  messageId: MessageIdSchema, turnId: TurnIdSchema, runId: RunIdSchema,
}).strict();
export type WorldChatInputPromotion = z.infer<typeof WorldChatInputPromotionSchema>;

export const WorldChatInputStateSchema = z.object({
  input: WorldChatInputRecordSchema,
  sequence: z.number().int().min(1),
  settledSequence: z.number().int().min(1).optional(),
  status: z.enum(["queued", "offering", "accepted", "included", "uncertain", "promoted", "removed"]),
  /** Kept after non-delivery: an offered input can never be represented as never sent. */
  attempt: WorldChatInputAttemptSchema.optional(),
  boundary: z.string().min(1).max(500).optional(),
  turnId: TurnIdSchema.optional(),
  runId: RunIdSchema.optional(),
}).strict();
export type WorldChatInputState = z.infer<typeof WorldChatInputStateSchema>;

export const WorldChatInputQueueSchema = z.object({
  revision: z.number().int().min(0),
  inputs: z.array(WorldChatInputStateSchema),
  pauseReason: WorldChatInputPauseReasonSchema.nullable(),
  /** Continue approves this route for the inputs present when it was pressed, and no others. */
  continued: z.object({ throughSequence: z.number().int().min(0), routing: WorldChatInputRoutingSchema }).strict().optional(),
}).strict();
export type WorldChatInputQueue = z.infer<typeof WorldChatInputQueueSchema>;

/** Snapshots carry author-facing state; native session and execution ids stay in the log. */
export const WorldChatInputQueueViewSchema = z.object({
  revision: z.number().int().min(0),
  pauseReason: WorldChatInputPauseReasonSchema.nullable(),
  inputs: z.array(WorldChatInputStateSchema.omit({ attempt: true, boundary: true, settledSequence: true }).extend({
    removable: z.boolean(),
  })),
}).strict();
export type WorldChatInputQueueView = z.infer<typeof WorldChatInputQueueViewSchema>;

export function emptyWorldChatInputQueue(): WorldChatInputQueue {
  return { revision: 0, inputs: [], pauseReason: null };
}

export function unresolvedWorldChatInputs(queue: WorldChatInputQueue): WorldChatInputState[] {
  return queue.inputs.filter(row => !["included", "promoted", "removed"].includes(row.status));
}

/**
 * Every unresolved input, plus the most recently settled few. Settled rows are ordered by when
 * they settled rather than when they were submitted, so an old input that settles last is not
 * pushed out of the window by newer ones removed before it.
 */
export function projectWorldChatInputQueue(queue: WorldChatInputQueue): WorldChatInputQueueView {
  const pending = new Set(unresolvedWorldChatInputs(queue));
  const recent = new Set(queue.inputs.filter(row => !pending.has(row))
    .sort((a, b) => (b.settledSequence ?? b.sequence) - (a.settledSequence ?? a.sequence))
    .slice(0, WORLD_CHAT_INPUT_BOUNDS.settled));
  return {
    revision: queue.revision,
    pauseReason: queue.pauseReason,
    inputs: queue.inputs.filter(row => pending.has(row) || recent.has(row))
      .map(({ attempt, boundary: _boundary, settledSequence: _settled, ...row }) => ({
        ...row, removable: row.status === "queued" && attempt === undefined,
      })),
  };
}

export function worldChatInputRouting(queue: WorldChatInputQueue, row: WorldChatInputState): WorldChatInputRouting {
  return queue.continued && row.sequence <= queue.continued.throughSequence
    ? queue.continued.routing : row.input.routing;
}

function sameAttempt(a: WorldChatInputAttempt | undefined, b: WorldChatInputAttempt): boolean {
  return a !== undefined && a.runId === b.runId && a.turnId === b.turnId && a.ordinal === b.ordinal &&
    a.sessionId === b.sessionId && a.executionId === b.executionId && a.inputId === b.inputId &&
    a.directionRevision === b.directionRevision;
}

/**
 * The pure transition rules, shared by the journal and by replay. History that breaks them marks
 * the queue as needing repair, and a queue in that state accepts nothing further: invalid history
 * must never be what enables a dispatch.
 */
export function advanceWorldChatInputQueue(
  queue: WorldChatInputQueue,
  event: WorldChatInputEvent | WorldChatInputPromotion,
  sequence: number,
): { queue: WorldChatInputQueue; problem?: string } {
  const refuse = (problem: string) => ({ queue: { ...queue, pauseReason: "integrity" as const }, problem });
  if (queue.pauseReason === "integrity") return refuse("The input history needs repair before it can change.");
  if (event.queueRevision !== queue.revision + 1) return refuse("The input queue revision is not consecutive.");
  const next = { ...queue, revision: event.queueRevision };
  const pending = unresolvedWorldChatInputs(queue);
  if (event.type === "input.recorded") {
    if (queue.inputs.some(row => row.input.messageId === event.input.messageId ||
      row.input.request.submissionId === event.input.request.submissionId)) return refuse("An input identity was recorded twice.");
    if (pending.length >= WORLD_CHAT_INPUT_BOUNDS.unresolved) return refuse("The input queue is full.");
    return { queue: { ...next, inputs: [...queue.inputs, { input: event.input, sequence, status: "queued" }] } };
  }
  if (event.type === "input-queue.paused") return { queue: { ...next, pauseReason: event.reason } };
  if (event.type === "input-queue.resumed") {
    if (pending.some(row => ["offering", "accepted", "uncertain"].includes(row.status))) {
      return refuse("Native input delivery must be settled before continuing.");
    }
    return { queue: { ...next, pauseReason: null,
      continued: { throughSequence: Math.max(0, ...queue.inputs.map(row => row.sequence)), routing: event.routing } } };
  }
  const row = queue.inputs.find(one => one.input.messageId === event.messageId);
  if (!row) return refuse("An input transition names an unknown message.");
  let changed: WorldChatInputState;
  switch (event.type) {
    case "input.offer-started":
      if (queue.pauseReason || pending[0] !== row || row.status !== "queued" || row.attempt) {
        return refuse("Only the oldest never-offered input may be offered while the queue is running.");
      }
      if (row.input.request.delivery !== "current" || row.input.request.expectedRunId !== event.attempt.runId) {
        return refuse("A native offer must target the run selected by this input.");
      }
      if (queue.inputs.some(one => one.attempt?.sessionId === event.attempt.sessionId &&
        one.attempt.executionId === event.attempt.executionId && one.attempt.inputId === event.attempt.inputId)) {
        return refuse("A native input identity cannot be offered for a second message.");
      }
      if (event.attempt.directionRevision !== 1 + Math.max(0, ...queue.inputs.flatMap(one =>
        one.attempt?.runId === event.attempt.runId ? [one.attempt.directionRevision] : []))) {
        return refuse("The native direction revision is not consecutive for this run.");
      }
      changed = { ...row, status: "offering", attempt: event.attempt };
      break;
    case "input.accepted":
    case "input.included":
    case "input.not-delivered":
    case "input.delivery-unknown":
      if (!sameAttempt(row.attempt, event.attempt) || !["offering", "accepted", "uncertain"].includes(row.status)) {
        return refuse("The delivery result does not belong to this unresolved native attempt.");
      }
      if (event.type === "input.accepted" && row.status !== "offering") {
        return refuse("Acceptance cannot settle or rewind an uncertain delivery.");
      }
      changed = { ...row, status: event.type === "input.included" ? "included" :
        event.type === "input.not-delivered" ? "queued" : event.type === "input.accepted" ? "accepted" : "uncertain",
        ...(event.type === "input.included"
          ? { boundary: event.boundary, turnId: event.attempt.turnId, runId: event.attempt.runId, settledSequence: sequence }
          : {}),
      };
      if (event.type === "input.delivery-unknown") next.pauseReason = "delivery-unknown";
      break;
    case "input.removed":
      if (row.status !== "queued" || row.attempt) return refuse("Only a never-offered queued input can be removed.");
      changed = { ...row, status: "removed", settledSequence: sequence };
      break;
    case "input.promoted":
      if (queue.pauseReason || pending[0] !== row || row.status !== "queued") {
        return refuse("Only the oldest queued input may start the next turn while the queue is running.");
      }
      changed = { ...row, status: "promoted", turnId: event.turnId, runId: event.runId, settledSequence: sequence };
      break;
  }
  return { queue: { ...next, inputs: queue.inputs.map(one => one === row ? changed : one) } };
}
