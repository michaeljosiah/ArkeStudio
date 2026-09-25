import { randomUUID } from "node:crypto";
import {
  agentPromptFor, confinementFor, findHarnessModel, harnessModelMissingInput, HarnessEventSchema, ROSTER, sessionSkillForAgent,
  type CreateSessionInput, type HarnessAdapter, type HarnessCapability, type HarnessEvent, type ModelInfo,
  type Readiness, type SendMessageInput, type SendReceipt, type SessionConfigInput, type SessionRef,
} from "@arke-studio/contracts";
import {
  captureRootIdentity, ConfinementError, discoverWorldTools, executeTool, resolveRoot, toolsFor,
  type ToolResult, type ToolSession,
} from "@arke-studio/confined-tools";
import {
  listPulled, loopbackBaseUrl, OLLAMA_DEFAULT_URL, OllamaUnreachableError, streamChat,
  type ChatMessage, type ChatTool, type PulledModel,
} from "./ollama.js";

/**
 * Arke's own local writing harness (issue 1247, Phase 2).
 *
 * A small loop — model call, tool calls, confined execution, results, repeat — against Ollama's
 * native API, with no process of its own to start, supervise or authenticate. The tools it can
 * offer are the shared confined tools, and nothing else: a tool outside the session's
 * confinement is never put in front of the model, and a call to one anyway is refused and
 * reported as `tool.refused`. There is no shell, no delegation and no credential anywhere here.
 *
 * Deliberately minimal for this phase: the prompt-prefix stability, context sizing, residency
 * and tool-call tolerance that make it worth having are Phase 3, and nothing in the app selects
 * it until Phase 4.
 */
export interface ArkeAdapterOptions {
  /** Ollama's address. Loopback only unless `allowRemoteHost` is set by an explicit setting. */
  baseUrl?: string;
  allowRemoteHost?: boolean;
  /** Replaced in tests. */
  fetch?: typeof fetch;
  /** The context window asked for when a model does not state one, and the ceiling otherwise. */
  maxContextTokens?: number;
  /** Model calls one turn may make before it is ended. Each tool round is one. */
  maxStepsPerTurn?: number;
  /** Passed to Ollama as `keep_alive`, when set. */
  keepAlive?: string | number;
  onTrace?: (line: Record<string, unknown>) => void;
}

const DEFAULT_CONTEXT = 8_192;
const CONTEXT_CEILING = 32_768;
const DEFAULT_STEPS = 24;
const PROVIDER = "ollama";
/**
 * Roles that answer with one JSON document and never touch a file. The coordinator lets them run
 * on a model that cannot call tools, so they must not be sent tool definitions such a model may
 * reject outright.
 */
const PROMPT_ONLY_AGENTS = new Set(["conversation-namer", "conversation-summarizer"]);

class EventQueue {
  private readonly values: HarnessEvent[] = [];
  private waiting: ((value: IteratorResult<HarnessEvent>) => void) | null = null;
  private closed = false;
  push(value: HarnessEvent): void { if (this.closed) return; if (this.waiting) { const resolve = this.waiting; this.waiting = null; resolve({ value, done: false }); } else this.values.push(value); }
  close(): void { this.closed = true; this.waiting?.({ value: undefined as never, done: true }); this.waiting = null; }
  [Symbol.asyncIterator](): AsyncIterator<HarnessEvent> { return { next: () => new Promise(resolve => { const value = this.values.shift(); if (value) resolve({ value, done: false }); else if (this.closed) resolve({ value: undefined as never, done: true }); else this.waiting = resolve; }) }; }
}

interface Turn {
  correlationId: string;
  abort: AbortController;
  settled: Promise<void>;
}
interface Session extends ToolSession {
  id: string;
  model: string;
  numCtx: number;
  tools: ChatTool[];
  /** The conversation so far, system prompt first. Only ever appended to. */
  messages: ChatMessage[];
  turn: Turn | null;
  usage: number;
}

type Ending = { reason: "completed"; text: string } | { reason: "cancelled" | "timeout" | "budget-exceeded" | "error"; detail: string };

export class ArkeAdapter implements HarnessAdapter {
  readonly id = "arke";
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private ready: Readiness = { ready: false, reason: "not initialised" };
  private disposed = false;
  private revision = 0;
  private readonly preparations = new Map<string, SessionConfigInput>();
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Set<EventQueue>();

  constructor(private readonly opts: ArkeAdapterOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.baseUrl = loopbackBaseUrl(opts.baseUrl ?? OLLAMA_DEFAULT_URL, opts.allowRemoteHost === true);
  }

  capabilities(): ReadonlySet<HarnessCapability> { return new Set(["events", "models"]); }
  readiness(): Readiness { return this.ready; }
  lifecycleRevision(): number { return this.revision; }
  /** Nothing on disk: configuration arrives through `prepareSession`. */
  sessionFiles(): [] { return []; }

  prepareSession(input: SessionConfigInput): void {
    if (input.preparationId === undefined) return;
    if (this.preparations.has(input.preparationId)) throw new Error("Session preparation token is already in use.");
    this.preparations.set(input.preparationId, structuredClone(input));
  }
  abandonSessionPreparation(id: string): void { this.preparations.delete(id); }

  /**
   * There is no child process to supervise, so a health loop learns Ollama has gone only from
   * readiness and the revision; a lost connection mid-turn changes both, and `init` restores them.
   */
  private markUnready(reason: string): void {
    if (this.ready.ready) this.revision++;
    this.ready = { ready: false, reason };
  }

  /** Ready when Ollama answers. There is nothing else to start. */
  async init(): Promise<void> {
    if (this.disposed) throw new Error("The Arke harness is disposed.");
    try {
      await listPulled(this.fetchImpl, this.baseUrl, AbortSignal.timeout(8_000));
      if (!this.ready.ready) this.revision++;
      this.ready = { ready: true };
    } catch {
      this.markUnready("Ollama is not answering on this machine.");
      throw new Error("Ollama is not answering on this machine.");
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.catalog(AbortSignal.timeout(15_000)).then(({ models }) => models);
  }

  /**
   * The catalogue in the harness contract's terms. The first model that says it calls tools is
   * the default, because every roster agent but two works through them and a default nobody
   * chose should be one that can do the work.
   */
  private async catalog(signal: AbortSignal): Promise<{ models: ModelInfo[]; pulled: PulledModel[] }> {
    const pulled = await listPulled(this.fetchImpl, this.baseUrl, signal);
    const fallback = pulled.find((model) => model.tools)?.id;
    const models = pulled.map((model): ModelInfo => ({
      id: model.id, provider: PROVIDER, displayName: model.id,
      inputModalities: model.vision ? ["text", "image"] : ["text"],
      // The window a session will actually get, not the model's own: the coordinator sizes
      // context from this before a session exists, and a prompt sized to 131,072 tokens sent
      // into a 32,768 window loses its beginning without an error.
      inputTokenLimit: this.contextFor(model.contextLength),
      // Stated either way. Absent reads as unknown, and unknown is offered to tool-using roles.
      tools: model.tools,
      ...(model.id === fallback ? { isDefault: true } : {}),
    }));
    return { models, pulled };
  }

  /** The context window asked of Ollama: the model's own, held to the ceiling. */
  private contextFor(stated: number | undefined): number {
    const ceiling = this.opts.maxContextTokens ?? CONTEXT_CEILING;
    return Math.min(stated ?? this.opts.maxContextTokens ?? DEFAULT_CONTEXT, ceiling);
  }

  knownInputTokenLimit(sessionId?: string): number | null {
    return sessionId !== undefined ? this.sessions.get(sessionId)?.numCtx ?? null : null;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    const prepared = input.preparationId !== undefined ? this.preparations.get(input.preparationId) : {};
    if (input.preparationId !== undefined) this.preparations.delete(input.preparationId);
    if (!prepared) throw new Error("Session preparation is missing or was already consumed.");
    if (this.disposed) throw new Error("The Arke harness is disposed.");
    input.signal?.throwIfAborted();
    const member = ROSTER.find((agent) => agent.name === (input.agent ?? "sheet-editor"));
    if (!member) throw new Error("Unknown application roster agent.");
    if (!input.cwd) throw new Error("The Arke harness needs an explicit session directory.");
    const root = await resolveRoot(input.cwd);
    const override = prepared.agents?.[member.name];
    const requested = prepared.model ?? override?.model;
    const { models, pulled } = await this.catalog(input.signal ?? AbortSignal.timeout(15_000));
    input.signal?.throwIfAborted();
    const selected = requested === undefined ? models.find((model) => model.isDefault) : findHarnessModel(requested, models);
    if (requested !== undefined && !selected) throw new Error("The selected model is not pulled in Ollama. Refresh the model list and choose an available model.");
    if (!selected) throw new Error("Ollama has no model that calls tools. Pull one, or choose a model before starting this agent.");
    const missingInput = harnessModelMissingInput(selected, member.name === "stage-designer");
    if (missingInput === "text") throw new Error("This model cannot accept the text instructions required by Arke.");
    if (missingInput === "image") throw new Error("This model cannot inspect Stage images.");
    const researchWeb = member.name !== "stage-designer" && prepared.researchWeb === true;
    const toolSession: ToolSession = {
      root, rootIdentity: await captureRootIdentity(root, input.signal), confinement: confinementFor(member, { web: researchWeb }),
      ...(prepared.worldQueryUrl !== undefined ? { worldQueryUrl: prepared.worldQueryUrl } : {}),
      worldTools: new Map(), ...(selected.inputModalities ? { inputModalities: selected.inputModalities } : {}),
    };
    await discoverWorldTools(toolSession, input.signal);
    input.signal?.throwIfAborted();
    const skill = sessionSkillForAgent(member.name, prepared);
    const prompt = agentPromptFor({ ...member, researchWeb, ...(override?.brief !== undefined ? { brief: override.brief } : {}), ...(skill ? { skill } : {}) });
    const stated = pulled.find((model) => model.id === selected.id)?.contextLength;
    const numCtx = this.contextFor(stated);
    // Only what the confinement permits is ever offered: the tool list IS the confinement here,
    // rather than a list of tools a harness already has with some of them denied.
    const tools: ChatTool[] = PROMPT_ONLY_AGENTS.has(member.name) ? [] : toolsFor(toolSession).map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    const id = randomUUID();
    this.sessions.set(id, { ...toolSession, id, model: selected.id, numCtx, tools, messages: [{ role: "system", content: prompt }], turn: null, usage: 0 });
    this.opts.onTrace?.({ at: "arke.session-created", sessionId: id, model: selected.id, agent: member.name, numCtx, tools: tools.map((tool) => tool.function.name) });
    this.emit({ type: "session.created", sessionId: id });
    return { sessionId: id };
  }

  async sendMessage(input: SendMessageInput): Promise<SendReceipt> {
    const { receipt, turn } = this.startTurn(input);
    await turn.settled;
    return receipt;
  }
  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> {
    return this.startTurn(input).receipt;
  }
  usageTokens(sessionId: string): number { return this.sessions.get(sessionId)?.usage ?? 0; }

  private startTurn(input: SendMessageInput): { receipt: SendReceipt; turn: Turn } {
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new Error("Unknown Arke session.");
    if (session.turn) throw new Error("A turn is already running in this session.");
    const correlationId = input.correlationId ?? randomUUID();
    const abort = new AbortController();
    let settle!: (error?: Error) => void;
    const settled = new Promise<void>((resolve, reject) => { settle = (error) => error ? reject(error) : resolve(); });
    settled.catch(() => {});
    const turn: Turn = { correlationId, abort, settled };
    session.turn = turn;
    session.messages.push({ role: "user", content: input.parts.map((part) => part.text).join("\n") });
    void this.runTurn(session, turn).then((ending) => {
      if (session.turn === turn) session.turn = null;
      if (ending.reason !== "completed") this.answerUnrun(session);
      if (ending.reason === "completed") {
        this.emit({ type: "message.completed", sessionId: session.id, correlationId, text: ending.text });
        this.emit({ type: "session.ended", sessionId: session.id, reason: "completed" });
        settle();
        return;
      }
      if (ending.reason === "error") this.emit({ type: "session.error", sessionId: session.id, message: ending.detail });
      this.emit({ type: "session.ended", sessionId: session.id, reason: ending.reason, detail: ending.detail });
      settle(new Error(ending.detail));
    }).catch((error: unknown) => settle(error instanceof Error ? error : new Error(String(error))));
    return { receipt: { sessionId: session.id, correlationId }, turn };
  }

  /**
   * One turn: ask, run what the model asked for, answer it, ask again — until the model replies
   * without a tool call, is stopped, or runs out of steps. Every exit is a stated ending.
   */
  private async runTurn(session: Session, turn: Turn): Promise<Ending> {
    const steps = this.opts.maxStepsPerTurn ?? DEFAULT_STEPS;
    const signal = turn.abort.signal;
    try {
      for (let step = 0; step < steps; step++) {
        const result = await streamChat(this.fetchImpl, this.baseUrl, {
          model: session.model, messages: session.messages, tools: session.tools, numCtx: session.numCtx,
          ...(this.opts.keepAlive !== undefined ? { keepAlive: this.opts.keepAlive } : {}),
        }, signal, (text) => this.emit({ type: "message.delta", sessionId: session.id, correlationId: turn.correlationId, text }));
        session.usage += result.promptTokens + result.outputTokens;
        // Cut off by the output or context limit: the text, or a tool call's arguments, is only
        // the part that fit. Handing it on as finished would pass half a JSON document downstream.
        if (result.doneReason === "length") return { reason: "budget-exceeded", detail: "The reply reached the model's length limit before it finished." };
        session.messages.push({ role: "assistant", content: result.content, ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}) });
        if (result.toolCalls.length === 0) return { reason: "completed", text: result.content };
        for (const call of result.toolCalls) {
          signal.throwIfAborted();
          session.messages.push(await this.runTool(session, call.function.name, call.function.arguments, signal));
        }
      }
      return { reason: "budget-exceeded", detail: `The turn reached its limit of ${steps} model calls.` };
    } catch (error) {
      if (signal.aborted) return { reason: "cancelled", detail: "Stopped." };
      if (error instanceof OllamaUnreachableError) this.markUnready(error.message);
      return { reason: "error", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * A turn stopped between a model's tool calls leaves calls nobody answered. Ollama's chat
   * template expects each call to be followed by its answer, so the next turn would send a
   * conversation the model was never trained on; answer them as not run, which is also true.
   */
  private answerUnrun(session: Session): void {
    const at = session.messages.findLastIndex((message) => message.role === "assistant");
    const calls = at < 0 ? [] : session.messages[at]!.tool_calls ?? [];
    const answered = session.messages.length - at - 1;
    for (const call of calls.slice(answered)) {
      session.messages.push({ role: "tool", tool_name: call.function.name, content: "Not run: the turn was stopped first." });
    }
  }

  /** One tool call, answered as a `tool` message whatever happens: the model is always told. */
  private async runTool(session: Session, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ChatMessage> {
    const answer = (result: ToolResult): ChatMessage => {
      const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      const images = result.content.flatMap((item) => item.type === "image" ? [item.data] : []);
      return { role: "tool", tool_name: name, content: text, ...(images.length > 0 ? { images } : {}) };
    };
    try {
      const executed = await executeTool(session, name, args, signal);
      if (executed.summary && !signal.aborted) this.emit({ type: "tool.activity", sessionId: session.id, tool: `arke.${name}`, summary: executed.summary });
      return answer(executed.result);
    } catch (error) {
      if (signal.aborted) throw error;
      const refused = error instanceof ConfinementError;
      if (refused) this.emit({ type: "tool.refused", sessionId: session.id, tool: `arke.${name}`, summary: "refused a tool outside this session's capabilities" });
      return answer({ success: false, content: [{ type: "text", text: refused ? "Denied by Arke Studio confinement." : `The tool could not complete: ${error instanceof Error ? error.message : String(error)}` }] });
    }
  }

  /** Stops the generation itself: the request is aborted, so Ollama stops producing tokens. */
  async interrupt(sessionId: string): Promise<void> {
    const turn = this.sessions.get(sessionId)?.turn;
    if (!turn) return;
    turn.abort.abort();
    await turn.settled.catch(() => {});
  }

  private emit(event: HarnessEvent): void {
    // Validated here, at the boundary, as every adapter's events are (SPEC-001 R-2): a malformed
    // event is a bug in this file, and it should fail where it was made.
    const valid = HarnessEventSchema.parse(event);
    for (const queue of this.queues) queue.push(valid);
  }

  /**
   * Subscribes when called, not on the first pull. Callers take the iterable, dispatch a turn,
   * then start iterating; a local reply can finish in between, and a generator body would only
   * register after its events were already gone.
   */
  streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    if (signal?.aborted || this.disposed) return { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined as never, done: true }) }) };
    const queue = new EventQueue(); this.queues.add(queue);
    const stop = () => { queue.close(); signal?.removeEventListener("abort", stop); this.queues.delete(queue); };
    signal?.addEventListener("abort", stop, { once: true });
    const iterator = queue[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => { const step = await iterator.next(); if (step.done) stop(); return step; },
        return: async () => { stop(); return { value: undefined as never, done: true }; },
      }),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.preparations.clear();
    const running = [...this.sessions.values()].flatMap((session) => session.turn ? [session.turn] : []);
    for (const turn of running) turn.abort.abort();
    await Promise.all(running.map((turn) => turn.settled.catch(() => {})));
    this.sessions.clear();
    for (const queue of this.queues) queue.close();
    this.queues.clear();
    this.ready = { ready: false, reason: "The Arke harness is disposed." };
    this.revision++;
  }
}
