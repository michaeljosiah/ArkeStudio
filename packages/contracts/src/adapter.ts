import { z } from "zod";
import type { SessionConfigInput } from "./agent-session.js";
import type { VendorIntegration } from "./vendor-auth.js";

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
  "auth", // vendor sign-in over the harness's API (SPEC-030)
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
  /** The one-use preparation returned by the coordinator's session-file step. */
  preparationId?: string;
  /** Bounds session creation; adapters SHALL pass it to every request on the creation path. */
  signal?: AbortSignal;
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

/** A harness permission ask, retaining the session whose confinement governs it. */
export interface PermissionRequest {
  sessionId: string;
  permissionId: string;
  actionClass: string;
  detail?: string;
}

/** Whether the active session policy permits a remembered grant to settle this ask. */
export type PermissionAssessment =
  | { status: "allowed" }
  | { status: "ask" }
  | { status: "denied"; reason: string };

export interface PermissionDecision {
  permissionId: string;
  decision: PermissionVerb;
  message?: string;
}

/**
 * The outcome of relaying a permission decision. Success is confirmed only by the matching
 * `permission.replied` event, never inferred from HTTP status.
 */
export const PermissionAckStatus = z.enum(["confirmed", "unconfirmed", "failed", "stale", "duplicate"]);
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
  /**
   * A tool call the confinement refused. Nothing happened (SPEC-005 R-10b).
   *
   * Separate from `tool.activity` rather than a flag on it, because the two mean opposite things
   * and one consumer already treats activity as a progress verb: rendered as one, a refusal reads
   * as work in progress — the studio appearing to do the very thing it just declined. It is also
   * the only event here that is worth keeping after the turn ends. An agent that reports running
   * a command it never ran is contradicted by nothing on the screen unless this is on it (#506).
   *
   * `summary` is the adapter's own wording and is for the trace, not the screen: it names the
   * harness's tool (R-16 forbids that) and a refusal is not a receipt (#70 R-18). What a person
   * is shown is worded from `tool` by the coordinator, in the product's language.
   */
  z
    .object({
      type: z.literal("tool.refused"),
      sessionId: z.string(),
      tool: z.string(),
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

/** One file a harness wants beside the work, named relative to the session directory. */
export interface SessionFile {
  name: string;
  contents: string;
}

// ---------------------------------------------------------------------------
// Vendor sign-in (SPEC-030) — gated by the "auth" capability.
// ---------------------------------------------------------------------------

/**
 * A sign-in attempt the harness has opened with a vendor. Arke opens `url` and shows
 * `instructions` verbatim; the harness completes the exchange itself when the mode is `auto`,
 * and takes a person-typed code through `completeVendorOAuth` when it is `code` (§2.2).
 */
export interface VendorOAuthAttempt {
  attemptId: string;
  url: string;
  instructions: string;
  mode: "auto" | "code";
  /** The harness's own deadline for this attempt, epoch milliseconds. Bounds the poll (R-9b). */
  expiresAt: number;
}

/** Where an attempt stands. Polled, never evented — no event announces completion (R-9b). */
export type VendorOAuthAttemptState =
  | { status: "pending" | "complete" | "expired" }
  | { status: "failed"; message: string };

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

  /**
   * What this harness needs on disk in a session's working directory, before the session opens.
   *
   * OpenCode reads its roster, tool limits and MCP registration from an `opencode.json` written
   * beside the work; Claude Code takes all of that as `query()` options and needs nothing, which
   * it says by returning nothing rather than by leaving an empty file in somebody's proposal.
   *
   * The adapter says WHAT to write and the caller does the writing, deliberately: extended-length
   * paths and atomic replacement are solved once in the coordinator, and an adapter that had to
   * solve them again would solve them differently.
   */
  sessionFiles?(input: SessionConfigInput): ReadonlyArray<SessionFile>;
  /**
   * The same settings, for a harness that takes them as call options rather than as a file.
   *
   * Both hooks exist because `sessionFiles` alone silently excluded one of them. Claude Code
   * registers its MCP servers through `query()` options, so it has nothing to write — and the
   * reading of that was that it "needs nothing", when what it needed was a seam that was not
   * file-shaped. The result was a lane that started, authenticated, ran turns, and answered
   * every question about the world with "I have nothing on that in front of me", because the
   * world-query tool had never been registered. Nothing failed; the agent was simply blind.
   *
   * Called with the same input, immediately before that session's `createSession`.
   */
  prepareSession?(input: SessionConfigInput): void;
  /** Forget a preparation whose file write or caller failed before session creation. */
  abandonSessionPreparation?(preparationId: string): void;

  // ---- core ----
  createSession(input: CreateSessionInput): Promise<SessionRef>;
  /**
   * The input-token window of the model this harness answers with, when it can name one (§8.5).
   *
   * Optional because an adapter may not know, and a caller that cannot find out budgets from a
   * floor instead. Studio does not choose the model — the session config carries no `model` key —
   * so this is the only place the real limit can come from.
   */
  knownInputTokenLimit?(): number | null;
  /** Synchronous send: resolves when the turn completes. */
  sendMessage(input: SendMessageInput): Promise<SendReceipt>;
  /** Fire-and-watch: must not block while the turn runs. */
  dispatchAsync(input: SendMessageInput): Promise<SendReceipt>;
  interrupt?(sessionId: string): Promise<void>;
  usageTokens?(sessionId: string): number;

  // ---- gated ----
  /** Async iterator of normalised, schema-validated harness events (capability: events). */
  streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent>;
  listModels?(): Promise<ModelInfo[]>;
  /** Adapter-owned action vocabulary checked against the exact session's captured confinement. */
  assessPermission?(request: PermissionRequest): PermissionAssessment;
  respondToPermission?(decision: PermissionDecision): Promise<PermissionAck>;

  // ---- vendor sign-in (capability: auth, SPEC-030) ----
  /** Vendors and their sign-in methods, normalised at this boundary, ids and labels verbatim (R-7). */
  listIntegrations?(): Promise<VendorIntegration[]>;
  /** Start an OAuth sign-in. The harness owns the exchange; Arke opens the page and polls (D18). */
  beginVendorOAuth?(integrationId: string, methodId: string, answers?: Record<string, string>): Promise<VendorOAuthAttempt>;
  pollVendorOAuth?(integrationId: string, attemptId: string): Promise<VendorOAuthAttemptState>;
  /** Abandon an attempt, releasing whatever the harness holds for it. Leaves no partial state. */
  cancelVendorOAuth?(integrationId: string, attemptId: string): Promise<void>;
  /** Hand back the one-time code a `code`-mode attempt gave the person. Not retained (R-1). */
  completeVendorOAuth?(integrationId: string, attemptId: string, code: string): Promise<void>;
  /** The typed-secret method: one call, no address, no polling (§2.2). The key is not retained. */
  connectVendorKey?(integrationId: string, key: string, answers?: Record<string, string>): Promise<void>;
  /** Remove a stored connection — the harness's operation, never a file deletion (R-9a, D16). */
  removeVendorCredential?(credentialId: string): Promise<void>;
}
