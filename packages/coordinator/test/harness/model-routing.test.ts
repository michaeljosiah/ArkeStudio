import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  agentForPurpose, VendorAuthStatusSchema, type ClientMessage, type CreateSessionInput, type DomainEvent,
  type HarnessAdapter, type ModelInfo, type SessionConfigInput,
} from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../../src/coordinator.js";
import type { Cipher } from "../../src/credentials/store.js";
import type { DispatchClient } from "../../src/queue/dispatcher.js";
import type { ChildSupervisor } from "../../src/supervisor.js";
import { FakeProvider } from "../queue/fake-provider.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { setProductionModel } from "../../src/productions/ops.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { until, untilAsync } from "../wait.js";

const MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "sonnet", aliases: ["claude-sonnet-5"], displayName: "Sonnet", inputTokenLimit: 200_000 },
  { provider: "anthropic", id: "opus[1m]", displayName: "Opus", inputModalities: ["text", "image"] },
  { provider: "openai", id: "spark", displayName: "Spark", inputModalities: ["text"] },
  { provider: "custom-provider", id: "region/model:fast", displayName: "Custom model" },
  { provider: "ollama", id: "gemma4:12b", displayName: "Gemma 4 12B", inputTokenLimit: 131_072 },
  { provider: "ollama", id: "gemma4:e2b-it-qat", displayName: "Gemma 4 E2B" },
  { provider: "ollama", id: "qwen3-vl:8b", displayName: "Qwen3 VL", inputModalities: ["text", "image"] },
];
const LOCAL_VISION = "ollama/qwen3-vl:8b";
/** The catalogue with nothing local in it: what a machine without Ollama sees. */
const CLOUD_ONLY = MODELS.filter((model) => model.provider !== "ollama");
const LOCAL = "ollama/gemma4:12b";
const LOCAL_SMALL = "ollama/gemma4:e2b-it-qat";
/** What Ollama has pulled when the catalogue is MODELS: the harness lists exactly what it was handed (issue 1247). */
const PULLED = MODELS.filter((model) => model.provider === "ollama").map((model) => ({ id: model.id, contextLength: 262144, tools: true, vision: model.inputModalities?.includes("image") ?? false }));

/** A reversible fake cipher that is very visibly not the plaintext. */
const fakeCipher: Cipher = {
  isAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString("hex")}`),
  decryptString: (buf) => Buffer.from(buf.toString().slice(4), "hex").toString(),
};
const CHAT = "anthropic/sonnet";
const STAGE = "anthropic/opus[1m]";
const TEXT = "openai/spark";
const CUSTOM = "custom-provider/region/model:fast";

/** Capture the real coordinator preparation boundary, then stop before any generation. */
class CaptureAdapter implements HarnessAdapter {
  readonly id = "model-routing-test";
  ready = true;
  revision = 0;
  initCalls = 0;
  disposeCalls = 0;
  initError: Error | undefined;
  list: () => Promise<ModelInfo[]> = async () => MODELS;
  readonly preparations = new Map<string, SessionConfigInput>();
  readonly sessions: Array<{ agent?: string; config: SessionConfigInput }> = [];
  capabilities() { return new Set(["models", "events"] as const); }
  readiness() { return { ready: this.ready, ...(this.ready ? {} : { reason: "not initialized" }) }; }
  lifecycleRevision() { return this.revision; }
  async init() {
    this.initCalls++;
    if (this.initError) throw this.initError;
    this.ready = true;
  }
  async dispose() { this.disposeCalls++; this.ready = false; }
  async listModels() { return this.list(); }
  prepareSession(input: SessionConfigInput) { this.preparations.set(input.preparationId!, input); }
  abandonSessionPreparation(id: string) { this.preparations.delete(id); }
  async createSession(input: CreateSessionInput): Promise<{ sessionId: string }> {
    const config = this.preparations.get(input.preparationId!);
    assert.ok(config, "every session receives its own captured preparation");
    this.sessions.push({ agent: input.agent, config: structuredClone(config) });
    throw new Error("Test captured preparation; no generation was started.");
  }
  async sendMessage(): Promise<never> { throw new Error("unexpected generation"); }
  async dispatchAsync(): Promise<never> { throw new Error("unexpected generation"); }
  async *streamEvents() {}
}

async function fixture(options: {
  adapter?: CaptureAdapter;
  agents?: Record<string, { model?: string; brief?: string }>;
  production?: string;
  /** A cipher makes a credential store exist, so a cloud key can be stored (issue 1247). */
  cipher?: Cipher;
  /** The shipped manifest, with Ollama answering as a running local runtime so its rows pass the gate. */
  manifest?: boolean;
  /** What Ollama has pulled, with a publication hook: the first-run path the local default waits on (issue 1247). */
  localModels?: Array<{ id: string; contextLength?: number; tools: boolean; vision: boolean; assumed?: true }>;
  /** Ollama's answer to each listing, when it is not simply the list above: it may be a refusal. */
  listLocalModels?: () => Promise<Array<{ id: string; contextLength?: number; tools: boolean; vision: boolean; assumed?: true }>>;
  onPublish?: () => void | Promise<void>;
  /** A harness process under supervision, so a test can fail it and bring it back (issue 1247). */
  supervisor?: ChildSupervisor;
} = {}) {
  const { root, worldDir } = await makeTempRoot();
  if (options.agents) await writeFile(join(root, "settings.json"), JSON.stringify({ agents: options.agents }), "utf8");
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  if (options.production) await setProductionModel(provider.openStore()!, "saltlight", "llm", options.production);
  const adapter = options.adapter ?? new CaptureAdapter();
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider, adapter, appRoot: root, appVersion: "test", authoring: { agentForPurpose },
    changeLogPath: join(root, "changes.jsonl"), observeEvent: event => events.push(event),
    ...(options.cipher ? { cipher: options.cipher } : {}),
    ...(options.localModels || options.listLocalModels ? {
      dispatchClients: { ollama: Object.assign(new FakeProvider(), { listModels: options.listLocalModels ?? (async () => options.localModels!) }) as DispatchClient },
      publishLocalHarnessModels: async () => { await options.onPublish?.(); },
    } : {}),
    ...(options.manifest ? {
      manifest: SHIPPED_MANIFEST,
      validators: { ollama: { validateKey: async () => [{ capability: "llm" as const, available: true }] } },
    } : {}),
  });
  if (options.supervisor) coordinator.superviseAs("harness", options.supervisor);
  await coordinator.start(0);
  const send = (message: ClientMessage) => (coordinator as unknown as {
    handleClientMessage(message: ClientMessage): Promise<void>;
  }).handleClientMessage(message);
  const close = async () => { await coordinator.stop(); await provider.close(); };
  // The catalogue is fetched as soon as the harness is ready (issue 1247), so a test that wants
  // the next validation to find discovery pending first makes what is cached stale.
  const staleCatalogue = () => (coordinator as unknown as { modelCatalog: { invalidate(): void } }).modelCatalog.invalidate();
  // The runtime probe runs on a thirty-second timer; a test that wants the next tick asks for it.
  const probeLocalRuntimes = () => (coordinator as unknown as { revalidateLocalRuntimes(): Promise<void> }).revalidateLocalRuntimes();
  const settings = async () => JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as { agents?: Record<string, { model?: string; brief?: string }> };
  const chat = async (modelId?: string) => {
    await send({ kind: "world-chat-create", worldId: WORLD_ID, requestId: randomUUID(), title: "Model routing",
      entryContext: { kind: "production", productionId: "saltlight" } });
    const conversationId = coordinator.getState().worldChat!.conversationId;
    await send({ kind: "world-chat-send", worldId: WORLD_ID, requestId: randomUUID(), conversationId,
      text: "Explain the current production.", attachmentIds: [], ...(modelId ? { modelId } : {}) });
    return adapter.sessions.filter(session => session.agent === "world-builder").at(-1);
  };
  const stage = async () => {
    const scene = provider.openStore()!.getBundle().productions.find(production => production.meta.id === "saltlight")!.scenes.find(scene => scene.id === "sc_04")!;
    const requestId = randomUUID();
    await send({ kind: "stage-construct", worldId: WORLD_ID, productionId: "saltlight", sceneId: scene.id,
      shotId: "sh_12", baseVersion: scene.version, requestId, instruction: "Frame the scene.", preserve: "none" });
    await until(() => events.some(event => event.type === "stage.construction" && event.requestId === requestId && event.status === "failed"), "Stage's terminal test result");
    return events.findLast(event => event.type === "stage.construction" && event.requestId === requestId);
  };
  return { root, worldDir, coordinator, adapter, provider, events, send, settings, chat, stage, close, staleCatalogue, probeLocalRuntimes };
}

describe("coordinator harness/model routing (#1122)", () => {
  it("initializes an owned adapter without an OpenCode supervisor and disposes it on shutdown", async () => {
    const adapter = new CaptureAdapter();
    adapter.ready = false;
    const test = await fixture({ adapter });
    try {
      await until(() => test.coordinator.getState().app.health.harness.status === "healthy", "independent harness initialization");
      assert.equal(adapter.initCalls, 1);
      await test.send({ kind: "list-harness-models" });
      assert.deepEqual(test.coordinator.getState().app.harnessModels, MODELS);
      adapter.ready = false;
      await until(() => test.coordinator.getState().app.health.harness.status === "unavailable", "owned harness process failure");
      assert.equal(test.coordinator.getState().app.harnessModelStatus.status, "idle", "process failure invalidates the retained catalog");
      adapter.list = async () => [MODELS[1]!];
      adapter.ready = true;
      await until(() => test.coordinator.getState().app.harnessModels.length === 1, "automatic catalog refresh after readiness recovers");
      assert.deepEqual(test.coordinator.getState().app.harnessModels, [MODELS[1]!]);
      assert.equal(test.coordinator.getState().app.harnessModelStatus.status, "ready");
    } finally { await test.close(); }
    assert.equal(adapter.disposeCalls, 1);
  });

  it("publishes catalog loading, metadata, failure, and recovery rather than disguising errors as empty", async () => {
    const test = await fixture();
    try {
      let resolve!: (models: ModelInfo[]) => void;
      test.adapter.list = () => new Promise(done => { resolve = done; });
        test.staleCatalogue();
      const pending = test.send({ kind: "list-harness-models" });
      await until(() => test.coordinator.getState().app.harnessModelStatus.status === "loading", "catalog loading");
      resolve(MODELS);
      await pending;
      assert.equal(test.coordinator.getState().app.harnessModelStatus.status, "ready");
      assert.deepEqual(test.coordinator.getState().app.harnessModels, MODELS);
      test.adapter.list = async () => { throw new Error("Sign in to the harness, then retry."); };
      await test.send({ kind: "list-harness-models" });
      assert.equal(test.coordinator.getState().app.harnessModelStatus.status, "error");
      assert.match(test.coordinator.getState().app.harnessModelStatus.reason ?? "", /retry models/i);
      assert.deepEqual(test.coordinator.getState().app.harnessModels, MODELS, "saved choices still have names during an outage");
      test.adapter.list = async () => [];
      await test.send({ kind: "list-harness-models" });
      assert.deepEqual(test.coordinator.getState().app.harnessModelStatus, { status: "ready" });
      assert.deepEqual(test.coordinator.getState().app.harnessModels, []);
    } finally { await test.close(); }
  });

  it("automatically refreshes the displayed catalog when an owned process recovers between health polls", async () => {
    const test = await fixture();
    try {
      await until(() => test.coordinator.getState().app.health.harness.status === "healthy", "owned harness readiness");
      await test.send({ kind: "list-harness-models" });
      assert.equal(test.coordinator.getState().app.harnessModelStatus.status, "ready");
      let resolve!: (models: ModelInfo[]) => void;
      test.adapter.list = () => new Promise(done => { resolve = done; });
        test.staleCatalogue();
      test.adapter.revision++;
      await until(() => test.coordinator.getState().app.harnessModelStatus.status === "loading", "automatic replacement catalog discovery");
      assert.equal(test.coordinator.getState().app.health.harness.status, "healthy");
      assert.deepEqual(test.coordinator.getState().app.harnessModels, MODELS, "old names remain visible while being reverified");
      resolve([MODELS[1]!]);
      await until(() => test.coordinator.getState().app.harnessModelStatus.status === "ready", "replacement catalog publication without a user command");
      assert.deepEqual(test.coordinator.getState().app.harnessModels, [MODELS[1]!]);
    } finally { await test.close(); }
  });

  it("validates new choices against the live catalog, preserves briefs, and permits clearing during an outage", async () => {
    const test = await fixture();
    try {
      await test.send({ kind: "set-agent-config", agent: "world-builder", model: "anthropic/claude-sonnet-5", brief: "A deliberate chat brief." });
      assert.deepEqual((await test.settings()).agents?.["world-builder"], { model: CHAT, brief: "A deliberate chat brief." });
      await test.send({ kind: "set-production-model", worldId: WORLD_ID, productionId: "saltlight", capability: "llm", modelId: CUSTOM });
      assert.equal(test.provider.openStore()!.getBundle().productions.find(production => production.meta.id === "saltlight")!.meta.models?.llm, CUSTOM);
      await test.send({ kind: "set-agent-config", agent: "world-builder", model: "missing/model" });
      assert.equal((await test.settings()).agents?.["world-builder"]?.model, CHAT);
      await test.send({ kind: "set-production-model", worldId: WORLD_ID, productionId: "saltlight", capability: "llm", modelId: "missing/model" });
      assert.equal(test.provider.openStore()!.getBundle().productions.find(production => production.meta.id === "saltlight")!.meta.models?.llm, CUSTOM);
      assert.equal(test.events.filter(event => event.type === "command.failed").length, 2);
      test.adapter.list = async () => { throw new Error("catalog offline"); };
      await test.send({ kind: "list-harness-models" });
      await test.send({ kind: "set-agent-config", agent: "world-builder", model: null });
      await test.send({ kind: "set-production-model", worldId: WORLD_ID, productionId: "saltlight", capability: "llm", modelId: null });
      assert.deepEqual((await test.settings()).agents?.["world-builder"], { brief: "A deliberate chat brief." });
      assert.equal(test.provider.openStore()!.getBundle().productions.find(production => production.meta.id === "saltlight")!.meta.models?.llm, undefined);
    } finally { await test.close(); }
  });

  it("captures turn, agent, production, and default precedence in real chat session preparation", async () => {
    // Cloud only, so "nothing chosen" ends at the harness default rather than a local model.
    const adapter = new CaptureAdapter();
    adapter.list = async () => CLOUD_ONLY;
    const test = await fixture({ adapter, production: TEXT, agents: { "world-builder": { model: CHAT, brief: "Chat brief." } } });
    try {
      assert.equal((await test.chat())?.config.model, CHAT);
      assert.equal((await test.chat(CUSTOM))?.config.model, CUSTOM);
      await test.send({ kind: "set-agent-config", agent: "world-builder", model: null });
      assert.equal((await test.chat())?.config.model, TEXT);
      await test.send({ kind: "set-production-model", worldId: WORLD_ID, productionId: "saltlight", capability: "llm", modelId: null });
      assert.equal((await test.chat())?.config.model, undefined);
      assert.equal(test.adapter.sessions.filter(session => session.agent === "world-builder").length, 4);
      assert.equal(test.adapter.sessions.find(session => session.agent === "world-builder")?.config.agents?.["world-builder"]?.brief, "Chat brief.");
      const count = test.adapter.sessions.filter(session => session.agent === "world-builder").length;
      await test.chat("missing/model");
      assert.equal(test.adapter.sessions.filter(session => session.agent === "world-builder").length, count, "a bad explicit choice must not fall through to a runnable default");
      assert.ok(test.coordinator.getState().worldChat?.lastFailure, "the refusal stays visible in the conversation");
    } finally { await test.close(); }
  });

  for (const oldModel of [CHAT, "missing/model"]) {
    it(`keeps later agent clears and brief edits after validating ${oldModel}`, async () => {
      const test = await fixture({ agents: { "world-builder": { model: TEXT } } });
      try {
        let resolve!: (models: ModelInfo[]) => void;
        test.adapter.list = () => new Promise(done => { resolve = done; });
        test.staleCatalogue();
        const oldChoice = test.send({ kind: "set-agent-config", agent: "world-builder", model: oldModel, brief: "Old brief" });
        await until(() => test.coordinator.getState().app.harnessModelStatus.status === "loading", "delayed agent validation");
        const otherAgent = test.send({ kind: "set-agent-config", agent: "stage-designer", model: STAGE });
        await test.send({ kind: "set-agent-config", agent: "world-builder", model: null, brief: "Latest brief" });
        assert.deepEqual((await test.settings()).agents?.["world-builder"], { brief: "Latest brief" }, "clear does not wait for model discovery");
        resolve(MODELS);
        await Promise.all([oldChoice, otherAgent]);
        assert.deepEqual((await test.settings()).agents?.["world-builder"], { brief: "Latest brief" });
        assert.equal((await test.settings()).agents?.["stage-designer"]?.model, STAGE, "another agent has an independent choice");
        assert.equal(test.events.filter(event => event.type === "command.failed").length, 0, "a superseded invalid choice must not report a stale failure");
      } finally { await test.close(); }
    });
  }

  it("supersedes agent fields independently while model discovery is pending", async () => {
    const test = await fixture();
    try {
      let resolve!: (models: ModelInfo[]) => void;
      test.adapter.list = () => new Promise(done => { resolve = done; });
        test.staleCatalogue();
      const oldChoice = test.send({ kind: "set-agent-config", agent: "world-builder", model: CHAT, brief: "Keep this brief" });
      await until(() => test.coordinator.getState().app.harnessModelStatus.status === "loading", "delayed agent choice");
      const latestChoice = test.send({ kind: "set-agent-config", agent: "world-builder", model: CUSTOM });
      const stageChoice = test.send({ kind: "set-agent-config", agent: "stage-designer", model: STAGE, brief: "Old Stage brief" });
      await test.send({ kind: "set-agent-config", agent: "stage-designer", brief: "Latest Stage brief" });
      resolve(MODELS);
      await Promise.all([oldChoice, latestChoice, stageChoice]);
      assert.deepEqual((await test.settings()).agents?.["world-builder"], { model: CUSTOM, brief: "Keep this brief" });
      assert.deepEqual((await test.settings()).agents?.["stage-designer"], { model: STAGE, brief: "Latest Stage brief" });
    } finally { await test.close(); }
  });

  for (const latestModel of [null, CUSTOM]) {
    it(`keeps a later production ${latestModel === null ? "clear" : "choice"} after delayed model validation`, async () => {
      const test = await fixture({ production: TEXT });
      try {
        let resolve!: (models: ModelInfo[]) => void;
        test.adapter.list = () => new Promise(done => { resolve = done; });
        test.staleCatalogue();
        const oldChoice = test.send({ kind: "set-production-model", worldId: WORLD_ID, productionId: "saltlight", capability: "llm", modelId: CHAT });
        await until(() => test.coordinator.getState().app.harnessModelStatus.status === "loading", "delayed production validation");
        const latestChoice = test.send({ kind: "set-production-model", worldId: WORLD_ID, productionId: "saltlight", capability: "llm", modelId: latestModel });
        if (latestModel === null) {
          await latestChoice;
          assert.equal(test.provider.openStore()!.getBundle().productions.find(production => production.meta.id === "saltlight")!.meta.models?.llm, undefined, "clear completes during discovery");
        }
        await test.send({ kind: "set-production-model", worldId: WORLD_ID, productionId: "saltlight", capability: "image", modelId: "image/independent" });
        resolve(MODELS);
        await Promise.all([oldChoice, latestChoice]);
        const models = JSON.parse(await readFile(join(test.worldDir, "productions", "saltlight", "production.json"), "utf8")).models;
        assert.equal(models.llm, latestModel ?? undefined);
        assert.equal(models.image, "image/independent", "other capabilities are not superseded by a language model choice");
      } finally { await test.close(); }
    });
  }

  it("runs Stage with its image-capable override even when the production uses a text-only model", async () => {
    const test = await fixture({ production: TEXT, agents: { "stage-designer": { model: STAGE, brief: "Stage brief." } } });
    try {
      await test.stage();
      const stage = test.adapter.sessions.find(session => session.agent === "stage-designer");
      assert.ok(stage, "Stage passed model admission and reached prepared session creation");
      assert.equal(stage.config.model, STAGE);
      assert.deepEqual(stage.config.agents?.["stage-designer"], { model: STAGE, brief: "Stage brief." });
      assert.equal(stage.config.researchWeb, false);
    } finally { await test.close(); }
  });

  it("refuses a saved text-only Stage override instead of using the compatible production fallback", async () => {
    const test = await fixture({ production: STAGE, agents: { "stage-designer": { model: TEXT } } });
    try {
      const event = await test.stage();
      assert.ok(event?.type === "stage.construction");
      assert.match(event.detail ?? "", /cannot read images/);
      assert.equal(test.adapter.sessions.length, 0);
      await test.send({ kind: "set-agent-config", agent: "stage-designer", model: TEXT });
      assert.ok(test.events.some(event => event.type === "command.failed" && /cannot read images/.test(event.reason)));
    } finally { await test.close(); }
  });
});

describe("the local default when nobody chose and nothing cloud is paid for (issue 1247)", () => {
  it("fills every agent left without a model from the local runtime, beneath dispatch and overrides", async () => {
    const test = await fixture({ agents: { "world-builder": { model: CHAT, brief: "Chat brief." } } });
    try {
      const session = await test.chat();
      // Chat resolves the world-builder's own override into the dispatch choice, as before.
      assert.equal(session?.config.model, CHAT);
      assert.equal(session?.config.agents?.["world-builder"]?.model, CHAT, "a Settings override is the agent's own");
      assert.equal(session?.config.agents?.["world-builder"]?.brief, "Chat brief.");
      assert.equal(session?.config.agents?.["scene-writer"]?.model, LOCAL, "an agent with no override runs locally");
      assert.equal((await test.chat(CUSTOM))?.config.model, CUSTOM, "a dispatch choice still wins");
    } finally { await test.close(); }
  });

  it("takes the first local row the admission gate lets through, under the shipped manifest", async () => {
    const test = await fixture({ manifest: true });
    try {
      // Under the shipped manifest a local row is gated on the runtime's own status, so the
      // choice waits for Ollama to have answered the poll, as it would on a real machine.
      await until(() => test.coordinator.getState().app.providers.some((p) => p.id === "ollama" && p.validation === "valid"), "Ollama answering");
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL);
      await test.send({ kind: "set-model-enabled", modelId: "gemma4-12b", enabled: false });
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === LOCAL_SMALL, "the next admissible local row once the first is switched off");
    } finally { await test.close(); }
  });

  it("stands down the moment a cloud key is stored, and returns when it is cleared", async () => {
    const test = await fixture({ cipher: fakeCipher });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL);
      // The very next session after the command reports done, not one after the harness relaunch.
      await test.send({ kind: "set-credential", provider: "anthropic", key: "sk-ant-test-key" });
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, undefined, "the harness default once a key exists");
      await test.send({ kind: "clear-credential", provider: "anthropic" });
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL, "local again once the key is gone");
    } finally { await test.close(); }
  });

  it("keeps the validated local default on Arke's own lane even when a cloud key is stored (issue 1247)", async () => {
    // The local harness cannot spend a cloud key, so a stored one must not hand the choice back
    // to the adapter: it would pick for itself, past the disabled-model and Stage image checks.
    const adapter = new CaptureAdapter();
    Object.defineProperty(adapter, "id", { value: "arke" });
    const test = await fixture({ adapter, cipher: fakeCipher });
    try {
      await test.send({ kind: "set-credential", provider: "anthropic", key: "sk-ant-test-key" });
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL, "the application's local default, key or no key");
    } finally { await test.close(); }
  });

  it("waits for the first local-model publication and its reload before deciding, on a fresh start", async () => {
    // Before publication the harness lists only cloud rows; the publication is what makes the
    // local rows appear on the next fetch — as the profile write does for the real harness.
    const adapter = new CaptureAdapter();
    adapter.list = async () => CLOUD_ONLY;
    const test = await fixture({ adapter, localModels: PULLED, onPublish: () => { adapter.list = async () => MODELS; } });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL, "the first session saw the rows the publication brought");
    } finally { await test.close(); }
  });

  it("does not choose from rows kept after a failed refresh", async () => {
    const test = await fixture();
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL);
      test.adapter.list = async () => { throw new Error("discovery is down"); };
      await test.send({ kind: "list-harness-models" });
      await until(() => test.coordinator.getState().app.harnessModelStatus.status === "error", "the failed refresh");
      assert.ok(test.coordinator.getState().app.harnessModels.length > 0, "the old rows are still on display");
      const before = test.adapter.sessions.length;
      await test.chat();
      assert.equal(test.adapter.sessions.length, before, "but not chosen from: no session was built");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /could not be read/);
    } finally { await test.close(); }
  });

  it("gives Stage the first local model that reads images, and chat the first that reads text", async () => {
    const test = await fixture();
    try {
      await test.stage();
      const stage = test.adapter.sessions.find(session => session.agent === "stage-designer");
      assert.ok(stage, "Stage passed model admission on the local default rather than refusing");
      assert.equal(stage.config.model, LOCAL_VISION);
      assert.equal(stage.config.agents?.["stage-designer"]?.model, LOCAL_VISION);
      assert.equal(stage.config.agents?.["world-builder"]?.model, LOCAL, "text agents keep the first text-capable row");
      assert.equal((await test.chat())?.config.model, LOCAL, "chat with nothing chosen is decided the same way");
    } finally { await test.close(); }
  });

  it("refuses a keyless session when the catalogue could not be read, rather than running on the cloud default", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => { throw new Error("discovery is down"); };
    const test = await fixture({ adapter });
    try {
      assert.equal(await test.chat(), undefined, "no session is built on a catalogue nobody could read");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /could not be read/);
      // The catalogue read and holding nothing local is a different answer: the harness default.
      adapter.list = async () => CLOUD_ONLY;
      await test.send({ kind: "list-harness-models" });
      await until(() => test.coordinator.getState().app.harnessModelStatus.status === "ready", "the catalogue read");
      assert.deepEqual((await test.chat())?.config.agents ?? {}, {});
    } finally { await test.close(); }
  });

  it("leaves a harness with no catalogue alone: no local default, and no refusal either", async () => {
    const adapter = new CaptureAdapter();
    adapter.capabilities = () => new Set(["events"] as const) as unknown as ReturnType<CaptureAdapter["capabilities"]>;
    Object.defineProperty(adapter, "listModels", { value: undefined });
    const test = await fixture({ adapter });
    try {
      const session = await test.chat();
      assert.ok(session, "a keyless session on a catalogue-less harness still opens, as it always did");
      assert.deepEqual(session.config.agents ?? {}, {});
    } finally { await test.close(); }
  });

  it("counts an account connected through the harness's own sign-in as a cloud credential", async () => {
    const test = await fixture();
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL);
      (test.coordinator as unknown as { emit(event: DomainEvent): void }).emit({
        at: new Date().toISOString(), type: "vendor-auth.status",
        auth: VendorAuthStatusSchema.parse({ available: true, vendors: [
          { id: "anthropic", name: "Anthropic", methods: [], connections: [{ kind: "env", name: "ANTHROPIC_API_KEY" }] },
        ] }),
      });
      // An env connection is Studio's own key as the harness saw it at spawn; the store, read at
      // the command, is the authority on whether that key still exists.
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL, "a published env connection is not a second credential");
      (test.coordinator as unknown as { emit(event: DomainEvent): void }).emit({
        at: new Date().toISOString(), type: "vendor-auth.status",
        auth: VendorAuthStatusSchema.parse({ available: true, vendors: [
          { id: "openai", name: "OpenAI", methods: [], connections: [{ kind: "stored", id: "c1", label: "OpenAI account" }] },
        ] }),
      });
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, undefined, "a connected vendor stands the local default down");
    } finally { await test.close(); }
  });

  it("settles the catalogue gate for an adapter with nothing to initialise", async () => {
    const adapter = new CaptureAdapter();
    Object.defineProperty(adapter, "init", { value: undefined });
    const test = await fixture({ adapter });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL);
    } finally { await test.close(); }
  });

  it("refuses a keyless session while Ollama is not answering, and decides once it has listed", async () => {
    // Not answering and nothing pulled both publish no rows. Only the second is a machine with
    // no local model; the first is the bundled runtime still starting, and a session decided
    // on it would run on the cloud default with a pulled model a few seconds away.
    const adapter = new CaptureAdapter();
    adapter.list = async () => CLOUD_ONLY;
    let answering = false;
    const test = await fixture({ adapter, listLocalModels: async () => {
      if (!answering) throw new Error("ECONNREFUSED 127.0.0.1:11434");
      return PULLED;
    }, onPublish: () => { if (answering) adapter.list = async () => MODELS; } });
    try {
      assert.equal(await test.chat(), undefined, "no session is built while the runtime has not answered");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /not available to the harness yet/);
      answering = true;
      await test.probeLocalRuntimes();
      // Listed, published, and not yet in the catalogue: still not decided on the old catalogue.
      assert.equal(await test.chat(), undefined, "the reload window after a changed listing is refused, not run unmodelled");
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === LOCAL, "the local default once the runtime has listed", 10_000);
    } finally { await test.close(); }
  });

  it("refuses rather than going unmodelled when every local model is passed over", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => [{ provider: "ollama", id: "chatty:7b", tools: false }, ...CLOUD_ONLY];
    const test = await fixture({ adapter });
    try {
      assert.equal(await test.chat(), undefined, "a local runtime with only tool-less models is not nothing local");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /None of the local models/);
      assert.equal((await test.chat("ollama/chatty:7b"))?.config.model, "ollama/chatty:7b", "chosen on purpose, it is still admitted");
    } finally { await test.close(); }
  });

  it("keeps an agent's own Settings model when no local default qualifies", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => [{ provider: "ollama", id: "chatty:7b", tools: false }, ...CLOUD_ONLY];
    const test = await fixture({ adapter, agents: { "world-builder": { model: CHAT } } });
    try {
      const session = await test.chat();
      assert.ok(session, "a session whose agent has a model of its own is never refused for lacking a default");
      assert.equal(session.config.agents?.["world-builder"]?.model, CHAT);
    } finally { await test.close(); }
  });

  it("re-opens the sign-in gate when a harness that had failed comes back", async () => {
    const adapter = new CaptureAdapter();
    adapter.capabilities = () => new Set(["models", "events", "auth"] as const) as unknown as ReturnType<CaptureAdapter["capabilities"]>;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(adapter, { listIntegrations: async () => {
      await released;
      return [{ id: "openai", name: "OpenAI", methods: [], connections: [{ kind: "stored", id: "c1", label: "OpenAI account" }], needsSignIn: false }];
    } });
    const supervisor = Object.assign(new EventEmitter(), {
      id: "harness", status: "stopped", start: async () => {}, stop: async () => {}, restart: async () => {},
    }) as unknown as ChildSupervisor;
    const test = await fixture({ adapter, supervisor });
    try {
      supervisor.emit("status", { id: "harness", status: "failed", reason: "the child exited" });
      supervisor.emit("status", { id: "harness", status: "healthy" });
      await until(() => adapter.initCalls === 1, "the returning harness initialised");
      let decided = false;
      const pending = test.chat().finally(() => { decided = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(decided, false, "a keyless session waits for the returning harness's sign-in read, not the failure's settlement");
      release();
      const session = await pending;
      assert.ok(session, "built once the sign-in state was read");
      assert.equal(session.config.agents?.["world-builder"]?.model, undefined, "the connected account stood the local default down");
    } finally { await test.close(); }
  });

  it("settles a re-opened gate only from the returning harness's own read, not a read the failure outlived", async () => {
    const adapter = new CaptureAdapter();
    adapter.capabilities = () => new Set(["models", "events", "auth"] as const) as unknown as ReturnType<CaptureAdapter["capabilities"]>;
    const releases: Array<() => void> = [];
    // Each lifecycle's read answers non-empty, or the patient seed would ask again and take the
    // other lifecycle's answer; the first finds no connection, the second finds one.
    const reads: Array<Array<{ id: string; name: string; methods: never[]; connections: Array<{ kind: "stored"; id: string; label: string }>; needsSignIn: boolean }>> = [
      [{ id: "openai", name: "OpenAI", methods: [], connections: [], needsSignIn: false }],
      [{ id: "openai", name: "OpenAI", methods: [], connections: [{ kind: "stored", id: "c1", label: "OpenAI account" }], needsSignIn: false }],
    ];
    Object.assign(adapter, { listIntegrations: async () => {
      const answer = reads.shift() ?? [];
      await new Promise<void>((resolve) => releases.push(resolve));
      return answer;
    } });
    const supervisor = Object.assign(new EventEmitter(), {
      id: "harness", status: "stopped", start: async () => {}, stop: async () => {}, restart: async () => {},
    }) as unknown as ChildSupervisor;
    const test = await fixture({ adapter, supervisor });
    try {
      supervisor.emit("status", { id: "harness", status: "healthy" });
      await until(() => releases.length === 1, "the first lifecycle's sign-in read is out");
      // An exit inside the restart budget: `unhealthy`, then the replacement's `healthy`.
      supervisor.emit("status", { id: "harness", status: "unhealthy", reason: "the child exited" });
      supervisor.emit("status", { id: "harness", status: "healthy" });
      await until(() => adapter.initCalls === 2, "the returning harness initialised");
      let decided = false;
      const pending = test.chat().finally(() => { decided = true; });
      releases[0]!();
      await until(() => releases.length === 2, "the returning lifecycle's own read is out");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(decided, false, "the first lifecycle's read settling must not open the returning one's gate");
      releases[1]!();
      const session = await pending;
      assert.equal(session?.config.agents?.["world-builder"]?.model, undefined, "decided on the returning harness's read, which found a connected account");
    } finally { await test.close(); }
  });

  it("ends a keyless chat at its Stop while its configuration is still waiting on discovery", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => CLOUD_ONLY;
    const test = await fixture({ adapter, localModels: [{ id: "gemma4:12b", contextLength: 262144, tools: true, vision: false }] });
    try {
      await test.send({ kind: "world-chat-create", worldId: WORLD_ID, requestId: randomUUID(), title: "Stopped early",
        entryContext: { kind: "production", productionId: "saltlight" } });
      const conversationId = test.coordinator.getState().worldChat!.conversationId;
      const pending = test.send({ kind: "world-chat-send", worldId: WORLD_ID, requestId: randomUUID(), conversationId,
        text: "Explain the current production.", attachmentIds: [] });
      await until(() => test.coordinator.getState().worldChat?.runStatus !== null, "the turn admitted and waiting on discovery");
      await test.send({ kind: "world-chat-cancel", worldId: WORLD_ID, conversationId });
      // Well inside the reload delay the configuration is waiting on: the Stop ended the wait.
      // (The send itself also awaits the conversation's naming pass, which is not the turn.)
      await until(() => test.coordinator.getState().worldChat?.runStatus === null, "the turn ended at the Stop", 2_000);
      await pending;
      assert.equal(test.adapter.sessions.filter((session) => session.agent === "world-builder").length, 0, "no session was built for a stopped turn");
    } finally { await test.close(); }
  });

  it("keeps asking for the catalogue until it lists the rows that were published, when the reload outlasts the delay", async () => {
    // The harness reloads its profile in about three seconds (measured); a fetch that lands
    // before it has is a successful read of the old rows, and must not count as carried.
    const adapter = new CaptureAdapter();
    adapter.list = async () => CLOUD_ONLY;
    const test = await fixture({ adapter, localModels: PULLED });
    try {
      assert.equal(await test.chat(), undefined, "the read that beat the reload does not open local routing");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /not available to the harness yet/);
      adapter.list = async () => MODELS;
      // The listing is unchanged, so nothing is published; the catalogue is asked again.
      await test.probeLocalRuntimes();
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === LOCAL, "the local default once the catalogue lists the published rows");
    } finally { await test.close(); }
  });

  it("treats a catalogue still listing a deleted model as not yet carrying the listing", async () => {
    // The harness lists three local rows; Ollama now holds one. A read that beat the reload is
    // a successful read of the old rows, and a default from it could name a model that is gone.
    const adapter = new CaptureAdapter();
    const test = await fixture({ adapter, localModels: [PULLED[0]!] });
    try {
      assert.equal(await test.chat(), undefined, "extra rows are as stale as missing ones");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /not available to the harness yet/);
      adapter.list = async () => [...CLOUD_ONLY, MODELS.find((model) => model.id === "gemma4:12b")!];
      await test.probeLocalRuntimes();
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === LOCAL, "the local default once the catalogue lists exactly what was handed");
    } finally { await test.close(); }
  });

  it("treats a catalogue row that still states the old capabilities as not yet carrying a re-pulled model", async () => {
    // Same id, re-pulled without tool calling: the row that beat the reload still says tools.
    const adapter = new CaptureAdapter();
    const stated = (tools: boolean) => [...CLOUD_ONLY, { ...MODELS.find((model) => model.id === "gemma4:12b")!, tools }];
    adapter.list = async () => stated(true);
    const test = await fixture({ adapter, localModels: [{ id: "gemma4:12b", contextLength: 262144, tools: false, vision: false }] });
    try {
      assert.equal(await test.chat(), undefined, "a row stating what was not written is not carried");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /not available to the harness yet/);
      adapter.list = async () => stated(false);
      await test.probeLocalRuntimes();
      // Carried now — and passed over, since it cannot call tools: refused for that reason instead.
      await untilAsync(async () => { await test.chat(); return /None of the local models/.test(test.coordinator.getState().worldChat?.lastFailure?.detail ?? ""); }, "the row read back as written, then judged on it");
    } finally { await test.close(); }
  });

  it("does not count a sign-in row kept after a faulted read as a credential", async () => {
    const adapter = new CaptureAdapter();
    adapter.capabilities = () => new Set(["models", "events", "auth"] as const) as unknown as ReturnType<CaptureAdapter["capabilities"]>;
    let faulted = false;
    Object.assign(adapter, { listIntegrations: async () => {
      if (faulted) throw new Error("the auth catalog is not answering");
      return [{ id: "openai", name: "OpenAI", methods: [], connections: [{ kind: "stored", id: "c1", label: "OpenAI account" }], needsSignIn: false }];
    } });
    const test = await fixture({ adapter });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, undefined, "the connected account stands the local default down");
      faulted = true;
      await test.send({ kind: "refresh-vendor-auth" });
      await until(() => test.coordinator.getState().app.vendorAuth.reason !== null, "the faulted read");
      assert.ok(test.coordinator.getState().app.vendorAuth.vendors.some((vendor) => vendor.connections.length > 0), "the row from last time is still on display");
      const before = test.adapter.sessions.length;
      await test.chat();
      assert.equal(test.adapter.sessions.length, before, "but it is not a credential: refused, not run unmodelled");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /sign-in state could not be read/);
    } finally { await test.close(); }
  });

  it("re-opens the gates when an adapter with no supervisor comes back after losing readiness", async () => {
    const adapter = new CaptureAdapter();
    adapter.capabilities = () => new Set(["models", "events", "auth"] as const) as unknown as ReturnType<CaptureAdapter["capabilities"]>;
    let hold: Promise<void> = Promise.resolve();
    let release: () => void = () => {};
    Object.assign(adapter, { listIntegrations: async () => {
      await hold;
      return [{ id: "openai", name: "OpenAI", methods: [], connections: [{ kind: "stored", id: "c1", label: "OpenAI account" }], needsSignIn: false }];
    } });
    const test = await fixture({ adapter });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, undefined, "read once: the connected account decides");
      adapter.ready = false;
      await until(() => test.coordinator.getState().app.health.harness.status === "unavailable", "readiness lost");
      hold = new Promise<void>((resolve) => { release = resolve; });
      adapter.ready = true;
      await until(() => test.coordinator.getState().app.health.harness.status === "healthy", "readiness back");
      let decided = false;
      const pending = test.chat().finally(() => { decided = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(decided, false, "a keyless session waits for the returned adapter's own sign-in read");
      release();
      assert.equal((await pending)?.config.agents?.["world-builder"]?.model, undefined, "decided on that read");
    } finally { await test.close(); }
  });

  it("checks a returned harness's first catalogue against the rows it was handed before opening local routing", async () => {
    const adapter = new CaptureAdapter();
    const supervisor = Object.assign(new EventEmitter(), {
      id: "harness", status: "stopped", start: async () => {}, stop: async () => {}, restart: async () => {},
    }) as unknown as ChildSupervisor;
    const test = await fixture({ adapter, supervisor, localModels: PULLED });
    try {
      supervisor.emit("status", { id: "harness", status: "healthy" });
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === LOCAL, "the local default once the first lifecycle carried the rows", 12_000);
      // The child restarts, and the replacement's first answer is its cloud-only start-up catalogue.
      adapter.list = async () => CLOUD_ONLY;
      supervisor.emit("status", { id: "harness", status: "unhealthy", reason: "the child exited" });
      supervisor.emit("status", { id: "harness", status: "healthy" });
      await until(() => adapter.initCalls === 2, "the returning harness initialised");
      const before = test.adapter.sessions.length;
      await test.chat();
      assert.equal(test.adapter.sessions.length, before, "not run unmodelled on the returned harness's cloud-only read");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /not available to the harness yet/);
      adapter.list = async () => MODELS;
      await test.probeLocalRuntimes();
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === LOCAL, "the local default once the returned harness lists the rows");
    } finally { await test.close(); }
  });

  it("does not count a connection the harness says needs signing in again", async () => {
    const test = await fixture();
    try {
      (test.coordinator as unknown as { emit(event: DomainEvent): void }).emit({
        at: new Date().toISOString(), type: "vendor-auth.status",
        auth: VendorAuthStatusSchema.parse({ available: true, vendors: [
          { id: "openai", name: "OpenAI", methods: [], connections: [{ kind: "stored", id: "c1", label: "OpenAI account" }], needsSignIn: true },
        ] }),
      });
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL, "a connection that failed its last turn is not a credential");
    } finally { await test.close(); }
  });

  it("reads a stated fault on a surface that was read as read, not as unread", async () => {
    const adapter = new CaptureAdapter();
    adapter.capabilities = () => new Set(["models", "events", "auth"] as const) as unknown as ReturnType<CaptureAdapter["capabilities"]>;
    Object.assign(adapter, { listIntegrations: async () => [
      { id: "openai", name: "OpenAI", methods: [], connections: [{ kind: "stored", id: "c1", label: "OpenAI account" }], needsSignIn: false },
    ] });
    const test = await fixture({ adapter });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, undefined, "read once: the connected account decides");
      // A removal that failed after that read: the surface states the fault, rows intact.
      (test.coordinator as unknown as { emit(event: DomainEvent): void }).emit({
        at: new Date().toISOString(), type: "vendor-auth.status",
        auth: VendorAuthStatusSchema.parse({ available: true, reason: "the connection could not be removed", vendors: [
          { id: "openai", name: "OpenAI", methods: [], connections: [{ kind: "stored", id: "c1", label: "OpenAI account" }], needsSignIn: false },
        ] }),
      });
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, undefined, "still a credential: the read behind the rows succeeded");
    } finally { await test.close(); }
  });

  it("ends a chat with a chosen model at its Stop while the catalogue it is verified against is still being read", async () => {
    const adapter = new CaptureAdapter();
    let release: () => void = () => {};
    const test = await fixture({ adapter });
    try {
      await test.send({ kind: "world-chat-create", worldId: WORLD_ID, requestId: randomUUID(), title: "Stopped while verifying",
        entryContext: { kind: "production", productionId: "saltlight" } });
      const conversationId = test.coordinator.getState().worldChat!.conversationId;
      adapter.list = () => new Promise((resolve) => { release = () => resolve(MODELS); });
      test.staleCatalogue();
      const pending = test.send({ kind: "world-chat-send", worldId: WORLD_ID, requestId: randomUUID(), conversationId,
        text: "Explain the current production.", attachmentIds: [], modelId: CHAT });
      await until(() => test.coordinator.getState().worldChat?.runStatus !== null, "the turn admitted and verifying its model");
      await test.send({ kind: "world-chat-cancel", worldId: WORLD_ID, conversationId });
      await until(() => test.coordinator.getState().worldChat?.runStatus === null, "the turn ended at the Stop", 2_000);
      release();
      await pending;
      assert.equal(test.adapter.sessions.filter((session) => session.agent === "world-builder").length, 0, "no session was built for a stopped turn");
    } finally { release(); await test.close(); }
  });

  it("does not choose unattended a local model whose capabilities were assumed rather than read", async () => {
    // A show that listed no capabilities still states the window, so the model is offered, but
    // the default takes the first row the runtime actually described.
    const test = await fixture({ localModels: [{ id: "gemma4:12b", contextLength: 262144, tools: true, vision: false, assumed: true }, ...PULLED.slice(1)] });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL_SMALL, "the first described row, not the first row");
      assert.equal((await test.chat(LOCAL))?.config.model, LOCAL, "chosen on purpose, the assumed row is still admitted");
    } finally { await test.close(); }
  });

  it("does not offer a local model that states no window", async () => {
    // A show that failed outright reads nothing, not even the window, and the minimum holds it back.
    const adapter = new CaptureAdapter();
    adapter.list = async () => MODELS.filter((model) => model.id !== "gemma4:12b");
    const test = await fixture({ adapter, localModels: [{ id: "gemma4:12b", tools: true, vision: false, assumed: true }, ...PULLED.slice(1)] });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL_SMALL);
    } finally { await test.close(); }
  });

  it("does not offer a local model stating less than a 256k context, and says so when that leaves none", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => MODELS.filter((model) => model.id !== "gemma4:12b");
    const test = await fixture({ adapter, localModels: [{ id: "gemma4:12b", contextLength: 131072, tools: true, vision: false }, ...PULLED.slice(1)] });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL_SMALL, "the 128k model is passed over for one that states 256k");
    } finally { await test.close(); }
    const cloudOnly = new CaptureAdapter();
    cloudOnly.list = async () => CLOUD_ONLY;
    const none = await fixture({ adapter: cloudOnly, localModels: PULLED.map((model) => ({ ...model, contextLength: 131072 })) });
    try {
      await untilAsync(async () => {
        assert.equal(await none.chat(), undefined, "no session goes to a cloud default nobody can pay for");
        return /None of the pulled local models has a 256k context window/.test(none.coordinator.getState().worldChat?.lastFailure?.detail ?? "");
      }, "refused, naming the minimum");
      const staged = await none.stage();
      assert.match(staged?.type === "stage.construction" ? staged.detail : "", /256k context window/, "Stage is told the same, not sent to choose a model that reads images");
    } finally { await none.close(); }
  });

  it("does not hold a session with a chosen model behind discovery", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => CLOUD_ONLY;
    // The gate waits on the publication and its reload; a session whose agent has a model of
    // its own runs on it whatever discovery says, so it does not wait.
    const test = await fixture({ adapter, localModels: PULLED, agents: { "world-builder": { model: CHAT } } });
    try {
      // The send also awaits the conversation's naming pass, which is not a chosen session and
      // does wait; the turn's own session is what must not.
      const pending = test.chat();
      await until(() => test.adapter.sessions.some((session) => session.agent === "world-builder"), "the turn's session, before the reload delay", 3_000);
      assert.equal((await pending)?.config.agents?.["world-builder"]?.model, CHAT);
    } finally { await test.close(); }
  });

  it("does not trust a previous lifecycle's sign-in read on a returned harness", async () => {
    const adapter = new CaptureAdapter();
    adapter.capabilities = () => new Set(["models", "events", "auth"] as const) as unknown as ReturnType<CaptureAdapter["capabilities"]>;
    let hold: Promise<void> = Promise.resolve();
    let release: () => void = () => {};
    Object.assign(adapter, { listIntegrations: async () => {
      await hold;
      return [{ id: "openai", name: "OpenAI", methods: [], connections: [{ kind: "stored", id: "c1", label: "OpenAI account" }], needsSignIn: false }];
    } });
    const supervisor = Object.assign(new EventEmitter(), {
      id: "harness", status: "stopped", start: async () => {}, stop: async () => {}, restart: async () => {},
    }) as unknown as ChildSupervisor;
    const test = await fixture({ adapter, supervisor });
    try {
      supervisor.emit("status", { id: "harness", status: "healthy" });
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === undefined && test.adapter.sessions.length > 0, "the first lifecycle's read decides for the connected account");
      hold = new Promise<void>((resolve) => { release = resolve; });
      supervisor.emit("status", { id: "harness", status: "unhealthy", reason: "the child exited" });
      supervisor.emit("status", { id: "harness", status: "healthy" });
      await until(() => adapter.initCalls === 2, "the returning harness initialised");
      let decided = false;
      const pending = test.chat().finally(() => { decided = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(decided, false, "the old lifecycle's rows are not a credential while this one's read is out");
      release();
      assert.equal((await pending)?.config.agents?.["world-builder"]?.model, undefined, "decided on the returned harness's own read");
    } finally { release(); await test.close(); }
  });

  it("settles a re-armed gate when the first publication failed before the harness came up", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => CLOUD_ONLY;
    let publishFails = true;
    const supervisor = Object.assign(new EventEmitter(), {
      id: "harness", status: "stopped", start: async () => {}, stop: async () => {}, restart: async () => {},
    }) as unknown as ChildSupervisor;
    const test = await fixture({ adapter, supervisor, localModels: PULLED, onPublish: async () => {
      if (publishFails) throw new Error("the profile could not be written");
      adapter.list = async () => MODELS;
    } });
    try {
      await until(() => (test.coordinator as unknown as { catalogueGateOpen: boolean }).catalogueGateOpen === false, "the failed publication settled the gate");
      supervisor.emit("status", { id: "harness", status: "healthy" });
      await until(() => adapter.initCalls === 1, "the harness came up");
      const started = Date.now();
      const before = test.adapter.sessions.length;
      await test.chat();
      assert.ok(Date.now() - started < 10_000, "refused promptly rather than held to the creation timeout");
      assert.equal(test.adapter.sessions.length, before, "and not run unmodelled: the rows are unpublished");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /not available to the harness yet/);
      publishFails = false;
      await test.probeLocalRuntimes();
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === LOCAL, "the local default once the publication succeeds");
    } finally { await test.close(); }
  });

  it("gives a prompt-only agent a local model that calls no tools, where a tool-using agent is refused", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => [{ provider: "ollama", id: "chatty:7b", tools: false }, ...CLOUD_ONLY];
    const test = await fixture({ adapter });
    try {
      const sessionInput = (test.coordinator as unknown as { sessionInput(input: { agent?: string }): Promise<{ agents?: Record<string, { model?: string }> }> }).sessionInput;
      const summary = await sessionInput({ agent: "conversation-summarizer" });
      assert.equal(summary.agents?.["conversation-summarizer"]?.model, "ollama/chatty:7b", "the summarizer calls no tools, so a tool-less local model fits it");
      assert.equal(summary.agents?.["world-builder"]?.model, undefined, "and is not handed to an agent that needs tools");
      await assert.rejects(Promise.resolve(sessionInput({ agent: "world-builder" })), /None of the local models/);
    } finally { await test.close(); }
  });

  it("re-arms the gates on every new process of an adapter with no supervisor, and a waiting session follows them", async () => {
    const adapter = new CaptureAdapter();
    adapter.capabilities = () => new Set(["models", "events", "auth"] as const) as unknown as ReturnType<CaptureAdapter["capabilities"]>;
    const releases: Array<() => void> = [];
    let holding = false;
    const connected = [{ id: "openai", name: "OpenAI", methods: [], connections: [{ kind: "stored", id: "c1", label: "OpenAI account" }], needsSignIn: false }];
    Object.assign(adapter, { listIntegrations: async () => {
      if (holding) await new Promise<void>((resolve) => releases.push(resolve));
      return connected;
    } });
    const test = await fixture({ adapter });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, undefined, "read once: the connected account decides");
      holding = true;
      adapter.revision++;
      await until(() => releases.length === 1, "the first new process's read is out");
      let decided = false;
      const pending = test.chat().finally(() => { decided = true; });
      // Healthy to healthy again, while that read is still out. The service serialises its
      // reads, so the newest process's read starts once the superseded one has answered.
      adapter.revision++;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      releases[0]!();
      await until(() => releases.length === 2, "the second new process's read is out");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(decided, false, "the superseded process's answer neither settles the gate nor releases the waiting session");
      releases[1]!();
      assert.equal((await pending)?.config.agents?.["world-builder"]?.model, undefined, "decided on the newest process's read");
    } finally { holding = false; for (const release of releases) release(); await test.close(); }
  });

  it("keeps a catalogue read a stopped chat stopped waiting for in the lifecycle, so shutdown waits it out", async () => {
    const adapter = new CaptureAdapter();
    let release: () => void = () => {};
    const test = await fixture({ adapter });
    let closed = false;
    try {
      await test.send({ kind: "world-chat-create", worldId: WORLD_ID, requestId: randomUUID(), title: "Stopped while verifying",
        entryContext: { kind: "production", productionId: "saltlight" } });
      const conversationId = test.coordinator.getState().worldChat!.conversationId;
      adapter.list = () => new Promise((resolve) => { release = () => resolve(MODELS); });
      test.staleCatalogue();
      const pending = test.send({ kind: "world-chat-send", worldId: WORLD_ID, requestId: randomUUID(), conversationId,
        text: "Explain the current production.", attachmentIds: [], modelId: CHAT });
      await until(() => test.coordinator.getState().worldChat?.runStatus !== null, "the turn admitted and verifying its model");
      await test.send({ kind: "world-chat-cancel", worldId: WORLD_ID, conversationId });
      await until(() => test.coordinator.getState().worldChat?.runStatus === null, "the turn ended at the Stop", 2_000);
      await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 500))]);
      const closing = test.close().then(() => { closed = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(closed, false, "shutdown waits for the read the stopped chat left behind");
      release();
      await closing;
      assert.equal(closed, true);
    } finally { release(); if (!closed) await test.close(); }
  });

  it("skips a local model the runtime says cannot call tools", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => [{ provider: "ollama", id: "chatty:7b", tools: false }, ...MODELS];
    const test = await fixture({ adapter });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL, "the first row that can call tools, not the first row");
      assert.equal((await test.chat("ollama/chatty:7b"))?.config.model, "ollama/chatty:7b", "chosen on purpose, it is still admitted");
    } finally { await test.close(); }
  });

  it("lets shutdown through while a keyless session is waiting on the reload after a publication", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => CLOUD_ONLY;
    const test = await fixture({ adapter, localModels: [{ id: "gemma4:12b", contextLength: 262144, tools: true, vision: false }] });
    const pending = test.chat().catch(() => undefined);
    const stopped = Promise.race([test.close().then(() => "stopped"), new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 4_000).unref?.())]);
    assert.equal(await stopped, "stopped", "the cleared reload timer settled the gate rather than leaving the command waiting on it");
    await pending;
  });

  it("asks for the catalogue again when the read after a publication failed, on the probe's cadence", async () => {
    const test = await fixture({ localModels: PULLED });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL);
      test.adapter.list = async () => { throw new Error("discovery is down"); };
      await test.send({ kind: "list-harness-models" });
      await until(() => test.coordinator.getState().app.harnessModelStatus.status === "error", "the failed read");
      const before = test.adapter.sessions.length;
      await test.chat();
      assert.equal(test.adapter.sessions.length, before, "refused while the catalogue is unread: no session was built");
      test.adapter.list = async () => MODELS;
      // The listing is unchanged, so nothing is published; the failed read is what is retried.
      await test.probeLocalRuntimes();
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === LOCAL, "the local default once the catalogue reads again");
    } finally { await test.close(); }
  });

  it("refuses while the harness's sign-in state could not be read, rather than pinning a connected account local", async () => {
    const adapter = new CaptureAdapter();
    adapter.capabilities = () => new Set(["models", "events", "auth"] as const) as unknown as ReturnType<CaptureAdapter["capabilities"]>;
    let signInReadable = false;
    Object.assign(adapter, { listIntegrations: async () => {
      if (!signInReadable) throw new Error("the auth catalog is not answering");
      return [];
    } });
    const test = await fixture({ adapter });
    try {
      assert.equal(await test.chat(), undefined, "unread is not absent");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /sign-in state could not be read/);
      signInReadable = true;
      await test.probeLocalRuntimes();
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === LOCAL, "the local default once the sign-in state has been read");
    } finally { await test.close(); }
  });

  it("chooses nothing when the catalogue lists nothing local", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => CLOUD_ONLY;
    const test = await fixture({ adapter });
    try {
      assert.deepEqual((await test.chat())?.config.agents ?? {}, {}, "no agent is given a model it did not ask for");
    } finally { await test.close(); }
  });
});
