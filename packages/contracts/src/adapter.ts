import { z } from "zod";

/**
 * The harness adapter interface, adopted from Arke (master spec §1.4, §17).
 *
 * Arke Studio drives one harness — OpenCode v2, headless — but targets this interface so the
 * harness is replaceable and so the mock behind SPEC-001 and the live server behind SPEC-005
 * are indistinguishable to the coordinator. Capabilities are probed from the live server's
 * OpenAPI document at init, never hard-coded to a version.
 */

/** Capability flags an adapter advertises. Callers check before invoking gated methods. */
export const HarnessCapability = z.enum([
  "events", // streamEvents()
  "models", // listModels() — the backend exposes a model catalog
  "permissions", // respondToPermission()
]);
export type HarnessCapability = z.infer<typeof HarnessCapability>;

export interface SessionRef {
  sessionId: string;
}

/** What a session is for — selects the agent configuration and the confinement posture (§17.1). */
export const SessionPurpose = z.enum(["authoring", "drafting", "extraction", "ask", "art-prompt", "world-chat"]);
export type SessionPurpose = z.infer<typeof SessionPurpose>;

export interface CreateSessionInput {
  purpose: SessionPurpose;
  /**
   * The working directory the session runs in — for authoring, the proposal directory, never
   * the world root (SPEC-005). Absolute path; the adapter scopes every request to it.
   */
  cwd?: string;
  /** Named agent from the application-owned roster, e.g. "sheet-editor" (SPEC-005 R-8). */
  agent?: string;
  /** Parent session id, when a session is a follow-up of another. */
  parent?: string;
  title?: string;
}

export interface MessagePart {
  type: "text";
  text: string;
}

export interface SendMessageInput {
  sessionId: string;
  parts: MessagePart[];
  /**
   * Caller-supplied correlation id so later events attribute to the originating request.
   * If omitted, the adapter generates one and returns it on the receipt.
   */
  correlationId?: string;
}

/** Receipt for a send/dispatch: the session it ran on and the correlation id used. */
export interface SendReceipt {
  sessionId: string;
  correlationId: string;
}

/** Whether the adapter is ready to serve, with a stated reason when it is not. */
export interface Readiness {
  ready: boolean;
  reason?: string;
}

/** One model in the harness backend's live catalog (capability: models). */
export interface ModelInfo {
  id: string;
  provider: string;
  displayName?: string;
  /** The model this provider would use if nobody chose — shown first, marked as such. */
  isDefault?: boolean;
}

export const PermissionVerb = z.enum(["once", "always", "reject"]);
export type PermissionVerb = z.infer<typeof PermissionVerb>;

export interface PermissionDecision {
  permissionId: string;
  decision: PermissionVerb;
  message?: string;
}

/**
 * The outcome of relaying a permission decision. Success is confirmed only by the matching
 * `permission.replied` event, never inferred from HTTP status.
 */
export const PermissionAckStatus = z.enum(["confirmed", "unconfirmed", "stale", "duplicate"]);
export type PermissionAckStatus = z.infer<typeof PermissionAckStatus>;

export interface PermissionAck {
  permissionId: string;
  status: PermissionAckStatus;
}

// ---------------------------------------------------------------------------
// Normalised harness events — validated at the adapter boundary (SPEC-001 R-2).
// ---------------------------------------------------------------------------

export const HarnessEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.created"), sessionId: z.string() }).strict(),
  z
    .object({
      type: z.literal("message.delta"),
      sessionId: z.string(),
      correlationId: z.string().optional(),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("message.completed"),
      sessionId: z.string(),
      correlationId: z.string().optional(),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("permission.requested"),
      sessionId: z.string(),
      permissionId: z.string(),
      actionClass: z.string(),
      detail: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("permission.replied"),
      sessionId: z.string(),
      permissionId: z.string(),
      decision: PermissionVerb,
    })
    .strict(),
  z
    .object({
      type: z.literal("session.error"),
      sessionId: z.string().optional(),
      message: z.string(),
    })
    .strict(),
  /** Tool activity in the product's own language — what makes grounding visible (SPEC-005 R-15). */
  z
    .object({
      type: z.literal("tool.activity"),
      sessionId: z.string(),
      tool: z.string(),
      /** Human line, e.g. "checked canon: CANON-002, CANON-007". */
      summary: z.string(),
    })
    .strict(),
  /** A session ended — always with a stated reason, never silently (SPEC-005 R-13). */
  z
    .object({
      type: z.literal("session.ended"),
      sessionId: z.string(),
      reason: z.enum(["completed", "cancelled", "timeout", "budget-exceeded", "error"]),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;

/**
 * One interface, mock or live. Methods beyond the core set are gated by the capabilities the
 * adapter reports.
 */
export interface HarnessAdapter {
  /** Stable identifier, e.g. "opencode" | "mock". */
  readonly id: string;
  /** What this adapter supports; determined by probing the live server at init, not hard-coded. */
  capabilities(): ReadonlySet<HarnessCapability>;

  // ---- lifecycle ----
  /** Probe the server, derive capabilities, build initial state. Idempotent. */
  init?(): Promise<void>;
  readiness(): Readiness;
  /** Stop anything the adapter started. SHALL NOT stop a server it did not start. */
  dispose?(): Promise<void>;

  // ---- core ----
  createSession(input: CreateSessionInput): Promise<SessionRef>;
  /** Synchronous send: resolves when the turn completes. */
  sendMessage(input: SendMessageInput): Promise<SendReceipt>;
  /** Fire-and-watch: must not block while the turn runs. */
  dispatchAsync(input: SendMessageInput): Promise<SendReceipt>;

  // ---- gated ----
  /** Async iterator of normalised, schema-validated harness events (capability: events). */
  streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent>;
  listModels?(): Promise<ModelInfo[]>;
  respondToPermission?(decision: PermissionDecision): Promise<PermissionAck>;
}
