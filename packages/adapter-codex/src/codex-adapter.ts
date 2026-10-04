import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  agentPromptFor, confinementFor, findHarnessModel, harnessModelMissingInput, ROSTER, sessionSkillForAgent, LLM_ENV_NAMES, LLM_ENV_PROVIDERS,
  type CreateSessionInput, type HarnessAdapter, type HarnessCapability, type HarnessEvent, type ModelInfo,
  type Readiness, type SendMessageInput, type SendReceipt, type SessionConfigInput, type SessionRef,
} from "@arke-studio/contracts";
import { CodexRpc, object, type JsonObject } from "./rpc.js";
import { captureRootIdentity } from "./confined-files.js";
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
  /** Whole image operation, including a turn which never publishes completion. */
  imageTimeoutMs?: number;
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
export function confinedConfig(prior: JsonObject, researchWeb: boolean, opts: { imageGeneration?: boolean } = {}): JsonObject {
  const config: JsonObject = {
    "features.shell_tool": false, "features.apps": false, "features.plugins": false,
    "features.multi_agent": false, "features.multi_agent_v2": false, "agents.enabled": false,
    "features.hooks": false, "features.codex_hooks": false,
    // Off for every roster agent: Codex would write the picture wherever it likes, outside Arke's
    // rights and budget path. Only the dedicated image thread below turns it on.
    "features.image_generation": opts.imageGeneration === true,
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
  startPending: boolean;
  correlationId: string;
  items: Map<string, string>;
  phases: Map<string, string>;
  settled: Promise<void>;
  settle: (error?: Error) => void;
  abort: AbortController;
  cancelled: boolean;
}
/** What the Codex login can do for image generation; read from the app-server, never from auth files. */
export interface CodexImageStatus {
  authMode: "chatgpt" | "apiKey" | "other" | "none";
  planType?: string;
  /** The app-server's own answer for the current provider and login. */
  imageGeneration: boolean;
}
/** A picture the new image should follow, as bytes the host already verified. */
export interface CodexImageReference { contentType: "image/png" | "image/jpeg" | "image/webp"; data: Uint8Array }
export interface CodexImageResult { bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp"; revisedPrompt?: string }
/** The plan's image allowance ran out; resetsAt is epoch seconds when Codex reports one. */
export class CodexImageLimitError extends Error {
  constructor(readonly resetsAt: number | null) { super("The Codex plan's image limit has been reached."); this.name = "CodexImageLimitError"; }
}
interface ImageJob {
  turnId: string | null;
  items: JsonObject[];
  settle: (error?: Error) => void;
}
function imageType(bytes: Buffer): CodexImageResult["mimeType"] | null {
  if (bytes.length > 12 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
interface Session extends ToolSession {
  id: string;
  threadId: string;
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
  private readonly threads = new Map<string, Session>();
  private readonly imageJobs = new Map<string, ImageJob>();
  private readonly queues = new Set<EventQueue>();
  private readonly modelLimits = new Map<string, number>();
  private revision = 0;
  private recovery: Promise<void> | null = null;
  private retirement: Promise<void> = Promise.resolve();
  private recoveryEligible = true;
  private environmentChanging = false;
  private environmentUpdate: Promise<void> = Promise.resolve();
  constructor(private readonly opts: CodexAdapterOptions) {}

  capabilities(): ReadonlySet<HarnessCapability> { return new Set(["events", "models"]); }
  readonly imageInput = true;
  imageInputForSession(id: string): boolean { return this.sessions.get(id)?.inputModalities?.includes("image") === true; }
  imageDestinationForSession(id: string) { return { provider: this.sessions.get(id)?.provider ?? "codex", local: false }; }
  readiness(): Readiness { return this.ready; }
  lifecycleRevision(): number { return this.revision; }
  // This argument-free legacy method cannot identify the selected model. Measured limits
  // belong to the matching catalog entry; other models retain the caller's safe fallback.
  knownInputTokenLimit(): null { return null; }
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
      const started = this.rpc !== null || this.initialization !== null || this.recovery !== null;
      this.environmentChanging = true;
      try {
        await this.recovery;
        if (this.initialization) await this.initialization.catch(() => {});
        await this.retirement;
        if (this.disposed) throw new Error("Codex adapter is disposed.");
        await this.rpc?.dispose(); this.rpc = null;
        this.sessions.clear(); this.threads.clear(); this.preparations.clear(); this.modelLimits.clear();
        this.retireImageJobs("Codex credentials changed; reconnecting.");
        this.opts.env = requested;
        this.ready = { ready: false, reason: "Codex credentials changed; reconnecting." };
        if (started) await this.initTransport();
      } finally { this.environmentChanging = false; }
    });
    this.environmentUpdate = update;
    return update;
  }

  async init(): Promise<void> {
    if (this.disposed) throw new Error("Codex adapter is disposed.");
    if (this.recovery) {
      await this.recovery;
      if (!this.ready.ready) throw new Error(this.ready.reason ?? "Codex could not reconnect.");
      return;
    }
    return this.initTransport();
  }
  private async initTransport(): Promise<void> {
    if (this.disposed) throw new Error("Codex adapter is disposed.");
    if (this.ready.ready) return;
    if (this.initialization) return this.initialization;
    this.initialization = this.initialize();
    try { await this.initialization; } finally { this.initialization = null; }
  }
  private async initialize(): Promise<void> {
    const prior = this.rpc; this.rpc = null;
    await prior?.dispose();
    await this.retirement;
    if (this.disposed) throw new Error("Codex adapter is disposed.");
    let healthy = false;
    const rpc = new CodexRpc({ ...this.opts,
      onNotification: (method, params) => { if (this.rpc === rpc) this.notification(method, params); },
      onRequest: async (method, params) => { if (this.rpc !== rpc) throw new ConfinementError(); return this.serverRequest(method, params); },
      onFailure: error => this.failure(rpc, error, healthy),
    });
    this.rpc = rpc;
    try {
      await rpc.start();
      await rpc.request("initialize", { clientInfo: { name: "arke_studio", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      await rpc.write({ method: "initialized" });
      const config = object(object(await rpc.request("config/read", { includeLayers: false })).config);
      if (this.disposed || this.rpc !== rpc) throw new Error("Codex initialization was retired.");
      this.priorConfig = config;
      healthy = true; this.revision++; this.ready = { ready: true };
    } catch (error) {
      if (this.rpc === rpc) this.rpc = null;
      await rpc.dispose();
      if (!this.disposed) this.ready = { ready: false, reason: "Codex app-server could not initialize." };
      throw error;
    }
  }
  private connection(): CodexRpc {
    if (this.environmentChanging) throw new Error("Codex credentials changed; reconnecting.");
    if (!this.rpc || !this.ready.ready) throw new Error(this.ready.reason ?? "Codex is not running.");
    return this.rpc;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.discoverModels();
  }
  private async discoverModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const rpc = this.connection(); const result: ModelInfo[] = []; const seen = new Set<string>();
    const provider = typeof this.priorConfig.model_provider === "string" ? this.priorConfig.model_provider : "openai";
    let cursor: string | null = null;
    do {
      const response = object(await rpc.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, signal));
      if (this.rpc !== rpc || !this.ready.ready) throw new Error("Codex catalog connection was retired.");
      if (!Array.isArray(response.data)) throw new Error("Codex returned an invalid model catalog.");
      for (const raw of response.data) {
        const model = object(raw); if (model.hidden === true) continue;
        if (typeof model.model !== "string" || !model.model || typeof model.id !== "string") throw new Error("Codex returned an invalid model identity.");
        if (result.some(row => row.id === model.model && row.provider === provider)) throw new Error("Codex returned duplicate canonical model identities.");
        result.push({ id: model.model, provider, ...(typeof model.displayName === "string" ? { displayName: model.displayName } : {}), isDefault: model.isDefault === true,
          ...(model.id !== model.model ? { aliases: [model.id] } : {}),
          ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities.filter((value): value is "text" | "image" => value === "text" || value === "image") } : {}),
          ...(this.modelLimits.has(JSON.stringify([provider, model.model])) ? { inputTokenLimit: this.modelLimits.get(JSON.stringify([provider, model.model]))! } : {}),
        });
      }
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
      if (cursor && seen.has(cursor)) throw new Error("Codex repeated a model catalog page.");
      if (cursor) seen.add(cursor);
      if (seen.size > 100) throw new Error("Codex model catalog exceeded its page limit.");
    } while (cursor);
    return result;
  }

  /**
   * Asked of the app-server rather than inferred: an API key or a custom provider can leave the
   * built-in tool out even with the feature on (openai/codex#36832), so the capability probe, not
   * the login type alone, decides whether Codex is offered as an image provider.
   */
  async imageStatus(signal?: AbortSignal): Promise<CodexImageStatus> {
    const rpc = this.connection();
    const account = object(object(await rpc.request("account/read", {}, signal)).account);
    const authMode = account.type === "chatgpt" ? "chatgpt" : account.type === "apiKey" ? "apiKey" : typeof account.type === "string" ? "other" : "none";
    const capability = object(await rpc.request("modelProvider/capabilities/read", {}, signal)).imageGeneration === true;
    return { authMode, ...(authMode === "chatgpt" && typeof account.planType === "string" ? { planType: account.planType } : {}), imageGeneration: capability };
  }

  /**
   * One image from a dedicated thread: no Arke tools, no shell, an empty temporary directory.
   * References travel inline as data-URL images, so nothing of theirs is written to disk here.
   * Bytes come from the item's inline result (the Responses API's base64 field); a path the server
   * reports is never opened, since it names a location this adapter did not choose.
   */
  async generateImage(input: { prompt: string; references?: readonly CodexImageReference[]; model?: string; signal?: AbortSignal }): Promise<CodexImageResult> {
    if (!input.prompt.trim()) throw new Error("An image prompt is required.");
    const callerSignal = input.signal;
    input = { ...input, signal: AbortSignal.any([AbortSignal.timeout(this.opts.imageTimeoutMs ?? 600_000), ...(input.signal ? [input.signal] : [])]) };
    input.signal?.throwIfAborted();
    const status = await this.imageStatus(input.signal);
    if (status.authMode !== "chatgpt" || !status.imageGeneration) throw new Error("Codex image generation is not available for this login.");
    const rpc = this.connection();
    const catalog = await this.discoverModels(input.signal);
    const selected = input.model === undefined ? catalog.find(model => model.isDefault) : findHarnessModel(input.model, catalog);
    if (!selected) throw new Error("Codex did not report a model to generate with.");
    const cwd = await mkdtemp(join(tmpdir(), "arke-codex-image-"));
    let threadId: string | null = null;
    let turnError: Error | null = null;
    try {
      const response = object(await rpc.request("thread/start", {
        model: selected.id, modelProvider: selected.provider, allowProviderModelFallback: false,
        cwd, runtimeWorkspaceRoots: [], ephemeral: true, environments: [], selectedCapabilityRoots: [],
        sandbox: "read-only", approvalPolicy: "untrusted", developerInstructions: "",
        baseInstructions: "Create exactly one image for the request with the image generation tool. Do not run commands or write files. Reply with one short sentence.",
        config: confinedConfig(this.priorConfig, false, { imageGeneration: true }), dynamicTools: [],
      }, input.signal, late => { const lateId = object(object(late).thread).id; if (typeof lateId === "string") void this.releaseImageThread(rpc, lateId); }));
      const id = object(response.thread).id;
      if (typeof id !== "string" || this.imageJobs.has(id) || this.threads.has(id)) throw new Error("Codex returned an unusable thread for image generation.");
      threadId = id;
      if (response.model !== selected.id || response.modelProvider !== selected.provider || (Array.isArray(response.instructionSources) && response.instructionSources.length > 0)) {
        throw new Error("Codex changed the selected model or loaded instructions outside this image thread.");
      }
      let settle!: (error?: Error) => void;
      const settled = new Promise<void>((resolve, reject) => { settle = error => error ? reject(error) : resolve(); });
      // Cancelling while turn/start is pending rejects this before anything awaits it.
      settled.catch(() => {});
      const job: ImageJob = { turnId: null, items: [], settle };
      this.imageJobs.set(id, job);
      this.recoveryEligible = true;
      const stop = () => {
        settle(new Error("Image generation cancelled."));
        // Before turn/started there is no turn to name, and an interrupt with a null id is only
        // refused. The connection is shared with other images, so a refusal retires it only when
        // this job is its sole user; otherwise the thread is unsubscribed below.
        if (job.turnId === null) return;
        void rpc.request("turn/interrupt", { threadId: id, turnId: job.turnId }, AbortSignal.timeout(5000))
          .catch(() => this.retireIfAlone(rpc));
      };
      input.signal?.addEventListener("abort", stop, { once: true });
      let admitted = false;
      try {
        for (const reference of input.references ?? []) {
          if (imageType(Buffer.from(reference.data.subarray(0, 16))) !== reference.contentType) throw new Error("A reference image is not the format it claims.");
        }
        const images = (input.references ?? []).map(reference => ({ type: "image", url: `data:${reference.contentType};base64,${Buffer.from(reference.data).toString("base64")}` }));
        await rpc.request("turn/start", { threadId: id, input: [{ type: "text", text: input.prompt }, ...images], environments: [] }, input.signal);
        admitted = true;
        await settled.catch(error => { turnError = error instanceof Error ? error : new Error(String(error)); });
      } catch (error) {
        // An unanswered or cancelled turn/start may already be generating, and the allowance is
        // spent by generating. Name the turn when it announced itself; otherwise stop the process
        // that holds it, which is the only bounded cancellation left — unless other images share
        // it, in which case the thread is released below and they are left running.
        if (!admitted && job.turnId !== null) await rpc.request("turn/interrupt", { threadId: id, turnId: job.turnId }, AbortSignal.timeout(5000)).catch(() => this.retireIfAlone(rpc));
        else if (!admitted) this.retireIfAlone(rpc);
        throw error;
      } finally { input.signal?.removeEventListener("abort", stop); }
      callerSignal?.throwIfAborted();
      // A finished picture outranks a turn that failed afterwards: the allowance is already spent,
      // so discarding it would record a failure and invite a retry that spends it again.
      for (const item of job.items) {
        if (typeof item.result !== "string" || item.result.length === 0) continue;
        const bytes = Buffer.from(item.result, "base64"); const mimeType = imageType(bytes);
        if (mimeType) return { bytes, mimeType, ...(typeof item.revisedPrompt === "string" ? { revisedPrompt: item.revisedPrompt } : {}) };
      }
      input.signal?.throwIfAborted();
      const failed = job.items.map(item => object(item.failure)).find(failure => failure.type === "usageLimitExceeded");
      if (failed) throw new CodexImageLimitError(typeof failed.resetsAt === "number" ? failed.resetsAt : null);
      const lateError = turnError as Error | null;
      if (lateError) throw lateError;
      throw new Error(job.items.some(item => typeof item.result === "string" && item.result.length > 0) ? "Codex returned data that is not a supported image." : "Codex finished without producing an image.");
    } finally {
      if (threadId) { this.imageJobs.delete(threadId); await this.releaseImageThread(rpc, threadId); }
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }
  /** Ephemeral threads are not archivable (the server refuses and leaves them loaded); unsubscribing is what releases one. */
  private async releaseImageThread(rpc: CodexRpc, threadId: string): Promise<void> {
    await rpc.request("thread/unsubscribe", { threadId }, AbortSignal.timeout(5000)).catch(() => {});
  }
  /** A shared connection is retired only when no other image or session is using it. */
  private retireIfAlone(rpc: CodexRpc): void {
    if (this.rpc === rpc && this.imageJobs.size <= 1 && this.sessions.size === 0) void rpc.dispose();
  }
  private retireImageJobs(reason: string): void { for (const job of this.imageJobs.values()) job.settle(new Error(reason)); }
  private imageNotification(job: ImageJob, method: string, params: JsonObject): void {
    const announced = object(params.turn);
    const id = typeof params.turnId === "string" ? params.turnId : typeof announced.id === "string" ? announced.id : undefined;
    if (!id || (job.turnId !== null && job.turnId !== id)) return;
    if (job.turnId === null) { if (method !== "turn/started") return; job.turnId = id; }
    if (method === "item/completed") { const item = object(params.item); if (item.type === "imageGeneration") job.items.push(item); }
    else if (method === "turn/completed") {
      if (Array.isArray(announced.items)) for (const raw of announced.items) { const item = object(raw); if (item.type === "imageGeneration" && !job.items.some(seen => seen.id === item.id)) job.items.push(item); }
      job.settle(announced.status === "completed" ? undefined : this.imageError(announced.error));
    } else if (method === "error" && params.willRetry !== true) job.settle(this.imageError(params.error));
  }
  private imageError(error: unknown): Error {
    const code = object(error).codexErrorInfo;
    if (code === "usageLimitExceeded") return new CodexImageLimitError(null);
    if (code === "unauthorized") return new Error("Codex image generation is not available for this login.");
    return new Error("Codex could not complete the image. Check its login, model access and quota.");
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
    const missingInput = harnessModelMissingInput(selected, member.name === "stage-designer");
    if (missingInput === "text") throw new Error("This Codex model cannot accept the text instructions required by Arke.");
    if (missingInput === "image") throw new Error("This Codex model cannot inspect Stage images.");
    const researchWeb = member.name !== "stage-designer" && prepared.researchWeb === true;
    const toolSession: ToolSession = { root, rootIdentity: await captureRootIdentity(root, input.signal), confinement: confinementFor(member, { web: researchWeb }), worldQueryUrl: prepared.worldQueryUrl, worldTools: new Map(), inputModalities: selected.inputModalities };
    await discoverWorldTools(toolSession, input.signal);
    const skill = sessionSkillForAgent(member.name, prepared);
    const prompt = agentPromptFor({ ...member, researchWeb, ...(override?.brief !== undefined ? { brief: override.brief } : {}), ...(skill ? { skill } : {}) });
    const config = confinedConfig(this.priorConfig, researchWeb);
    const archiveLate = (value: unknown) => {
      const id = object(object(value).thread).id;
      if (typeof id !== "string") return;
      if (this.rpc === rpc && this.threads.has(id)) { void rpc.dispose(); return; }
      void rpc.request("thread/archive", { threadId: id }).catch(() => {});
    };
    const response = object(await rpc.request("thread/start", {
      model: selected.id, modelProvider: selected.provider, allowProviderModelFallback: false,
      cwd: root, runtimeWorkspaceRoots: [], ephemeral: true, environments: [], selectedCapabilityRoots: [],
      sandbox: "read-only", approvalPolicy: "untrusted", baseInstructions: prompt, developerInstructions: "",
      config, dynamicTools: [{ type: "namespace", name: "arke", description: "Arke Studio's application-owned tools. Use read for actual images.", tools: toolsFor(toolSession) }],
    }, input.signal, archiveLate));
    const threadId = object(response.thread).id;
    if (typeof threadId === "string" && this.rpc === rpc && this.threads.has(threadId)) {
      // Archiving this response would archive the existing session. Retire the faulty
      // transport instead: two distinct preparations cannot share one live wire thread.
      await rpc.dispose();
      throw new Error("Codex reused an active thread identity; its connection was retired.");
    }
    if (typeof threadId !== "string" || response.model !== selected.id || response.modelProvider !== selected.provider || (Array.isArray(response.instructionSources) && response.instructionSources.length > 0)) {
      archiveLate(response); throw new Error("Codex changed the selected model or loaded instructions outside this session.");
    }
    if (input.signal?.aborted || this.rpc !== rpc || !this.ready.ready) { archiveLate(response); throw new Error("Session creation cancelled or its connection was retired."); }
    // Server thread IDs may repeat across processes. Old callers must never address a new
    // session after recovery merely because the replacement server reused an identifier.
    const id = randomUUID();
    const session: Session = { ...toolSession, id, threadId, model: selected.id, provider: selected.provider, turn: null, retiredTurns: new Set(), usage: 0 };
    this.sessions.set(id, session); this.threads.set(threadId, session);
    this.recoveryEligible = true;
    this.opts.onTrace?.({ at: "codex.session-created", sessionId: id, model: selected.id, provider: selected.provider, agent: member.name });
    this.emit({ type: "session.created", sessionId: id });
    return { sessionId: id };
  }

  private async startTurn(input: SendMessageInput): Promise<{ receipt: SendReceipt; turn: Turn }> {
    const session = this.sessions.get(input.sessionId); if (!session) throw new Error("Unknown Codex session.");
    if (input.parts.some(part => part.type === "image") && !this.imageInputForSession(input.sessionId)) throw new Error("This Codex model cannot inspect images.");
    if (session.turn) throw new Error("A Codex turn is already running in this session.");
    const rpc = this.connection(); const correlationId = input.correlationId ?? randomUUID();
    let settle!: (error?: Error) => void;
    const settled = new Promise<void>((resolve, reject) => { settle = error => error ? reject(error) : resolve(); });
    settled.catch(() => {});
    const turn: Turn = { id: null, startPending: true, correlationId, items: new Map(), phases: new Map(), settled, settle, abort: new AbortController(), cancelled: false };
    session.turn = turn;
    try {
      const response = object(await rpc.request("turn/start", { threadId: session.threadId, input: input.parts.map(part => part.type === "text"
        ? { type: "text", text: part.text } : { type: "image", url: `data:${part.mimeType};base64,${part.data}` }), environments: [] }));
      turn.startPending = false;
      const id = object(response.turn).id;
      if (typeof id !== "string" || (turn.id !== null && turn.id !== id)) throw new Error("Codex returned an invalid turn identity.");
      turn.id = id;
      if (turn.cancelled && session.turn === turn) await this.interrupt(session.id);
    } catch (error) {
      if (session.turn === turn) this.finish(session, "error", "Codex could not start the turn.");
      // An uncertain turn/start may already be generating. Stopping our process is the only
      // bounded cancellation available when the server never returned a turn identity.
      await rpc.dispose();
      if (turn.cancelled) throw new Error("Codex turn cancelled.");
      throw error;
    }
    return { receipt: { sessionId: session.id, correlationId }, turn };
  }
  async sendMessage(input: SendMessageInput): Promise<SendReceipt> { const { receipt, turn } = await this.startTurn(input); await turn.settled; return receipt; }
  async dispatchAsync(input: SendMessageInput): Promise<SendReceipt> { return (await this.startTurn(input)).receipt; }
  usageTokens(sessionId: string): number { return this.sessions.get(sessionId)?.usage ?? 0; }

  private notification(method: string, params: JsonObject): void {
    const job = typeof params.threadId === "string" ? this.imageJobs.get(params.threadId) : undefined;
    if (job) { this.imageNotification(job, method, params); return; }
    const session = typeof params.threadId === "string" ? this.threads.get(params.threadId) : undefined;
    if (!session) return;
    const turn = session.turn;
    const announced = object(params.turn);
    const id = typeof params.turnId === "string" ? params.turnId : typeof announced.id === "string" ? announced.id : undefined;
    if (method === "thread/tokenUsage/updated") {
      const usage = object(params.tokenUsage); const total = object(usage.total).totalTokens;
      if (typeof total === "number" && Number.isFinite(total) && total >= session.usage) session.usage = total;
      if (typeof usage.modelContextWindow === "number" && Number.isSafeInteger(usage.modelContextWindow) && usage.modelContextWindow > 0) {
        const key = JSON.stringify([session.provider, session.model]);
        if (this.modelLimits.get(key) !== usage.modelContextWindow) { this.modelLimits.set(key, usage.modelContextWindow); this.revision++; }
      }
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
      const rpc = this.rpc;
      void rpc?.request("turn/interrupt", { threadId: session.threadId, turnId: id }, AbortSignal.timeout(5000)).catch(() => rpc.dispose());
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
    const session = typeof params.threadId === "string" ? this.threads.get(params.threadId) : undefined;
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
  private failure(rpc: CodexRpc, error: Error, wasHealthy: boolean): void {
    if (this.rpc !== rpc) return;
    const mayRecover = wasHealthy && this.recoveryEligible;
    this.recoveryEligible = false;
    this.rpc = null; this.revision++;
    this.ready = { ready: false, reason: error.message };
    for (const session of this.sessions.values()) this.finish(session, "error", error.message);
    this.sessions.clear(); this.threads.clear(); this.preparations.clear(); this.modelLimits.clear();
    this.retireImageJobs(error.message);
    const retired = Promise.resolve().then(() => rpc.dispose());
    this.retirement = retired; void retired.catch(() => {});
    // A replacement that repeatedly initializes and exits must not spin a background
    // restart loop. Only a newly admitted session or image replenishes the recovery allowance.
    if (!mayRecover || this.disposed || this.environmentChanging || this.recovery) return;
    this.ready = { ready: false, reason: "Codex connection failed; reconnecting without replaying the interrupted turn." };
    // Start on the next microtask: CodexRpc must first publish its disposal promise. This
    // makes cleanup single-flight even when failure() was called by dispose() itself.
    const recovery = Promise.resolve().then(async () => {
      await retired;
      if (this.disposed || this.environmentChanging) return;
      await this.initTransport();
    }).catch(() => {
      if (!this.disposed && !this.environmentChanging) this.ready = { ready: false, reason: "Codex could not reconnect. Check its installation and login, then retry." };
    }).finally(() => { if (this.recovery === recovery) this.recovery = null; });
    this.recovery = recovery;
  }
  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId); const turn = session?.turn; if (!session || !turn) return;
    turn.cancelled = true; turn.abort.abort();
    const rpc = this.connection();
    if (turn.startPending) {
      // Even turn/started can precede an unanswered turn/start request. Retire that
      // uncertain transport now so Stop cannot leave generation running until timeout.
      this.finish(session, "cancelled");
      await rpc.dispose();
      return;
    }
    if (turn.id === null) return;
    try { await rpc.request("turn/interrupt", { threadId: session.threadId, turnId: turn.id }); }
    catch { this.finish(session, "error", "Codex could not confirm cancellation."); await rpc.dispose(); throw new Error("Codex could not confirm cancellation."); }
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
    await this.retirement;
    await this.recovery;
    await this.initialization?.catch(() => {});
    await this.environmentUpdate.catch(() => {});
    this.retireImageJobs("Codex adapter disposed.");
    this.sessions.clear(); this.threads.clear(); this.modelLimits.clear(); for (const queue of this.queues) queue.close(); this.queues.clear();
    this.ready = { ready: false, reason: "Codex adapter disposed." };
  }
}
