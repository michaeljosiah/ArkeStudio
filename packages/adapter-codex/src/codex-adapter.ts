import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  agentPromptFor, confinementFor, findHarnessModel, ROSTER, sessionSkillForAgent, LLM_ENV_NAMES, LLM_ENV_PROVIDERS,
  type CreateSessionInput, type HarnessAdapter, type HarnessCapability, type HarnessEvent, type ModelInfo,
  type Readiness, type SendMessageInput, type SendReceipt, type SessionConfigInput, type SessionRef,
} from "@arke-studio/contracts";
import { CodexRpc, object, type JsonObject } from "./rpc.js";
import { ConfinementError, discoverWorldTools, executeTool, resolveRoot, toolsFor, type ToolSession } from "./tools.js";

export interface CodexAdapterOptions {
  command: string;
  args?: string[];
  /** A host-built environment. The user's Codex login remains in its own store. */
  env?: NodeJS.ProcessEnv;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  killProcess?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  onTrace?: (line: Record<string, unknown>) => void;
  requestTimeoutMs?: number;
}

/** The same provider-key policy used by the other harnesses, without copying auth files. */
export function codexCredentialEnv(
  managed: Partial<Record<(typeof LLM_ENV_PROVIDERS)[number], string | undefined>>,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result = { ...inherited };
  for (const provider of LLM_ENV_PROVIDERS) {
    const name = LLM_ENV_NAMES[provider]; delete result[name];
    if (managed[provider]) result[name] = managed[provider];
  }
  return result;
}

/** Captured once per session. Empty native environments alone did not disable delegation. */
export function confinedConfig(prior: JsonObject, researchWeb: boolean): JsonObject {
  const config: JsonObject = {
    "features.shell_tool": false, "features.apps": false, "features.plugins": false,
    "features.multi_agent": false, "features.multi_agent_v2": false, "agents.enabled": false,
    "features.hooks": false, "features.codex_hooks": false, "features.image_generation": false,
    "features.computer_use": false, "features.browser_use": false, "features.in_app_browser": false,
    "features.workspace_dependencies": false, "orchestrator.skills.enabled": false,
    "features.skip_host_skill_discovery": true, "features.skill_mcp_dependency_install": false,
    "skills.include_instructions": false, "skills.bundled.enabled": false,
    "features.sleep_tool": false, "features.send_async_message": false,
    "orchestrator.mcp.enabled": false, "tools.experimental_request_user_input.enabled": false,
    "features.code_mode.direct_only_tool_namespaces": ["arke"],
    "features.code_mode_host.enabled": true, "features.code_mode_host.disable_in_process_fallback": true,
    web_search: researchWeb ? "live" : "disabled", project_doc_max_bytes: 0,
  };
  // App-server's dotted override grammar does not parse quoted table keys. A server name
  // containing a dot must remain a literal key inside the complete table value.
  config.mcp_servers = Object.fromEntries(Object.keys(object(prior.mcp_servers)).map(id => [id, { enabled: false }]));
  return config;
}

class EventQueue {
  private readonly values: HarnessEvent[] = [];
  private waiting: ((value: IteratorResult<HarnessEvent>) => void) | null = null;
  private closed = false;
  push(value: HarnessEvent): void { if (this.closed) return; if (this.waiting) { const resolve = this.waiting; this.waiting = null; resolve({ value, done: false }); } else this.values.push(value); }
  close(): void { this.closed = true; this.waiting?.({ value: undefined as never, done: true }); this.waiting = null; }
  [Symbol.asyncIterator](): AsyncIterator<HarnessEvent> { return { next: () => new Promise(resolve => { const value = this.values.shift(); if (value) resolve({ value, done: false }); else if (this.closed) resolve({ value: undefined as never, done: true }); else this.waiting = resolve; }) }; }
}
interface Turn {
  id: string | null;
  correlationId: string;
  items: Map<string, string>;
  phases: Map<string, string>;
  settled: Promise<void>;
  settle: (error?: Error) => void;
  abort: AbortController;
  cancelled: boolean;
}
interface Session extends ToolSession {
  id: string;
  model: string;
  provider: string;
  turn: Turn | null;
  retiredTurns: Set<string>;
  usage: number;
}

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex";
  private rpc: CodexRpc | null = null;
  private ready: Readiness = { ready: false, reason: "not initialised" };
  private initialization: Promise<void> | null = null;
  private disposed = false;
  private priorConfig: JsonObject = {};
  private readonly preparations = new Map<string, SessionConfigInput>();
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Set<EventQueue>();
  private inputLimit: number | null = null;
  private environmentUpdate: Promise<void> = Promise.resolve();
  constructor(private readonly opts: CodexAdapterOptions) {}

  capabilities(): ReadonlySet<HarnessCapability> { return new Set(["events", "models"]); }
  readiness(): Readiness { return this.ready; }
  knownInputTokenLimit(): number | null { return this.inputLimit; }
  sessionFiles(): [] { return []; }
  prepareSession(input: SessionConfigInput): void {
    if (input.preparationId) {
      if (this.preparations.has(input.preparationId)) throw new Error("Session preparation token is already in use.");
      this.preparations.set(input.preparationId, structuredClone(input));
    }
  }
  abandonSessionPreparation(id: string): void { this.preparations.delete(id); }

  /** Key rotation crosses a process boundary; old sessions may not keep an old credential. */
  updateEnvironment(env: NodeJS.ProcessEnv): Promise<void> {
    const requested = { ...env };
    const update = this.environmentUpdate.catch(() => {}).then(async () => {
      if (this.disposed) throw new Error("Codex adapter is disposed.");
      const prior = this.opts.env ?? process.env;
      const names = new Set([...Object.keys(prior), ...Object.keys(requested)]);
      if ([...names].every(name => prior[name] === requested[name])) return;
      const started = this.rpc !== null || this.initialization !== null;
      if (this.initialization) await this.initialization.catch(() => {});
      await this.rpc?.dispose(); this.rpc = null;
      this.sessions.clear(); this.preparations.clear();
      this.opts.env = requested;
      this.ready = { ready: false, reason: "Codex credentials changed; reconnecting." };
      if (started) await this.init();
    });
    this.environmentUpdate = update;
    return update;
  }

  async init(): Promise<void> {
    if (this.disposed) throw new Error("Codex adapter is disposed.");
    if (this.ready.ready) return;
    if (this.initialization) return this.initialization;
    this.initialization = this.initialize();
    try { await this.initialization; } finally { this.initialization = null; }
  }
  private async initialize(): Promise<void> {
    await this.rpc?.dispose();
    const rpc = new CodexRpc({ ...this.opts,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.serverRequest(method, params),
      onFailure: error => this.failure(error),
    });
    this.rpc = rpc;
    try {
      await rpc.start();
      await rpc.request("initialize", { clientInfo: { name: "arke_studio", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      await rpc.write({ method: "initialized" });
      this.priorConfig = object(object(await rpc.request("config/read", { includeLayers: false })).config);
      this.ready = { ready: true };
    } catch (error) {
      await rpc.dispose(); this.ready = { ready: false, reason: "Codex app-server could not initialize." }; throw error;
    }
  }
  private connection(): CodexRpc { if (!this.rpc || !this.ready.ready) throw new Error(this.ready.reason ?? "Codex is not running."); return this.rpc; }

  async listModels(): Promise<ModelInfo[]> {
    return this.discoverModels();
  }
  private async discoverModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const rpc = this.connection(); const result: ModelInfo[] = []; const seen = new Set<string>();
    const provider = typeof this.priorConfig.model_provider === "string" ? this.priorConfig.model_provider : "openai";
    let cursor: string | null = null;
    do {
      const response = object(await rpc.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, signal));
      if (!Array.isArray(response.data)) throw new Error("Codex returned an invalid model catalog.");
      for (const raw of response.data) {
        const model = object(raw); if (model.hidden === true) continue;
        if (typeof model.model !== "string" || !model.model || typeof model.id !== "string") throw new Error("Codex returned an invalid model identity.");
        if (result.some(row => row.id === model.model && row.provider === provider)) continue;
        result.push({ id: model.model, provider, ...(typeof model.displayName === "string" ? { displayName: model.displayName } : {}), isDefault: model.isDefault === true,
          ...(model.id !== model.model ? { aliases: [model.id] } : {}),
          ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities.filter((value): value is "text" | "image" => value === "text" || value === "image") } : {}),
        });
      }
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
      if (cursor && seen.has(cursor)) throw new Error("Codex repeated a model catalog page.");
      if (cursor) seen.add(cursor);
      if (seen.size > 100) throw new Error("Codex model catalog exceeded its page limit.");
    } while (cursor);
    return result;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRef> {
    const prepared = input.preparationId ? this.preparations.get(input.preparationId) : {};
    if (input.preparationId) this.preparations.delete(input.preparationId);
    if (!prepared) throw new Error("Session preparation is missing or was already consumed.");
    input.signal?.throwIfAborted();
    const rpc = this.connection();
    const member = ROSTER.find(agent => agent.name === (input.agent ?? "sheet-editor"));
    if (!member) throw new Error("Unknown application roster agent.");
    if (!input.cwd) throw new Error("Codex needs an explicit session directory.");
    const root = await resolveRoot(input.cwd);
    const override = prepared.agents?.[member.name];
    const requested = prepared.model ?? override?.model;
    const catalog = await this.discoverModels(input.signal); input.signal?.throwIfAborted();
    const selected = requested === undefined ? catalog.find(model => model.isDefault) : findHarnessModel(requested, catalog);
    if (requested !== undefined && !selected) throw new Error("The selected model is unavailable through Codex. Refresh the model list and choose an available model.");
    if (!selected) throw new Error("Codex did not report a default model. Choose a model before starting this agent.");
    if (member.name === "stage-designer" && selected.inputModalities && !selected.inputModalities.includes("image")) throw new Error("This Codex model cannot inspect Stage images.");
    const researchWeb = member.name !== "stage-designer" && prepared.researchWeb === true;
    const toolSession: ToolSession = { root, confinement: confinementFor(member, { web: researchWeb }), worldQueryUrl: prepared.worldQueryUrl, worldTools: new Map(), inputModalities: selected.inputModalities };
    await discoverWorldTools(toolSession, input.signal);
    const skill = sessionSkillForAgent(member.name, prepared);
    const prompt = agentPromptFor({ ...member, researchWeb, ...(override?.brief !== undefined ? { brief: override.brief } : {}), ...(skill ? { skill } : {}) });
    const config = confinedConfig(this.priorConfig, researchWeb);
    const archiveLate = (value: unknown) => { const id = object(object(value).thread).id; if (typeof id === "string") void rpc.request("thread/archive", { threadId: id }).catch(() => {}); };
    const response = object(await rpc.request("thread/start", {
      model: selected.id, modelProvider: selected.provider, allowProviderModelFallback: false,
      cwd: root, runtimeWorkspaceRoots: [], ephemeral: true, environments: [], selectedCapabilityRoots: [],
      sandbox: "read-only", approvalPolicy: "untrusted", baseInstructions: prompt, developerInstructions: "",
      config, dynamicTools: [{ type: "namespace", name: "arke", description: "Arke Studio's application-owned tools. Use read for actual images.", tools: toolsFor(toolSession) }],
    }, input.signal, archiveLate));
    const id = object(response.thread).id;
    if (typeof id !== "string" || response.model !== selected.id || response.modelProvider !== selected.provider || (Array.isArray(response.instructionSources) && response.instructionSources.length > 0)) {
      archiveLate(response); throw new Error("Codex changed the selected model or loaded instructions outside this session.");
    }
    if (input.signal?.aborted) { archiveLate(response); throw new Error("Session creation cancelled."); }
    this.sessions.set(id, { ...toolSession, id, model: selected.id, provider: selected.provider, turn: null, retiredTurns: new Set(), usage: 0 });
    this.opts.onTrace?.({ at: "codex.session-created", sessionId: id, model: selected.id, provider: selected.provider, agent: member.name });
    this.emit({ type: "session.created", sessionId: id });
    return { sessionId: id };
  }

  private async startTurn(input: SendMessageInput): Promise<{ receipt: SendReceipt; turn: Turn }> {
    const session = this.sessions.get(input.sessionId); if (!session) throw new Error("Unknown Codex session.");
    if (session.turn) throw new Error("A Codex turn is already running in this session.");
    const rpc = this.connection(); const correlationId = input.correlationId ?? randomUUID();
    let settle!: (error?: Error) => void;
    const settled = new Promise<void>((resolve, reject) => { settle = error => error ? reject(error) : resolve(); });
    settled.catch(() => {});
    const turn: Turn = { id: null, correlationId, items: new Map(), phases: new Map(), settled, settle, abort: new AbortController(), cancelled: false };
    session.turn = turn;
    try {
      const response = object(await rpc.request("turn/start", { threadId: session.id, input: input.parts.map(part => ({ type: "text", text: part.text })), environments: [] }));
      const id = object(response.turn).id;
      if (typeof id !== "string" || (turn.id !== null && turn.id !== id)) throw new Error("Codex returned an invalid turn identity.");
      turn.id = id;
      if (turn.cancelled && session.turn === turn) await this.interrupt(session.id);
    } catch (error) {
      if (session.turn === turn) this.finish(session, "error", "Codex could not start the turn.");
      // An uncertain turn/start may already be generating. Stopping our process is the only
      // bounded cancellation available when the server never returned a turn identity.
      await rpc.dispose();
      throw error;
    }
    return { receipt: { sessionId: session.id, correlationId }, turn };
  }
  async sendMessage(input: SendMessageInput): Promise<SendReceipt> { const { receipt, turn } = await this.startTurn(input); await turn.settled; return receipt; }
  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> { return (await this.startTurn(input)).receipt; }
  usageTokens(sessionId: string): number { return this.sessions.get(sessionId)?.usage ?? 0; }

  private notification(method: string, params: JsonObject): void {
    const session = typeof params.threadId === "string" ? this.sessions.get(params.threadId) : undefined;
    if (!session) return;
    const turn = session.turn;
    const announced = object(params.turn);
    const id = typeof params.turnId === "string" ? params.turnId : typeof announced.id === "string" ? announced.id : undefined;
    if (method === "thread/tokenUsage/updated") {
      const usage = object(params.tokenUsage); const total = object(usage.total).totalTokens;
      if (typeof total === "number" && Number.isFinite(total) && total >= session.usage) session.usage = total;
      if (typeof usage.modelContextWindow === "number" && usage.modelContextWindow > 0) this.inputLimit = usage.modelContextWindow;
      return;
    }
    if (!turn || !id || session.retiredTurns.has(id) || (turn.id !== null && turn.id !== id)) return;
    // Only the turn/start response or turn/started establishes identity. An unsolicited tool
    // callback or text item arriving first cannot appoint itself this session's active turn.
    if (turn.id === null && method !== "turn/started") return;
    turn.id ??= id;
    const incoming = object(params.item);
    if ((incoming.type === "agentMessage" && (incoming.delivery === "async" || Array.isArray(incoming.questions))) ||
      (Array.isArray(announced.items) && announced.items.some(raw => object(raw).type === "agentMessage" && (object(raw).delivery === "async" || Array.isArray(object(raw).questions))))) {
      // Some catalog profiles expose an asynchronous question tool even when ordinary input
      // tools are disabled. It becomes an agentMessage notification, never an RPC ask. Do not
      // render its question or treat its internal accepted:true as delivery to an Arke user.
      this.emit({ type: "tool.refused", sessionId: session.id, tool: "request_user_input_async", summary: "refused an unsupported Codex question tool" });
      this.finish(session, "error", "This Codex question tool is not available in Arke. Retry with an instruction to reply directly.");
      void this.rpc?.request("turn/interrupt", { threadId: session.id, turnId: id }, AbortSignal.timeout(5000)).catch(() => this.rpc?.dispose());
      return;
    }
    if (incoming.type === "agentMessage" && typeof incoming.id === "string" && typeof incoming.phase === "string") turn.phases.set(incoming.id, incoming.phase);
    if (method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      turn.items.set(params.itemId, (turn.items.get(params.itemId) ?? "") + params.delta); this.delta(session, turn);
    } else if (method === "item/completed") {
      const item = object(params.item);
      if (item.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string") { turn.items.set(item.id, item.text); this.delta(session, turn); }
    } else if (method === "turn/completed") {
      if (Array.isArray(announced.items)) for (const raw of announced.items) { const item = object(raw); if (item.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string") { turn.items.set(item.id, item.text); if (typeof item.phase === "string") turn.phases.set(item.id, item.phase); } }
      if (announced.status === "completed") this.finish(session, turn.cancelled ? "cancelled" : "completed");
      else if (announced.status === "interrupted") this.finish(session, "cancelled");
      else this.finish(session, "error", "Codex could not complete this turn. Check its login, model access and quota.");
    } else if (method === "error" && params.willRetry !== true) this.finish(session, "error", "Codex reported a generation error. Check its login, model access and quota.");
  }
  private delta(session: Session, turn: Turn): void {
    this.emit({ type: "message.delta", sessionId: session.id, correlationId: turn.correlationId, text: [...turn.items.values()].join("\n\n") });
  }
  private finish(session: Session, reason: "completed" | "cancelled" | "error", detail?: string): void {
    const turn = session.turn; if (!turn) return;
    session.turn = null; turn.abort.abort();
    if (turn.id) session.retiredTurns.add(turn.id);
    if (reason === "completed") {
      // Commentary may precede a tool and the final JSON answer. It is useful while streaming,
      // but concatenating it into the answer breaks the coordinator's structured-result gate.
      const final = [...turn.items.entries()].filter(([id]) => turn.phases.get(id) === "final_answer").at(-1)?.[1] ?? [...turn.items.values()].at(-1) ?? "";
      this.emit({ type: "message.completed", sessionId: session.id, correlationId: turn.correlationId, text: final });
    }
    if (reason === "error") this.emit({ type: "session.error", sessionId: session.id, message: detail ?? "Codex turn failed." });
    this.emit({ type: "session.ended", sessionId: session.id, reason, ...(detail ? { detail } : {}) });
    turn.settle(reason === "completed" ? undefined : new Error(detail ?? "Codex turn cancelled."));
  }

  private async serverRequest(method: string, params: JsonObject): Promise<{ result: unknown; delivered?: () => void }> {
    this.opts.onTrace?.({ at: "codex.server-request", method, namespace: params.namespace, tool: params.tool });
    const session = typeof params.threadId === "string" ? this.sessions.get(params.threadId) : undefined;
    if (method !== "item/tool/call" || !session?.turn || params.namespace !== "arke" || typeof params.tool !== "string" || typeof params.turnId !== "string" || session.retiredTurns.has(params.turnId) || session.turn.id === null || session.turn.id !== params.turnId) {
      if (session) this.emit({ type: "tool.refused", sessionId: session.id, tool: typeof params.tool === "string" ? params.tool : method, summary: "refused a tool outside this session's capabilities" });
      throw new ConfinementError();
    }
    const turn = session.turn; turn.id ??= params.turnId;
    try {
      const executed = await executeTool(session, params.tool, object(params.arguments), turn.abort.signal);
      return { result: executed.result, delivered: () => {
        if (executed.summary && session.turn === turn && !turn.abort.signal.aborted) this.emit({ type: "tool.activity", sessionId: session.id, tool: `arke.${params.tool}`, summary: executed.summary });
      } };
    } catch (error) {
      const refused = error instanceof ConfinementError || turn.abort.signal.aborted;
      if (refused) this.emit({ type: "tool.refused", sessionId: session.id, tool: `arke.${params.tool}`, summary: "refused a tool outside this session's capabilities" });
      return { result: { success: false, contentItems: [{ type: "inputText", text: refused ? "Denied by Arke Studio confinement." : "The tool could not complete. Check the supplied path, arguments and active world." }] } };
    }
  }
  private failure(error: Error): void {
    this.ready = { ready: false, reason: error.message };
    for (const session of this.sessions.values()) this.finish(session, "error", error.message);
  }
  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId); const turn = session?.turn; if (!session || !turn) return;
    turn.cancelled = true; turn.abort.abort();
    if (turn.id === null) return;
    try { await this.connection().request("turn/interrupt", { threadId: sessionId, turnId: turn.id }); }
    catch { this.finish(session, "error", "Codex could not confirm cancellation."); await this.rpc?.dispose(); throw new Error("Codex could not confirm cancellation."); }
    if (session.turn === turn) this.finish(session, "cancelled");
  }
  private emit(event: HarnessEvent): void { for (const queue of this.queues) queue.push(event); }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    if (signal?.aborted || this.disposed) return;
    const queue = new EventQueue(); this.queues.add(queue);
    const stop = () => queue.close(); signal?.addEventListener("abort", stop, { once: true });
    try { for await (const event of queue) yield event; }
    finally { signal?.removeEventListener("abort", stop); this.queues.delete(queue); }
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.preparations.clear();
    await this.rpc?.dispose(); this.rpc = null;
    this.sessions.clear(); for (const queue of this.queues) queue.close(); this.queues.clear();
    this.ready = { ready: false, reason: "Codex adapter disposed." };
  }
}
