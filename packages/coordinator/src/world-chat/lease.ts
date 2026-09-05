import { randomBytes } from "node:crypto";
import type { ChatAttachmentId, ConversationId, RunId } from "@arke-studio/contracts";
import { TARGET_READ_TOOL_NAMES } from "./target-tool-catalog.js";

/**
 * Run-scoped read leases over the world (#70 §9.1).
 *
 * The existing world-query server answers every call against whichever store happens to be open
 * when the call arrives. For the authoring agents that is right: they run inside the world the
 * user is looking at, and if it closes their work is over anyway.
 *
 * It is wrong for World Chat. A run outlives a single moment of UI state, so "whichever store is
 * open now" is a moving target. If somebody switches worlds mid-turn, an ambient lookup would
 * quietly answer the Studio's next question out of the *new* world, and the receipts would attest
 * to versions and hashes from a world the conversation was never about. Nothing would look wrong:
 * the answer would be well-formed, the citation would verify, and it would be about the wrong
 * place entirely.
 *
 * So a lease pins the world identity at mint time and every call compares against it. When they
 * disagree the call fails. It never redirects, never falls back to the open world, and never
 * silently degrades to a read of something else.
 */

export type LeaseFailure =
  | "unknown-token"
  | "expired"
  | "run-not-active"
  | "world-changed"
  | "world-closed"
  | "operation-not-allowed"
  | "attachment-not-allowed";

export class LeaseDeniedError extends Error {
  constructor(readonly failure: LeaseFailure) {
    super(REASONS[failure]);
    this.name = "LeaseDeniedError";
  }
}

/**
 * Deliberately incurious wording. These reach a model, and a denial is not a hint to work around:
 * naming the world that *is* open would leak one conversation's context into another's run.
 */
const REASONS: Record<LeaseFailure, string> = {
  "unknown-token": "This lease is not valid.",
  expired: "This lease has expired.",
  "run-not-active": "The run this lease belongs to is no longer active.",
  "world-changed": "The world this lease was issued for is no longer the open world.",
  "world-closed": "No world is open.",
  "operation-not-allowed": "This operation is not available to this lease.",
  "attachment-not-allowed": "That attachment was not selected for this conversation.",
};

export interface QueryLease {
  readonly token: string;
  readonly worldId: string;
  readonly conversationId: ConversationId;
  readonly runId: RunId;
  /** Only these attachments are readable, and only as text (§9.2, §13.2). */
  readonly allowedAttachmentIds: readonly ChatAttachmentId[];
  readonly expiresAt: number;
}

export interface MintOptions {
  worldId: string;
  conversationId: ConversationId;
  runId: RunId;
  allowedAttachmentIds?: readonly ChatAttachmentId[];
  /** Default 30 minutes: comfortably longer than a turn, far shorter than a session. */
  ttlMs?: number;
}

/** The read-only surface a leased caller may reach (§9.2). */
export const LEASED_OPERATIONS = [
  "search_canon",
  "search_sheets",
  "get_entry",
  "get_sheet",
  "list_entities",
  "related",
  "get_attachment_text",
  // Reading a page the person named, kept as an attachment (2026-08-22).
  "fetch_url",
  // The production read (round 3, 2026-08-22): a read like the others — no write it could reach.
  "get_production",
  ...TARGET_READ_TOOL_NAMES,
] as const;

export type LeasedOperation = (typeof LEASED_OPERATIONS)[number];

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class QueryLeaseRegistry {
  private readonly leases = new Map<string, QueryLease>();

  constructor(
    /** The world open right now, or null. Compared against the lease; never substituted for it. */
    private readonly openWorldId: () => string | null,
    private readonly now: () => number = () => Date.now(),
    /**
     * Whether a run is still going. Revocation is the real mechanism, so in practice this agrees
     * with the registry; it is here because the one failure that matters is a *missed* revoke, and
     * a lease that outlives its run is exactly the thing that must not keep reading the world.
     */
    private readonly isRunActive: (runId: RunId) => boolean = () => true,
  ) {}

  mint(options: MintOptions): QueryLease {
    const lease: QueryLease = {
      token: randomBytes(32).toString("hex"),
      worldId: options.worldId,
      conversationId: options.conversationId,
      runId: options.runId,
      allowedAttachmentIds: [...(options.allowedAttachmentIds ?? [])],
      expiresAt: this.now() + (options.ttlMs ?? DEFAULT_TTL_MS),
    };
    this.leases.set(lease.token, lease);
    return lease;
  }

  /**
   * Resolve a token to its lease, or explain why not.
   *
   * The world comparison is the point of the whole module: a lease is for one world, and if that
   * world is not the open one the answer is refusal, not redirection.
   */
  verify(token: string, operation?: string): QueryLease {
    const lease = this.leases.get(token);
    if (!lease) throw new LeaseDeniedError("unknown-token");
    if (this.now() >= lease.expiresAt) {
      this.leases.delete(token);
      throw new LeaseDeniedError("expired");
    }
    if (!this.isRunActive(lease.runId)) {
      this.leases.delete(token);
      throw new LeaseDeniedError("run-not-active");
    }

    const open = this.openWorldId();
    if (open === null) throw new LeaseDeniedError("world-closed");
    if (open !== lease.worldId) throw new LeaseDeniedError("world-changed");

    if (operation !== undefined && !LEASED_OPERATIONS.includes(operation as LeasedOperation)) {
      throw new LeaseDeniedError("operation-not-allowed");
    }
    return lease;
  }

  /**
   * Let this run read something it just made itself (2026-08-22).
   *
   * The allow-list exists so a run cannot reach documents belonging to another conversation. A
   * page this same run fetched is not that: it came into being inside the run, on this
   * conversation, at the model's own request. Without the grant the studio could read a page and
   * then be refused its own text, which is a rule protecting nobody.
   *
   * Scoped to the live lease, so it dies with the run like everything else here.
   */
  allowAttachment(lease: QueryLease, attachmentId: string): void {
    const allowed = lease.allowedAttachmentIds as ChatAttachmentId[];
    if (!allowed.includes(attachmentId as ChatAttachmentId)) allowed.push(attachmentId as ChatAttachmentId);
  }

  /** Attachment reads are allow-listed per run, not per world (§9.1, §13.2). */
  assertAttachmentAllowed(lease: QueryLease, attachmentId: string): void {
    if (!lease.allowedAttachmentIds.includes(attachmentId as ChatAttachmentId)) {
      throw new LeaseDeniedError("attachment-not-allowed");
    }
  }

  /** Called when a run reaches any terminal state, including cancellation and interruption. */
  revokeRun(runId: RunId): void {
    for (const [token, lease] of this.leases) {
      if (lease.runId === runId) this.leases.delete(token);
    }
  }

  revokeConversation(conversationId: ConversationId): void {
    for (const [token, lease] of this.leases) {
      if (lease.conversationId === conversationId) this.leases.delete(token);
    }
  }

  /**
   * Closing or switching the world drops every lease.
   *
   * `verify` would already refuse on the world comparison, so this is belt to that braces. It
   * matters because it makes the refusal permanent: without it, switching away and back would
   * bring a stale lease back to life.
   */
  revokeAll(): void {
    this.leases.clear();
  }

  /** Drops expired leases. Verification is authoritative; this just keeps the map from growing. */
  sweep(): number {
    const at = this.now();
    let dropped = 0;
    for (const [token, lease] of this.leases) {
      if (at >= lease.expiresAt) {
        this.leases.delete(token);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.leases.size;
  }
}
