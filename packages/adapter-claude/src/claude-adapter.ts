import { randomUUID } from "node:crypto";
import {
  agentPromptFor,
  confinementFor,
  ROSTER,
  skillForAgent,
  type AgentConfinement,
  type CreateSessionInput,
  type HarnessAdapter,
  type HarnessCapability,
  type HarnessEvent,
  type Readiness,
  type SendMessageInput,
  type SendReceipt,
  type SessionConfigInput,
  type SessionRef,
} from "@arke-studio/contracts";
import { createNormalizeState, normalizeClaude, type NormalizeState } from "./normalize.js";
import { resolveRoot } from "./path-confinement.js";
import { decideTool, type ToolDecision } from "./tool-intents.js";

/**
 * The Claude Code harness adapter (SPEC-005 §1.4, §17).
 *
 * The shape of this file is set by one difference from OpenCode: there is no server. OpenCode's
 * adapter talks HTTP to a supervised child that holds sessions for it; the Agent SDK is a
 * `query()` over an async iterable, and a session exists only as long as this object keeps it.
 * So the session table, the turn bookkeeping and the multiplexed event stream all live here,
 * and `dispose()` is the only thing standing between an abandoned adapter and a live subprocess.
 *
 * Everything the agent may do comes from {@link confinementFor} and is enforced in `canUseTool`
 * — a callback we own, rather than a config file the harness is trusted to honour. That is
 * stronger than OpenCode where it applies, and it has to be verified per binary rather than
 * assumed (see `confinement-probe.ts`). It is not total: side-effect-free work inside the
 * working directory is auto-approved without reaching the callback, which `tool-intents.ts`
 * records in full along with the audit that bounded it.
 *
 * The gate asks two questions, not one. What a tool DOES is its intent; where it was pointed is
 * `session.root`, and both have to pass. The second question went unasked until a read-only
 * agent was measured reading a file out of `%LOCALAPPDATA%\Temp` — `cwd` is where a process
 * starts, and an absolute path in a tool argument does not care.
 */

export interface ClaudeAdapterOptions {
  /** The verified binary. Mandatory: unpinned, the SDK runs its own bundled copy, not the user's. */
  command: string;
  /** Absent until a world is open; the agent then reads the world only through this. */
  worldQueryUrl?: string;
  /** Selects the authoring skill for the session (SPEC-019 R-16). */
  skillFamily?: string;
  skillModelId?: string;
  /** Per-agent Settings overrides — a brief may be rewritten, the confinement may not. */
  agents?: Record<string, { model?: string; brief?: string }>;
  onTrace?: (line: Record<string, unknown>) => void;
  /** Seam for tests: the SDK's `query`. */
  runQuery?: RunQuery;
}

/** The slice of the Agent SDK this adapter uses. Narrow on purpose — it is the whole coupling. */
export type RunQuery = (args: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

interface Turn {
  correlationId: string;
  /** Resolves when the turn's `session.ended` lands; rejects when it ended in error. */
  settled: Promise<void>;
  settle: (error?: Error) => void;
}

interface ClaudeSession {
  id: string;
  cwd: string;
  /** `cwd` with symlinks resolved: the boundary every path argument is judged against. */
  root: string;
  agentName: string;
  confinement: AgentConfinement;
  systemPrompt: string;
  /** The world-query MCP for THIS session, as prepareSession supplied it. */
  worldQueryUrl: string | undefined;
  inbox: AsyncQueue<unknown>;
  abort: AbortController;
  normalize: NormalizeState;
  started: boolean;
  turn: Turn | null;
}

/** A queue an async iterator can drain — the SDK's streaming-input mode wants exactly this. */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          const next = this.items.shift();
          if (next !== undefined) return resolve({ value: next, done: false });
          if (this.closed) return resolve({ value: undefined as never, done: true });
          this.waiting = resolve;
        }),
    };
  }
}

/** The four ways {@link decideTool} says no. */
type RefusalReason = Exclude<ToolDecision, { allow: true }>["reason"];

/**
 * What a refusal is called on screen — a state, not an explanation. Never the path: a summary
 * that named the file it refused would publish the one thing the refusal exists to withhold.
 */
const REFUSAL_SUMMARY: Record<RefusalReason, (tool: string) => string> = {
  unknown: (tool) => `refused ${tool} — not a tool this agent has`,
  refused: (tool) => `refused ${tool} — outside what this agent may do`,
  outside: (tool) => `refused ${tool} — outside the working directory`,
  "undeclared-path": (tool) => `refused ${tool} — unrecognised path argument`,
};

/**
 * What the agent is told, which is a different question from what the screen shows.
 *
 * The out-of-directory case says WHY, and that is deliberate rather than chatty: a bare refusal
 * was measured sending a turn looking for another route to the same file — denied `Read`, it
 * reached for `cat` through the shell. Naming the boundary is what makes it stop, and it gives
 * away nothing the agent did not already put in the argument.
 */
const DENIAL_MESSAGE: Record<RefusalReason, string> = {
  unknown: "denied by Arke Studio confinement",
  refused: "denied by Arke Studio confinement",
  outside: "denied by Arke Studio confinement — that path is outside this session's working directory",
  "undeclared-path": "denied by Arke Studio confinement — that argument is not one this session can check",
};

export class ClaudeAdapter implements HarnessAdapter {
  readonly id = "claude";

  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly subscribers = new Set<AsyncQueue<HarnessEvent>>();
  private ready: Readiness = { ready: false, reason: "not initialised" };
  /** Prepared settings keyed by an opaque one-use token, never by a reusable directory. */
  private readonly pending = new Map<string, SessionConfigInput>();

  constructor(private readonly opts: ClaudeAdapterOptions) {}

  /**
   * `events` only. Not `permissions`: this adapter refuses an unrecognised tool rather than
   * asking, so there is never a decision for a host to relay — see `tool-intents.ts` for why,
   * and note that declaring the gap is the honest half of it (SPEC-005 R-2, R-4).
   * Not `models` either: the model is the user's Claude Code default and we do not choose it.
   */
  capabilities(): ReadonlySet<HarnessCapability> {
    return new Set<HarnessCapability>(["events"]);
  }

  /**
   * Session settings that arrive as call options rather than as a file (SPEC-005 R-5).
   *
   * The world-query MCP is the one that matters: without it the agent has no way to read the
   * world at all, and — because a missing tool is not an error — it answers perfectly politely
   * that it has nothing on the subject. That reads like a model being careful, not like a
   * misconfiguration, which is what let it go unnoticed.
   */
  prepareSession(input: SessionConfigInput): void {
    if (input.preparationId !== undefined) this.pending.set(input.preparationId, input);
  }

  abandonSessionPreparation(preparationId: string): void {
    this.pending.delete(preparationId);
  }

  async init(): Promise<void> {
    // Availability — discovery, floor and the confinement probe — is resolved by the host before
    // it builds this adapter, because a harness that fails the probe must never be constructed.
    this.ready = { ready: true };
  }

  readiness(): Readiness {
    return this.ready;
  }

  /**
   * The model behind a session is whatever the user's Claude Code is configured with, and it is
   * not known until a turn reports it. Null is the honest answer, and the caller budgets from a
   * floor instead (§8.5).
   */
  knownInputTokenLimit(): number | null {
    return null;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    const prepared = input.preparationId === undefined ? {} : this.pending.get(input.preparationId);
    if (input.preparationId !== undefined) this.pending.delete(input.preparationId);
    if (prepared === undefined) throw new Error("session preparation is missing or was already consumed");
    const agentName = input.agent ?? "sheet-editor";
    const member = ROSTER.find((a) => a.name === agentName);
    if (!member) throw new Error(`no roster agent named ${agentName}`);
    const override = this.opts.agents?.[agentName];
    if (!input.cwd) throw new Error("a Claude session needs an explicit cwd — it is the confinement boundary");
    /*
     * From the session that was just prepared, not from how the adapter was built (codex,
     * 2026-08-23).
     *
     * `prepareSession` is how the coordinator says what this session is for, and on the Claude
     * lane it is the only way it says it: `v2-launch.ts` constructs this adapter with neither
     * value. Reading `this.opts` alone therefore found undefined and handed the scene-writer no
     * skill at all — while the proposal recorded the document it was supposed to have used. The
     * constructor options stay as a fallback, because a caller that does pass them means it.
     */
    const skill = skillForAgent(
      agentName,
      prepared.skillFamily ?? this.opts.skillFamily,
      prepared.skillModelId ?? this.opts.skillModelId,
    );
    /*
     * No default for `cwd`, though the contract makes it optional.
     *
     * On the OpenCode adapters it names where work happens. Here it is also the confinement
     * boundary — the audit that bounded `canUseTool` found reads OUTSIDE the working directory
     * reaching the gate and being refused, and reads inside it auto-approved without ever being
     * offered. So `process.cwd()` is not a harmless fallback: in a packaged app it is wherever
     * the user happened to launch from, and quietly substituting it would widen the boundary to
     * a directory nobody chose. Every caller passes one; a caller that forgets should be told.
     */
    const session: ClaudeSession = {
      id: `claude_${randomUUID()}`,
      cwd: input.cwd,
      /*
       * Resolved once, here, rather than per call.
       *
       * Every path argument is judged against this, and judging it against the UNRESOLVED cwd
       * would be a string test wearing a boundary's clothes — a working directory reached
       * through a symlink (or, on Windows, an 8.3 short name) would fail to contain its own
       * files, and every honest call inside it would be refused.
       */
      root: await resolveRoot(input.cwd),
      agentName,
      // Settings' research toggle, from the same `prepareSession` input the skill comes from.
      // No `this.opts` fallback: there is no constructor option for it, and inventing an
      // affirmative default is exactly the mistake a default-off privacy setting exists to avoid.
      confinement: confinementFor(member, { web: prepared.researchWeb === true }),
      worldQueryUrl: this.opts.worldQueryUrl ?? prepared.worldQueryUrl,
      systemPrompt: agentPromptFor({
        ...member,
        researchWeb: prepared.researchWeb === true,
        ...(override?.brief !== undefined ? { brief: override.brief } : {}),
        ...(skill !== null ? { skill } : {}),
      }),
      inbox: new AsyncQueue<unknown>(),
      abort: new AbortController(),
      normalize: createNormalizeState(),
      started: false,
      turn: null,
    };
    this.sessions.set(session.id, session);
    this.emit({ type: "session.created", sessionId: session.id });
    return { sessionId: session.id };
  }

  async sendMessage(input: SendMessageInput): Promise<SendReceipt> {
    const receipt = await this.dispatchAsync(input);
    const session = this.sessions.get(input.sessionId);
    if (session?.turn) await session.turn.settled;
    return receipt;
  }

  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new Error(`unknown session ${input.sessionId}`);
    const correlationId = input.correlationId ?? randomUUID();
    const text = input.parts.map((p) => p.text).join("\n");

    let settle!: (error?: Error) => void;
    const settled = new Promise<void>((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve());
    });
    // The rejection is always consumed by sendMessage or by the drain loop; attaching a no-op
    // here keeps a dispatchAsync nobody awaits from becoming an unhandled rejection.
    settled.catch(() => {});
    /*
     * A turn already in flight is replaced, not silently dropped.
     *
     * Messages queue on one inbox and the SDK answers them in order, so the displaced turn's
     * `session.ended` would settle its SUCCESSOR and leave its own promise pending for good —
     * and `sendMessage` awaits exactly that promise. The result would be a caller hung with no
     * error and no event, which is the worst shape a failure can take here. No caller dispatches
     * concurrently today; this makes sure that if one ever does, it is told.
     */
    session.turn?.settle(new Error("superseded by a later message on the same session"));
    session.turn = { correlationId, settle, settled };

    session.inbox.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: session.id,
    });
    if (!session.started) {
      session.started = true;
      void this.drive(session);
    }
    return { sessionId: session.id, correlationId };
  }

  /** One long-lived query per session; every turn's messages arrive on the same iterator. */
  private async drive(session: ClaudeSession): Promise<void> {
    const runQuery = this.opts.runQuery;
    if (!runQuery) throw new Error("ClaudeAdapter needs a query implementation");
    try {
      const messages = runQuery({
        prompt: session.inbox,
        options: {
          pathToClaudeCodeExecutable: this.opts.command,
          // Never inherit the user's own config: omitting this loads their settings AND connects
          // their MCP servers, which an authoring session has no business touching.
          settingSources: [],
          // No `env` override, and specifically no CLAUDE_CONFIG_DIR redirect, though the SDK
          // takes one. It looks like the analogue of OpenCode's `v2ProfileEnv` and is its
          // opposite: that redirect exists to cut the user's own login OFF, and here the user's
          // own login is the entire point. Measured — pointing CLAUDE_CONFIG_DIR at an Arke
          // directory moves the session's data as intended AND fails the same turn with "Not
          // logged in", because the subscription credential lives at
          // `<CLAUDE_CONFIG_DIR>/.credentials.json`. Copying it across would mean owning a second
          // copy of somebody's OAuth token and its refresh lifetime.
          //
          // What that leaves behind is one transcript per working directory under
          // `~/.claude/projects/`. Untidy rather than unsafe: the user's own machine, their own
          // Claude Code data, their own world content. The auto-memory it also names is NOT
          // written — a turn asked outright to remember something for next time wrote nothing,
          // across every session tried.
          systemPrompt: session.systemPrompt,
          cwd: session.cwd,
          abortController: session.abort,
          // No `allowedTools`: a bare entry there auto-approves the tool before canUseTool is
          // consulted, which would disarm the gate below rather than configure it.
          canUseTool: this.gateFor(session),
          ...(session.worldQueryUrl
            ? { mcpServers: { "arke-world": { type: "http", url: session.worldQueryUrl } } }
            : {}),
        },
      });
      for await (const message of messages) {
        const outcome = normalizeClaude(message, session.id, session.normalize);
        if (outcome.kind === "dead-letter") {
          this.opts.onTrace?.({ at: "claude.dead-letter", sessionId: session.id, reason: outcome.reason });
          continue;
        }
        if (outcome.kind === "ignore") continue;
        for (const event of outcome.events) {
          this.emit(event);
          if (event.type === "session.ended") {
            // The turn is over; the session stays open for the next one. Text does not carry
            // across turns, or the following delta would replay the previous answer.
            session.normalize = createNormalizeState();
            session.turn?.settle(event.reason === "error" ? new Error(event.detail ?? "turn failed") : undefined);
            session.turn = null;
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "session.error", sessionId: session.id, message });
      this.emit({ type: "session.ended", sessionId: session.id, reason: "error", detail: message });
      session.turn?.settle(err instanceof Error ? err : new Error(message));
      session.turn = null;
    }
  }

  /**
   * The confinement, enforced per call: what the tool does AND where it was pointed.
   *
   * `input` used to be passed straight back out as `updatedInput` without being looked at, which
   * is how a path argument reached anywhere on the disk under a tool name both roles permit.
   */
  private gateFor(session: ClaudeSession) {
    return async (toolName: string, input: Record<string, unknown>) => {
      const decision = await decideTool(session.confinement, toolName, { input, root: session.root });
      if (decision.allow) return { behavior: "allow" as const, updatedInput: input };
      this.emit({
        type: "tool.activity",
        sessionId: session.id,
        tool: toolName,
        summary: REFUSAL_SUMMARY[decision.reason](toolName),
      });
      // The path itself goes to the trace, not to the summary or the model: a refusal that
      // quotes the file it refused hands back the one thing the boundary exists to withhold.
      this.opts.onTrace?.({
        at: "claude.tool-refused",
        sessionId: session.id,
        tool: toolName,
        reason: decision.reason,
        ...(decision.reason === "outside" ? { path: decision.path, root: session.root } : {}),
        ...(decision.reason === "undeclared-path" ? { argument: decision.argument } : {}),
      });
      return { behavior: "deny" as const, message: DENIAL_MESSAGE[decision.reason] };
    };
  }

  async *streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    const queue = new AsyncQueue<HarnessEvent>();
    this.subscribers.add(queue);
    const stop = () => queue.close();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      for await (const event of queue) yield event;
    } finally {
      this.subscribers.delete(queue);
      signal?.removeEventListener("abort", stop);
    }
  }

  private emit(event: HarnessEvent): void {
    for (const subscriber of this.subscribers) subscriber.push(event);
  }

  /** Stops what this adapter started, and nothing it did not (SPEC-005 R-3). */
  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.abort.abort();
      session.inbox.close();
      session.turn?.settle(new Error("adapter disposed"));
    }
    this.sessions.clear();
    for (const subscriber of this.subscribers) subscriber.close();
    this.subscribers.clear();
  }
}
