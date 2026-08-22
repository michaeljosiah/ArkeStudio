import { join } from "node:path";
import { writeSessionFiles, type SessionInput } from "./session-files.js";
import type { DomainEvent, HarnessAdapter } from "@arke-studio/contracts";
import { fromPortable } from "../world/paths.js";
import type { ProposalManager } from "../gate/proposals.js";
import type { WorldStore } from "../world/store.js";
import type { GrantStore } from "./grants.js";
import { sessionTokenBudget } from "./token-budget.js";

/**
 * Authoring sessions over proposals (SPEC-005 §2.4): one session, one proposal; cancellable,
 * wall-clock-bounded and token-bounded, every ending stated; and losing the session never
 * costs the proposal — the agent edited real files in the proposal directory, and they stay.
 */

export interface AuthoringOptions {
  /** Studio's session input, enriched with live Settings; the adapter decides what lands on disk. */
  sessionInput: SessionInput;
  agentForPurpose: (purpose: "authoring" | "drafting" | "extraction" | "ask") => string;
  wallClockMs?: number;
  tokenBudget?: number;
}

export interface RunInput {
  worldId: string;
  proposalId: string;
  purpose: "authoring" | "drafting" | "extraction";
  instruction: string;
  /** Set on the gate's own repair turns, so the transcript attributes them honestly. */
  repairTurn?: boolean;
}

interface ActiveRun {
  sessionId: string;
  cancelled: boolean;
}

/**
 * How long before a turn is called hung rather than slow (§19).
 *
 * It catches a run that will never arrive; it is not there to police work that takes a while.
 * Two things make a generous figure the right one: a person can stop a turn themselves, from the
 * working line where they can see how long it has been going — so the clock is the backstop and
 * not the control — and a turn may now legitimately take far longer than it used to, because the
 * prompt it carries is bounded by the model's window rather than by a fixed character count.
 */
const DEFAULT_WALL_CLOCK_MS = 15 * 60_000;
/**
 * The floor for one proposal's drafting conversation, when no model window can be named.
 *
 * A session lives per proposal and every instruction spends into the same total, so this is a
 * conversation's budget rather than a run's. What replaced the flat figure is beside
 * `sessionTokenBudget`.
 */
const FALLBACK_TOKEN_BUDGET = 200_000;

/**
 * How many times a completed turn may be sent back to repair what it wrote.
 *
 * Two, because the first repair is the common case — a missing comma, a field written as prose
 * where the schema wants an object — and an agent that has failed the same check twice with the
 * error in front of it is not going to be talked into passing it a third time. Past that the
 * proposal stands as it is and the gate refuses it to the person, which is the outcome this
 * exists to make rare rather than to make impossible.
 */
const MAX_REPAIR_TURNS = 2;

/** What the agent is told when what it wrote would be refused. */
function repairInstruction(problems: Array<{ path: string; message: string }>): string {
  const lines = problems.map((p) => `- ${p.path}: ${p.message}`).join("\n");
  return `The file you just wrote cannot be accepted as it stands:\n${lines}\n\nOpen it, fix exactly what is named above, and leave everything else as you wrote it. Do not restructure the draft, do not touch any other file, and reply with nothing but what you changed.`;
}

export class AuthoringService {
  private readonly runs = new Map<string, ActiveRun>();
  /**
   * Proposal → live session. A session survives its turn so the next instruction continues
   * the same conversation (the agent keeps its context); it is dropped when a turn ends
   * badly, and released when the proposal settles.
   */
  private readonly sessions = new Map<string, string>();
  /**
   * Proposal → repair turns already spent. Counted per proposal rather than per run because the
   * budget belongs to the draft: a second instruction on the same proposal is the same
   * conversation, and letting it reset the count would make the bound meaningless.
   */
  private readonly repairs = new Map<string, number>();
  /** Proposals whose Stop arrived between a run ending and its repair starting. */
  private readonly cancelledRepairs = new Set<string>();

  constructor(
    private readonly adapter: HarnessAdapter,
    private readonly emit: (event: DomainEvent) => void,
    private readonly opts: AuthoringOptions,
  ) {}

  /** Cancel the run bound to a proposal; immediate, and the proposal keeps the work (R-13). */
  async cancel(proposalId: string): Promise<void> {
    // Even with no live run: a Stop can land in the gap between a run ending and its repair
    // turn starting, and the repair must honour it (review 2026-08-22).
    this.cancelledRepairs.add(proposalId);
    const run = this.runs.get(proposalId);
    if (!run) return;
    run.cancelled = true;
    const interrupt = (this.adapter as { interrupt?: (id: string) => Promise<void> }).interrupt;
    if (interrupt) await interrupt.call(this.adapter, run.sessionId).catch(() => {});
  }

  isRunning(proposalId: string): boolean {
    return this.runs.has(proposalId);
  }

  /**
   * Every proposal with a turn in flight, for the snapshot (issue 239).
   *
   * The runs map is the only thing that knows this: the proposal directory looks the same
   * whether an agent is filling it or abandoned it, so a client that reloads mid-draft has no
   * way to learn it from the world.
   */
  liveRuns(): string[] {
    return [...this.runs.keys()];
  }

  /** The proposal settled (accepted or discarded) — its conversation is over. */
  release(proposalId: string): void {
    this.sessions.delete(proposalId);
    this.repairs.delete(proposalId);
    this.cancelledRepairs.delete(proposalId);
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
    // A fresh instruction supersedes a stale Stop — without this, one cancelled turn would
    // silently disable the repair loop for the proposal's whole remaining life.
    if (input.repairTurn !== true) this.cancelledRepairs.delete(input.proposalId);

    const proposalDir = join(store.dir, fromPortable(`.proposals/${input.proposalId}`));

    // Continue the proposal's conversation when a session already lives; otherwise start one.
    let sessionId = this.sessions.get(input.proposalId);
    if (sessionId === undefined) {
      // Studio writes the session's configuration — roster, tool denials, the world-query MCP
      // registration — into the working directory (R-5). Never a credential (R-6).
      await writeSessionFiles(this.adapter, proposalDir, this.opts.sessionInput(worldQueryUrl ? { worldQueryUrl } : {}));
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

    /*
     * The instruction goes on the record before dispatch. A repair turn is the gate's words,
     * not the person's (review 2026-08-22): attributing machine-generated diagnostics to the
     * user put a paragraph they never typed into their own transcript.
     */
    this.emit({
      at: at(),
      type: "authoring.turn",
      worldId: input.worldId,
      proposalId: input.proposalId,
      role: input.repairTurn === true ? "gate" : "user",
      text: input.instruction,
    });

    const run: ActiveRun = { sessionId, cancelled: false };
    this.runs.set(input.proposalId, run);
    status("running");

    const wallClock = this.opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    const tokenBudget =
      this.opts.tokenBudget ??
      sessionTokenBudget(this.adapter.knownInputTokenLimit?.(), FALLBACK_TOKEN_BUDGET);
    const abort = new AbortController();
    let ending: { state: "completed" | "cancelled" | "timeout" | "budget-exceeded" | "failed"; detail?: string } | null =
      null;

    const timer = setTimeout(() => {
      ending = { state: "timeout", detail: `hit the ${Math.round(wallClock / 1000)}s wall-clock limit` };
      const interrupt = (this.adapter as { interrupt?: (id: string) => Promise<void> }).interrupt;
      void interrupt?.call(this.adapter, sessionId).catch(() => {});
      // And end the wait ourselves — see GenesisService: a session with nothing running
      // answers an interrupt with silence, and a deadline that waits for a reply is not one.
      abort.abort();
    }, wallClock);
    // NOT unref'd: a run parked on the event stream has nothing else pending, so an unref'd
    // deadline lets the loop drain and never fires — the run then waits forever. `finally`
    // clears it, so it holds the process open only while the run it guards is alive.

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

    /*
     * What the agent wrote, read by the gate before the person is offered it.
     *
     * The agent edits its target with raw file tools, so nothing between its last keystroke and
     * the Accept press ever looked at the result: a missing comma or a field written as prose
     * reached review looking finished, and the refusal arrived at the one moment the session that
     * could have fixed it was gone. Asking here costs one round trip in the case that used to
     * cost the person a discarded draft.
     *
     * Only after a clean ending, because that is the only ending that keeps the session alive —
     * a cancelled or timed-out turn has nobody left to ask, and its half-written file is
     * explicitly the proposal's to keep (R-12).
     */
    if (final.state === "completed") {
      const spent = this.repairs.get(input.proposalId) ?? 0;
      if (spent < MAX_REPAIR_TURNS) {
        const problems = await gate.recordProblems(input.proposalId).catch(() => []);
        /*
         * The run was cleared from `this.runs` in the finally above, so a Stop pressed during
         * these awaits found nothing to cancel and the repair started anyway (review
         * 2026-08-22). The flag survives the clear; a cancelled proposal repairs nothing.
         */
        if (problems.length > 0 && !this.cancelledRepairs.has(input.proposalId)) {
          this.repairs.set(input.proposalId, spent + 1);
          progress(`checking what was written — ${problems[0]!.message}`);
          await this.run(
            store,
            gate,
            { ...input, instruction: repairInstruction(problems), repairTurn: true },
            worldQueryUrl,
          );
          return;
        }
      }
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
