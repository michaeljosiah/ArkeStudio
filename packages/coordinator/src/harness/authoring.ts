import { join } from "node:path";
import type { DomainEvent, HarnessAdapter } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable } from "../world/paths.js";
import type { ProposalManager } from "../gate/proposals.js";
import type { WorldStore } from "../world/store.js";
import type { GrantStore } from "./grants.js";

/**
 * Authoring sessions over proposals (SPEC-005 §2.4): one session, one proposal; cancellable,
 * wall-clock-bounded and token-bounded, every ending stated; and losing the session never
 * costs the proposal — the agent edited real files in the proposal directory, and they stay.
 */

export interface AuthoringOptions {
  /** Builds the opencode.json object written into the session's working directory. */
  buildConfig: (input: { worldQueryUrl?: string }) => Record<string, unknown>;
  agentForPurpose: (purpose: "authoring" | "drafting" | "extraction" | "ask") => string;
  wallClockMs?: number;
  tokenBudget?: number;
}

export interface RunInput {
  worldId: string;
  proposalId: string;
  purpose: "authoring" | "drafting" | "extraction";
  instruction: string;
}

interface ActiveRun {
  sessionId: string;
  cancelled: boolean;
}

const DEFAULT_WALL_CLOCK_MS = 5 * 60_000;
const DEFAULT_TOKEN_BUDGET = 200_000;

export class AuthoringService {
  private readonly runs = new Map<string, ActiveRun>();
  /**
   * Proposal → live session. A session survives its turn so the next instruction continues
   * the same conversation (the agent keeps its context); it is dropped when a turn ends
   * badly, and released when the proposal settles.
   */
  private readonly sessions = new Map<string, string>();

  constructor(
    private readonly adapter: HarnessAdapter,
    private readonly emit: (event: DomainEvent) => void,
    private readonly opts: AuthoringOptions,
  ) {}

  /** Cancel the run bound to a proposal; immediate, and the proposal keeps the work (R-13). */
  async cancel(proposalId: string): Promise<void> {
    const run = this.runs.get(proposalId);
    if (!run) return;
    run.cancelled = true;
    const interrupt = (this.adapter as { interrupt?: (id: string) => Promise<void> }).interrupt;
    if (interrupt) await interrupt.call(this.adapter, run.sessionId).catch(() => {});
  }

  isRunning(proposalId: string): boolean {
    return this.runs.has(proposalId);
  }

  /** The proposal settled (accepted or discarded) — its conversation is over. */
  release(proposalId: string): void {
    this.sessions.delete(proposalId);
  }

  /**
   * Run one agent turn inside a materialised proposal. Resolves when the turn ends — for any
   * reason — having emitted progress and a final status. Never throws for harness failures;
   * failure is a stated status (R-4, D8).
   */
  async run(store: WorldStore, gate: ProposalManager, input: RunInput, worldQueryUrl?: string): Promise<void> {
    const at = () => new Date().toISOString();
    const status = (
      state: "running" | "completed" | "cancelled" | "timeout" | "budget-exceeded" | "failed",
      detail?: string,
    ) =>
      this.emit({
        at: at(),
        type: "authoring.status",
        worldId: input.worldId,
        proposalId: input.proposalId,
        status: state,
        ...(detail !== undefined ? { detail } : {}),
      });
    const progress = (line: string) =>
      this.emit({
        at: at(),
        type: "authoring.progress",
        worldId: input.worldId,
        proposalId: input.proposalId,
        line,
      });

    if (this.runs.has(input.proposalId)) {
      status("failed", "a session is already running on this proposal");
      return;
    }
    if (!this.adapter.readiness().ready) {
      status("failed", this.adapter.readiness().reason ?? "the harness is not ready");
      return;
    }

    const proposalDir = join(store.dir, fromPortable(`.proposals/${input.proposalId}`));

    // Continue the proposal's conversation when a session already lives; otherwise start one.
    let sessionId = this.sessions.get(input.proposalId);
    if (sessionId === undefined) {
      // Studio writes the session's configuration — roster, tool denials, the world-query MCP
      // registration — into the working directory (R-5). Never a credential (R-6).
      await atomicWriteFile(
        join(proposalDir, "opencode.json"),
        JSON.stringify(this.opts.buildConfig(worldQueryUrl ? { worldQueryUrl } : {}), null, 2) + "\n",
      );
      try {
        const session = await this.adapter.createSession({
          purpose: input.purpose,
          cwd: proposalDir,
          agent: this.opts.agentForPurpose(input.purpose),
        });
        sessionId = session.sessionId;
        this.sessions.set(input.proposalId, sessionId);
      } catch (err) {
        status("failed", `could not create a session: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    // The instruction is the user's side of the conversation — on the record before dispatch.
    this.emit({
      at: at(),
      type: "authoring.turn",
      worldId: input.worldId,
      proposalId: input.proposalId,
      role: "user",
      text: input.instruction,
    });

    const run: ActiveRun = { sessionId, cancelled: false };
    this.runs.set(input.proposalId, run);
    status("running");

    const wallClock = this.opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    const tokenBudget = this.opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const abort = new AbortController();
    let ending: { state: "completed" | "cancelled" | "timeout" | "budget-exceeded" | "failed"; detail?: string } | null =
      null;

    const timer = setTimeout(() => {
      ending = { state: "timeout", detail: `hit the ${Math.round(wallClock / 1000)}s wall-clock limit` };
      const interrupt = (this.adapter as { interrupt?: (id: string) => Promise<void> }).interrupt;
      void interrupt?.call(this.adapter, sessionId).catch(() => {});
    }, wallClock);
    timer.unref?.();

    const usage = (this.adapter as { usageTokens?: (id: string) => number }).usageTokens;
    let replyText = "";

    try {
      // Subscribe BEFORE dispatching: registration is eager, so a turn that completes between
      // the dispatch call and the first pull is queued, never lost.
      const events = this.adapter.streamEvents(abort.signal);
      await this.adapter.dispatchAsync({
        sessionId,
        parts: [{ type: "text", text: input.instruction }],
      });

      for await (const event of events) {
        if (!("sessionId" in event) || event.sessionId !== sessionId) continue;
        if (event.type === "tool.activity") {
          progress(event.summary);
        } else if (event.type === "message.delta") {
          // Streaming text is progress enough at coarse grain; avoid flooding.
          replyText = event.text;
        } else if (event.type === "message.completed") {
          replyText = event.text;
          if (!ending) ending = { state: run.cancelled ? "cancelled" : "completed" };
          break;
        } else if (event.type === "session.error") {
          ending = { state: "failed", detail: event.message };
          break;
        } else if (event.type === "session.ended") {
          ending = {
            state: event.reason === "completed" ? "completed" : event.reason === "cancelled" ? "cancelled" : "failed",
            ...(event.detail !== undefined ? { detail: event.detail } : {}),
          };
          break;
        }
        if (usage && usage.call(this.adapter, sessionId) > tokenBudget) {
          ending = { state: "budget-exceeded", detail: `passed the ${tokenBudget.toLocaleString()}-token budget` };
          const interrupt = (this.adapter as { interrupt?: (id: string) => Promise<void> }).interrupt;
          void interrupt?.call(this.adapter, sessionId).catch(() => {});
        }
        if (run.cancelled && !ending) {
          ending = { state: "cancelled", detail: "cancelled by you" };
          break;
        }
      }
    } catch (err) {
      ending = { state: "failed", detail: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      abort.abort();
      this.runs.delete(input.proposalId);
    }

    // Whatever happened, the proposal keeps the agent's work (R-12, D7, D8): refresh its
    // preview from the files as they now stand.
    await gate.refreshPreviewFor(input.proposalId).catch(() => {});
    const final = ending ?? { state: "failed", detail: "the event stream ended unexpectedly" };

    // A turn that ended cleanly keeps its session for the next instruction; any other ending
    // drops it, so the following send starts a fresh conversation rather than a haunted one.
    if (final.state !== "completed") this.sessions.delete(input.proposalId);
    if (replyText.trim().length > 0 && final.state === "completed") {
      this.emit({
        at: at(),
        type: "authoring.turn",
        worldId: input.worldId,
        proposalId: input.proposalId,
        role: "gate",
        text: replyText.trim(),
      });
    }
    status(final.state, final.detail);
  }
}

/** Backstop permission flow (R-16, R-17, D9): remembered grants answer without prompting. */
export async function settlePermission(
  adapter: HarnessAdapter,
  grants: GrantStore,
  emit: (event: DomainEvent) => void,
  request: { permissionId: string; actionClass: string },
): Promise<void> {
  const at = new Date().toISOString();
  if (await grants.covers(request.actionClass)) {
    await adapter.respondToPermission?.({ permissionId: request.permissionId, decision: "always" });
    emit({
      at,
      type: "permission.settled",
      permissionId: request.permissionId,
      decision: "always",
      remembered: true,
    });
    return;
  }
  emit({
    at,
    type: "permission.pending",
    permissionId: request.permissionId,
    actionClass: request.actionClass,
    description: describeActionClass(request.actionClass),
  });
}

/** Harness-internal tool names become Studio language (R-16). */
export function describeActionClass(actionClass: string): string {
  const lower = actionClass.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell")) return "The agent wants to run a shell command";
  if (lower.includes("webfetch") || lower.includes("network") || lower.includes("http"))
    return "The agent wants to reach the network";
  if (lower.includes("edit") || lower.includes("write")) return "The agent wants to edit a file";
  return `The agent wants to use ${actionClass}`;
}
