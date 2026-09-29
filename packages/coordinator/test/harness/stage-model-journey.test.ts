import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import {
  agentForPurpose, DEFAULT_SHOT_SEC, orderedShots, stageShot,
  type ClientMessage, type CreateSessionInput, type DomainEvent, type HarnessAdapter,
  type HarnessEvent, type ModelInfo, type SendMessageInput, type SessionConfigInput,
  type StageConstructionDraft,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { decodePng, encodePng, solidImage } from "../../src/references/png.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { until } from "../wait.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const PRODUCTION = "saltlight";
const SCENE = "sc_04";
const SCENE_FILE = "04-the-verse-rises";
const SHOT = "sh_12";
const CHAT = "anthropic/sonnet";
const PRODUCTION_MODEL = "openai/spark";
const STAGE = "anthropic/opus[1m]";
const MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "sonnet", inputModalities: ["text", "image"] },
  { provider: "openai", id: "spark", inputModalities: ["text"] },
  { provider: "anthropic", id: "opus[1m]", aliases: ["stage-alias"], inputModalities: ["text", "image"] },
];
type ConstructionEvent = Extract<DomainEvent, { type: "stage.construction" }>;

/**
 * No model service or renderer runs here: responses are scripted and inspection frames are
 * solid PNG fixtures. The real coordinator owns selection, Stage's read-receipt gate, provenance,
 * Keep and persistence. The adapter actually reads/decode-checks each local PNG before emitting
 * its receipt; this exercises image delivery without claiming visual or cinematic quality.
 */
class ScriptedStageAdapter implements HarnessAdapter {
  readonly id = "scripted-stage-journey";
  readonly preparations = new Map<string, SessionConfigInput>();
  readonly sessions: Array<{ id: string; agent?: string; cwd: string; config: SessionConfigInput; turns: number }> = [];
  readonly imageReads: Array<{ sessionId: string; name: string; bytes: Buffer }> = [];
  readonly interrupted: string[] = [];
  private readonly subscribers = new Set<(event: HarnessEvent) => void>();
  ready = true;
  constructor(private readonly draft: StageConstructionDraft) {}
  readiness() { return { ready: this.ready }; }
  capabilities() { return new Set(["models", "events"] as const); }
  async init() { this.ready = true; }
  async dispose() { this.ready = false; }
  async listModels() { return MODELS; }
  prepareSession(input: SessionConfigInput) { this.preparations.set(input.preparationId!, structuredClone(input)); }
  abandonSessionPreparation(id: string) { this.preparations.delete(id); }
  async createSession(input: CreateSessionInput) {
    const config = this.preparations.get(input.preparationId!);
    assert.ok(config, "Stage receives its own prepared session configuration");
    assert.ok(input.cwd);
    const sessionId = randomUUID();
    this.sessions.push({ id: sessionId, agent: input.agent, cwd: input.cwd, config, turns: 0 });
    return { sessionId };
  }
  async dispatchAsync(input: SendMessageInput) { return this.sendMessage(input); }
  async interrupt(sessionId: string) { this.interrupted.push(sessionId); }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    const queue: HarnessEvent[] = [];
    let wake: (() => void) | undefined;
    const receive = (event: HarnessEvent) => { queue.push(event); wake?.(); };
    const stop = () => wake?.();
    this.subscribers.add(receive);
    signal?.addEventListener("abort", stop, { once: true });
    try {
      while (!signal?.aborted) {
        const event = queue.shift();
        if (event) yield event;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally {
      this.subscribers.delete(receive);
      signal?.removeEventListener("abort", stop);
    }
  }
  async sendMessage(input: SendMessageInput) {
    const session = this.sessions.find(candidate => candidate.id === input.sessionId)!;
    session.turns++;
    const prompt = input.parts.map(part => part.text).join("\n");
    const names = [...new Set(prompt.match(/(?:round-\d-\d-(?:camera|overview)|source-\d+)\.(?:png|jpg|jpeg|webp)/g) ?? [])];
    for (const name of names) {
      const bytes = await readFile(join(session.cwd, name));
      if (name.endsWith(".png")) decodePng(bytes);
      this.imageReads.push({ sessionId: session.id, name, bytes });
      for (const receive of this.subscribers) receive({ type: "tool.activity", sessionId: session.id, tool: "read", summary: name });
    }
    if (session.turns === 2) {
      this.draft.staging.keys = this.draft.staging.keys.map(key => ({ ...key, p: [key.p[0], key.p[1] + 0.2, key.p[2]] }));
    }
    this.draft.inspected = names;
    this.draft.assessment = session.turns === 1 ? "Scripted initial composition." : "Scripted inspection and corrected camera height.";
    for (const receive of this.subscribers) receive({ type: "message.completed", sessionId: session.id, text: JSON.stringify(this.draft) });
    return { sessionId: session.id, correlationId: String(session.turns) };
  }
}

async function openJourney(root: string) {
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const current = () => {
    const production = provider.openStore()!.getBundle().productions.find(candidate => candidate.meta.id === PRODUCTION)!;
    const scene = production.scenes.find(candidate => candidate.id === SCENE)!;
    return { production, scene, shot: orderedShots(scene).find(candidate => candidate.id === SHOT)! };
  };
  const { shot } = current();
  const duration = shot.durationSec ?? DEFAULT_SHOT_SEC;
  const { version: _version, cast, sets, ...staging } = stageShot(shot, { cast: ["maren-kest"], sets: [], durationSec: duration });
  const adapter = new ScriptedStageAdapter({ staging, cast, sets, assumptions: ["Scripted camera at eye height."], assessment: "", inspected: [] });
  const events: ConstructionEvent[] = [];
  const coordinator = new Coordinator({
    provider, adapter, appRoot: root, appVersion: "test", authoring: { agentForPurpose },
    changeLogPath: join(root, "changes.jsonl"),
    observeEvent: event => { if (event.type === "stage.construction") events.push(structuredClone(event)); },
  });
  await coordinator.start(0);
  const send = (message: ClientMessage) => (coordinator as unknown as {
    handleClientMessage(message: ClientMessage): Promise<void>;
  }).handleClientMessage(message);
  const construct = async () => {
    const requestId = randomUUID();
    await send({ kind: "stage-construct", worldId: WORLD_ID, productionId: PRODUCTION, sceneId: SCENE,
      shotId: SHOT, baseVersion: current().scene.version, requestId, instruction: "Inspect this blockout and correct its camera height.", preserve: "none" });
    return requestId;
  };
  const waitFor = async (requestId: string, status: ConstructionEvent["status"], round?: number) => {
    await until(() => events.some(event => event.requestId === requestId && (event.status === "failed" ||
      (event.status === status && (round === undefined || event.round === round)))), `Stage ${status}, round ${round ?? "final"}`);
    const event = events.findLast(event => event.requestId === requestId)!;
    assert.equal(event.status, status, event.detail);
    return event;
  };
  const close = async () => { await coordinator.stop(); await provider.close(); };
  return { adapter, coordinator, current, duration, send, construct, waitFor, close };
}

it("keeps a live Stage override through inspection, Keep and reopen, independently of chat/production; cancellation preserves the kept shot (#1122)", async () => {
  const { root } = await makeTempRoot();
  let journey = await openJourney(root);
  try {
    await journey.send({ kind: "set-agent-config", agent: "world-builder", model: CHAT });
    await journey.send({ kind: "set-production-model", worldId: WORLD_ID, productionId: PRODUCTION, capability: "llm", modelId: PRODUCTION_MODEL });
    await journey.send({ kind: "set-agent-config", agent: "stage-designer", model: "anthropic/stage-alias" });
    const before = structuredClone(journey.current().scene);
    const requestId = await journey.construct();
    const pngBytes = Buffer.from(encodePng(solidImage(64, 36, [20, 30, 40, 255])));
    const png = pngBytes.toString("base64");
    let initialHeight = 0;
    for (const round of [1, 2]) {
      const inspection = await journey.waitFor(requestId, "inspect", round);
      assert.ok(inspection.draft);
      if (round === 1) initialHeight = inspection.draft.staging.keys[0]!.p[1];
      else assert.equal(inspection.draft.staging.keys[0]!.p[1], initialHeight + 0.2, "the second inspection receives the revised draft");
      assert.deepEqual(journey.current().scene, before, "construction and inspection do not write before Keep");
      await journey.send({ kind: "stage-inspection", worldId: WORLD_ID, requestId, round, frames: [
        { at: 0, view: "camera", png },
        { at: journey.duration - 0.01, view: "camera", png },
        { at: 0, view: "overview", png },
      ] });
    }
    const ready = await journey.waitFor(requestId, "ready");
    assert.ok(ready.draft);
    const session = journey.adapter.sessions[0]!;
    assert.equal(session.agent, "stage-designer");
    assert.equal(session.config.model, STAGE, "the valid Stage override wins over a text-only production default");
    assert.equal(session.config.agents?.["stage-designer"]?.model, STAGE);
    assert.equal(session.config.agents?.["world-builder"]?.model, CHAT);
    assert.equal(journey.current().production.meta.models?.llm, PRODUCTION_MODEL);
    assert.equal(session.turns, 3);
    for (const round of [1, 2]) {
      for (const [index, view] of ["camera", "camera", "overview"].entries()) {
        const read = journey.adapter.imageReads.find(read => read.name === `round-${round}-${index}-${view}.png`);
        assert.ok(read, "each required frame has an actual read before its tool receipt");
        assert.deepEqual(read.bytes, pngBytes);
      }
    }
    const authorship = ready.draft.staging.authorship;
    assert.equal(authorship?.model, STAGE, "provenance records the canonical executed identity, not the alias or production default");
    assert.equal(authorship?.inspectedFrames, 6);
    assert.equal(authorship?.sourceVersion, before.version);
    assert.match(authorship?.sourceFingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(journey.current().scene, before, "a ready draft still requires Keep");

    // The same ordinary edit-stage command sent by the Stage UI's Keep action.
    await journey.send({ kind: "scene-command", worldId: WORLD_ID, productionId: PRODUCTION, sceneId: SCENE,
      sceneFile: SCENE_FILE, baseVersion: before.version,
      command: { kind: "edit-stage", shotId: SHOT, staging: { ...ready.draft.staging, cast: ready.draft.cast, sets: ready.draft.sets } } });
    assert.equal(journey.current().scene.version, before.version + 1);
    const kept = structuredClone(journey.current().scene);
    assert.deepEqual(journey.current().shot.staging?.authorship, authorship);
    assert.equal(journey.current().shot.staging?.keys[0]!.p[1], initialHeight + 0.2);
    assert.deepEqual(journey.current().scene.blocking, before.blocking, "Keep only changes this shot's override");
    await journey.close();
    journey = await openJourney(root);
    assert.deepEqual(journey.current().scene, kept, "the accepted scene and canonical provenance survive closing and reopening the world");
    assert.equal(journey.current().production.meta.models?.llm, PRODUCTION_MODEL);

    const cancelledId = await journey.construct();
    assert.notEqual(cancelledId, requestId);
    const partial = await journey.waitFor(cancelledId, "inspect", 1);
    assert.ok(partial.draft);
    const cancelledSession = journey.adapter.sessions[0]!;
    assert.equal(cancelledSession.config.model, STAGE, "the selected Stage model survives app settings reload");
    assert.equal(cancelledSession.config.agents?.["world-builder"]?.model, CHAT);
    await journey.send({ kind: "stage-construct-cancel", worldId: WORLD_ID, requestId: cancelledId });
    const stopped = await journey.waitFor(cancelledId, "failed");
    assert.match(stopped.detail, /stopped/i);
    assert.ok(stopped.draft, "the cancelled run retains its partial draft for review");
    assert.ok(journey.adapter.interrupted.includes(cancelledSession.id));
    assert.equal(cancelledSession.turns, 1);
    assert.deepEqual(journey.current().scene, kept, "cancellation cannot replace the already accepted shot or its provenance");
  } finally { await journey.close(); }
});
