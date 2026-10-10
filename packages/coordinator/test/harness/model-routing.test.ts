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
import type { ChildSupervisor } from "../../src/supervisor.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { setProductionModel } from "../../src/productions/ops.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { until, untilAsync } from "../wait.js";

const MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "sonnet", aliases: ["claude-sonnet-5"], displayName: "Sonnet", inputTokenLimit: 200_000 },
  { provider: "anthropic", id: "opus[1m]", displayName: "Opus", inputModalities: ["text", "image"] },
  { provider: "openai", id: "spark", displayName: "Spark", inputModalities: ["text"] },
  { provider: "custom-provider", id: "region/model:fast", displayName: "Custom model" },
  { provider: "ollama", tools: true, id: "gemma4:12b", displayName: "Gemma 4 12B", inputTokenLimit: 131_072 },
  { provider: "ollama", tools: true, id: "gemma4:e2b-it-qat", displayName: "Gemma 4 E2B" },
  { provider: "ollama", tools: true, id: "qwen3-vl:8b", displayName: "Qwen3 VL", inputModalities: ["text", "image"] },
];
const LOCAL_VISION = "ollama/qwen3-vl:8b";
/**
 * The budget for a wait that polls by holding a whole chat — a conversation created and a turn
 * sent on every attempt (issue 1290). Idle, the condition holds within a few attempts; on a
 * loaded four-shard Windows runner one attempt can take seconds, and a 10-12 s budget failed
 * unrelated PRs. The cap only decides how long a genuinely broken case takes to report.
 */
const CHAT_POLL_MS = 30_000;
/**
 * How long a Stop may take to end a turn (issue 1290). What it must be told apart from is the
 * session's creation timeout, 30 s (`createPreparedSession`), which ends a stuck turn on its
 * own; 10 s is well inside that, where 2 s only measured how busy the runner was.
 */
const STOP_MS = 10_000;
/** The catalogue with nothing local in it: what a machine without Ollama sees. */
const CLOUD_ONLY = MODELS.filter((model) => model.provider !== "ollama");
const LOCAL = "ollama/gemma4:12b";
const LOCAL_SMALL = "ollama/gemma4:e2b-it-qat";

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
  ollamaHealth?: () => Promise<boolean>;
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
    ...(options.manifest ? { manifest: SHIPPED_MANIFEST } : {}),
    validators: { ollama: { validateKey: async () => [{ capability: "llm" as const, available: await (options.ollamaHealth?.() ?? true) }] } },
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
  const chat = async (modelId?: string, variant?: string) => {
    await send({ kind: "world-chat-create", worldId: WORLD_ID, requestId: randomUUID(), title: "Model routing",
      entryContext: { kind: "production", productionId: "saltlight" } });
    const conversationId = coordinator.getState().worldChat!.conversationId;
    await send({ kind: "world-chat-send", worldId: WORLD_ID, requestId: randomUUID(), conversationId,
      text: "Explain the current production.", attachmentIds: [], ...(modelId ? { modelId } : {}), ...(variant ? { variant } : {}) });
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
  it("rechecks explicit founding models before opening a tool-using session", async () => {
    const test = await fixture();
    const genesisId = "gen-model-admission";
    const submit = async (modelId: string, requestId: string) => {
      await test.send({ kind: "genesis-chat", genesisId, text: "A harbour town.", modelId, requestId });
      return test.events.findLast(event => event.type === "genesis.chat-result" && event.requestId === requestId);
    };
    try {
      // The visible catalogue was valid; a direct submission must read the changed backend.
      test.adapter.list = async () => MODELS.map(model => ({ ...model, ...(model.id === "spark" ? { tools: false } : {}) }));
      const noTools = await submit(TEXT, "no-tools");
      assert.ok(noTools?.type === "genesis.chat-result" && !noTools.accepted);
      assert.match(noTools.detail ?? "", /cannot use tools/);
      const absent = await submit("openai/gone", "absent");
      assert.ok(absent?.type === "genesis.chat-result" && !absent.accepted);
      assert.equal(test.adapter.sessions.length, 0, "no invalid session is opened");
      test.adapter.list = async () => MODELS;
      const valid = await submit(TEXT, "valid");
      assert.ok(valid?.type === "genesis.chat-result" && valid.accepted);
      await until(() => test.adapter.sessions.some(session => session.agent === "world-author"), "valid founding session");
      assert.equal(test.adapter.sessions.find(session => session.agent === "world-author")?.config.model, TEXT);
    } finally { await test.close(); }
  });

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

  it("tells every session where the open world's agent notes and the author's page live, under the app's root", async () => {
    const test = await fixture();
    try {
      const config = (await test.chat())?.config;
      assert.ok(config?.memoryDir?.replaceAll("\\", "/").endsWith(`/agent-memory/${WORLD_ID}`), config?.memoryDir);
      assert.ok(config?.authorNotesFile?.replaceAll("\\", "/").endsWith("/agent-memory/author.md"), config?.authorNotesFile);
      assert.ok(!config!.memoryDir!.replaceAll("\\", "/").includes("/worlds/"), "never inside the world's own folder");
    } finally { await test.close(); }
  });

  it("never makes a model that waits to be chosen the default, and names it when it is the only one (issue 1289)", async () => {
    // Listed first, as Ollama lists the model pulled most recently: installing it made it every
    // agent's writer, with Content & safety off.
    const UNCENSORED = "hf.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced:Q4_K_M";
    const beside = new CaptureAdapter();
    beside.list = async () => [{ provider: "ollama", tools: true, id: UNCENSORED, displayName: UNCENSORED }, ...MODELS];
    const test = await fixture({ adapter: beside });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL, "installing it is not choosing it");
    } finally { await test.close(); }
    const alone = new CaptureAdapter();
    alone.list = async () => [...CLOUD_ONLY, { provider: "ollama", tools: true, id: UNCENSORED, displayName: UNCENSORED }];
    const only = await fixture({ adapter: alone });
    try {
      await untilAsync(async () => {
        assert.equal(await only.chat(), undefined, "no session goes to it unasked");
        return /Uncensored Balanced · HauhauCS runs only where you choose it\. Choose it for World Chat \(world-builder\)/.test(only.coordinator.getState().worldChat?.lastFailure?.detail ?? "");
        // Each poll creates and sends a conversation: under a full coordinator run that is
        // seconds apiece, and the default ten failed it twice where it passes alone.
      }, "the refusal naming the model and where to choose it", 30_000);
      const founding = only.coordinator as unknown as { keylessSessionRefusal(needsImages: boolean, agent: string): string | null };
      assert.match(founding.keylessSessionRefusal(false, "world-author") ?? "", /^Choose .* under Writing model above the conversation\.$/);
    } finally { await only.close(); }
  });

  it("takes the first local row the admission gate lets through, under the shipped manifest", async () => {
    const test = await fixture({ manifest: true });
    try {
      // Under the shipped manifest a local row is gated on the runtime's own status, so the
      // choice waits for Ollama to have answered the poll, as it would on a real machine.
      await until(() => test.coordinator.getState().app.providers.some((p) => p.id === "ollama" && p.validation === "valid"), "Ollama answering");
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, LOCAL);
      await test.send({ kind: "set-model-enabled", modelId: "gemma4-12b", enabled: false });
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === LOCAL_SMALL, "the next admissible local row once the first is switched off", CHAT_POLL_MS);
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




  it("waits for native discovery before preparing the first keyless session", async () => {
    const adapter = new CaptureAdapter();
    let release: (() => void) | undefined;
    const discovery = new Promise<void>(resolve => { release = resolve; });
    adapter.list = async () => { await discovery; return MODELS; };
    const test = await fixture({ adapter });
    const pending = test.chat();
    try {
      await until(() => test.coordinator.getState().app.harnessModelStatus.status === "loading", "native discovery is pending");
      assert.equal(adapter.sessions.length, 0, "the first session cannot bypass discovery");
      release!();
      assert.equal((await pending)?.config.agents?.["world-builder"]?.model, LOCAL);
    } finally { release!(); await pending; await test.close(); }
  });

  it("publishes native inventory changes to an open picker without a local publishing client", async () => {
    const test = await fixture();
    try {
      await test.send({ kind: "list-harness-models" });
      const pulled = { provider: "ollama", id: "newly-pulled:8b", tools: true };
      test.adapter.list = async () => [...CLOUD_ONLY, pulled];
      await test.probeLocalRuntimes();
      assert.deepEqual(test.coordinator.getState().app.harnessModels, [...CLOUD_ONLY, pulled]);
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, "ollama/newly-pulled:8b");
      test.adapter.list = async () => CLOUD_ONLY;
      await test.probeLocalRuntimes();
      assert.deepEqual(test.coordinator.getState().app.harnessModels, CLOUD_ONLY);
    } finally { await test.close(); }
  });

  it("refuses a retained native Ollama inventory after sustained runtime failure and recovers on health", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => [{ provider: "ollama", id: "unmanifested:8b", tools: true }, ...CLOUD_ONLY];
    let running = true;
    const test = await fixture({ adapter, ollamaHealth: async () => {
      if (!running) throw new Error("Ollama stopped");
      return true;
    } });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, "ollama/unmanifested:8b");
      running = false;
      await test.probeLocalRuntimes();
      assert.equal(test.coordinator.getState().app.providers.find(provider => provider.id === "ollama")?.validation, "valid", "one transient miss retains health");
      await test.probeLocalRuntimes();
      assert.ok(test.coordinator.getState().app.harnessModels.some(model => model.id === "unmanifested:8b"), "OpenCode still returns its retained inventory");
      adapter.sessions.length = 0;
      assert.equal(await test.chat(), undefined, "a retained row cannot open a keyless session on a stopped runtime");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /Ollama is not available/, "the refusal names runtime health");
      assert.equal(await test.chat("ollama/unmanifested:8b"), undefined, "an explicit native choice also checks runtime health");
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /Ollama is unavailable/);
      running = true;
      await test.probeLocalRuntimes();
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, "ollama/unmanifested:8b");
    } finally { await test.close(); }
  });

  it("revalidates a saved unmanifested Ollama choice after its runtime stops", async () => {
    let running = true;
    const adapter = new CaptureAdapter();
    adapter.list = async () => [{ provider: "ollama", id: "saved:8b", tools: true }, ...CLOUD_ONLY];
    const test = await fixture({ adapter, agents: { "world-builder": { model: "ollama/saved:8b" } }, ollamaHealth: async () => running });
    try {
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, "ollama/saved:8b");
      running = false;
      await test.probeLocalRuntimes();
      adapter.sessions.length = 0;
      assert.equal(await test.chat(), undefined);
      assert.match(test.coordinator.getState().worldChat?.lastFailure?.detail ?? "", /Ollama is unavailable/);
      assert.equal((await test.settings()).agents?.["world-builder"]?.model, "ollama/saved:8b", "an outage keeps the saved choice");
      running = true;
      await test.probeLocalRuntimes();
      assert.equal((await test.chat())?.config.agents?.["world-builder"]?.model, "ollama/saved:8b");
    } finally { await test.close(); }
  });

  it("keeps unknown local tool support selectable but never chooses it unattended", async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => [{ provider: "ollama", id: "unknown:8b" }, ...MODELS];
    const test = await fixture({ adapter });
    try {
      assert.equal((await test.chat())?.config.model, LOCAL);
      assert.equal((await test.chat("ollama/unknown:8b"))?.config.model, "ollama/unknown:8b");
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
      await until(() => test.coordinator.getState().worldChat?.runStatus === null, "the turn ended at the Stop", STOP_MS);
      release();
      await pending;
      assert.equal(test.adapter.sessions.filter((session) => session.agent === "world-builder").length, 0, "no session was built for a stopped turn");
    } finally { release(); await test.close(); }
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
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === undefined && test.adapter.sessions.length > 0, "the first lifecycle's read decides for the connected account", CHAT_POLL_MS);
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
      await until(() => test.coordinator.getState().worldChat?.runStatus === null, "the turn ended at the Stop", STOP_MS);
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
      await untilAsync(async () => (await test.chat())?.config.agents?.["world-builder"]?.model === LOCAL, "the local default once the sign-in state has been read", CHAT_POLL_MS);
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

describe("effort travels with the model (design turn 195)", () => {
  const EFFORT_MODELS: ModelInfo[] = [
    ...MODELS,
    { provider: "openai", id: "gpt-5.4", displayName: "GPT-5.4", variants: { names: ["low", "medium", "high"] } },
    { provider: "openai", id: "gpt-5.4-mini", displayName: "GPT-5.4 mini", variants: { names: ["low", "high"] } },
  ];
  const EFFORT = "openai/gpt-5.4";
  const OTHER = "openai/gpt-5.4-mini";
  const kept = (test: Awaited<ReturnType<typeof fixture>>) =>
    test.provider.openStore()!.getBundle().productions.find(production => production.meta.id === "saltlight")!.meta.llmVariants;
  const production = (test: Awaited<ReturnType<typeof fixture>>) =>
    test.provider.openStore()!.getBundle().productions.find(candidate => candidate.meta.id === "saltlight")!.meta;
  const keep = (test: Awaited<ReturnType<typeof fixture>>, modelId: string | null, variant?: string) =>
    test.send({ kind: "set-production-model", worldId: WORLD_ID, productionId: "saltlight", capability: "llm", modelId, ...(variant ? { variant } : {}) });
  const withEffortModels = async () => {
    const adapter = new CaptureAdapter();
    adapter.list = async () => EFFORT_MODELS;
    return fixture({ adapter });
  };

  it("sends a chosen effort with the chosen model into the session", async () => {
    const test = await withEffortModels();
    try {
      const session = await test.chat(EFFORT, "high");
      assert.equal(session?.config.model, EFFORT);
      assert.equal(session?.config.modelVariant, "high");
    } finally { await test.close(); }
  });

  it("drops an effort the model does not declare rather than sending it", async () => {
    const test = await withEffortModels();
    try {
      assert.equal((await test.chat(EFFORT, "xhigh"))?.config.modelVariant, undefined, "a model that lists no such name");
      assert.equal((await test.chat(CHAT, "high"))?.config.modelVariant, undefined, "a model that declares no variants");
    } finally { await test.close(); }
  });

  it("keeps the effort with the model for every chat in the production, per model", async () => {
    const test = await withEffortModels();
    try {
      await keep(test, EFFORT, "low");
      assert.deepEqual(kept(test), { [EFFORT]: "low" });
      assert.equal(production(test).models?.llm, EFFORT);
      // A chat that names nothing runs at what the production kept for the model it resolves to.
      assert.equal((await test.chat())?.config.modelVariant, "low");
      // This chat's own choice outranks it for the turn.
      assert.equal((await test.chat(undefined, "high"))?.config.modelVariant, "high");
      // Another model has its own effort, and none until one is kept for it.
      assert.equal((await test.chat(OTHER))?.config.modelVariant, undefined);
      await keep(test, OTHER, "high");
      assert.deepEqual(kept(test), { [EFFORT]: "low", [OTHER]: "high" }, "a kept effort replaces only its own model's");
      // Switching back finds the first model's effort where it was left.
      await keep(test, EFFORT);
      assert.deepEqual(kept(test), { [EFFORT]: "low", [OTHER]: "high" }, "choosing a model without an effort leaves the kept ones alone");
      assert.equal((await test.chat())?.config.modelVariant, "low");
    } finally { await test.close(); }
  });

  it("lets go of every kept effort when the production's choice is cleared", async () => {
    const test = await withEffortModels();
    try {
      await keep(test, EFFORT, "low");
      await keep(test, null);
      assert.equal(kept(test), undefined);
      assert.equal((await test.chat(EFFORT))?.config.modelVariant, undefined);
    } finally { await test.close(); }
  });

  it("never keeps an effort the model does not declare", async () => {
    const test = await withEffortModels();
    try {
      await keep(test, CHAT, "high");
      assert.equal(kept(test), undefined);
      await keep(test, EFFORT, "ultra");
      assert.equal(kept(test), undefined);
    } finally { await test.close(); }
  });
});
