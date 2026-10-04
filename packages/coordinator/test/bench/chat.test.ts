import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { it, type TestContext } from "node:test";
import { JobSchema, ReferenceKitSchema, newId, ulid, type ConversationActionCard, type Job, type ManifestModel, type ModelWorldChatAction, type VoiceCandidate } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { WorldStore } from "../../src/world/store.js";
import { prepareWorldChatActions, worldChatActionAdapters, type WorldChatActionAdapterDeps } from "../../src/world-chat/actions.js";
import { ConversationActionLifecycle } from "../../src/arke-actions/lifecycle.js";
import { WorldChatStore, conversationDir } from "../../src/world-chat/store.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { WorldChatAttachmentStore } from "../../src/world-chat/attachments.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { productionReadFence } from "../../src/world-chat/production-reads.js";
import { jobsFence, artifactsFence, timelineFence } from "../../src/world-chat/target-reads.js";
import { assembleStory } from "../productions/assemble.js";
import { applyTimelineCommand } from "../../src/productions/timeline.js";
import { decideEditorRequest } from "../../src/productions/editor-requests.js";
import type { MediaProbe } from "../../src/media/probe.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { BenchStore, sessionDir } from "../../src/bench/store.js";
import { benchReadRows, generationRouteReadRows, readBenchSession } from "../../src/bench/chat-reads.js";
import { benchChatSessionId, completeBenchChatAction, materializeBenchChatSession, prepareBenchChatSession } from "../../src/bench/chat-session.js";
import { WorldChatTargetReads } from "../../src/world-chat/target-reads.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { QueryLeaseRegistry } from "../../src/world-chat/lease.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { pngBytes } from "../queue/fake-provider.js";
import { cloneVoice } from "../../src/voice/library.js";
import { wav } from "../audio/helpers.js";
import { analyzePcmWav, audioHash } from "../../src/audio/qc.js";
import { openSubjectBenchSession } from "../../src/bench/service.js";
import { fileBenchSubjectTake } from "../../src/bench/filing.js";
import { inspectBenchVoiceInputs } from "../../src/bench/chat-voice.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const AT = "2026-10-04T02:00:00.000Z";
const IMAGE: ManifestModel = { id: "chat-image", provider: "fal", capability: "image", displayName: "Chat image",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perImage", microUsdPerImage: 10_000 } };
const MUSIC: ManifestModel = { id: "minimax-music-3", provider: "fal", capability: "music", displayName: "Piano route",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perSecond", microUsdPerSecond: 100 } };
const VOICE: ManifestModel = { ...MUSIC, provider: "mistral", id: "voxtral-mini-tts", capability: "voice-tts", displayName: "Voice reader",
  pricing: { kind: "perCharacter", microUsdPerCharacter: 1 } };
const VIDEO: ManifestModel = { ...IMAGE, id: "seedance-2.0", capability: "video", displayName: "Reference video",
  accepts: { ...IMAGE.accepts, referenceAudio: 3 },
  limits: { referenceSyntax: "seedance", durations: { "4": "4" }, soundChoice: true, maxReferenceAudioSec: 15 }, pricing: { kind: "perSecond", microUsdPerSecond: 100 } };
const music = (): Extract<ModelWorldChatAction, { kind: "bench-generation" }> => ({ kind: "bench-generation", composer: {
  mode: "music", brief: "A slow solo piano cue for the title. Instrumental; no vocals.", provider: MUSIC.provider, model: MUSIC.id,
  params: { kind: "music", lyrics: "[instrumental]", count: 1 }, references: [],
}, checkReceiptIds: [newId("check")] });
async function setup(t: TestContext, mediaProbe?: MediaProbe) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => AT });
  t.after(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore()!;
  const manifest = { manifestVersion: 1 as const, generated: "2026-10-04", models: [IMAGE, MUSIC, VOICE, VIDEO] };
  const coordinator = new Coordinator({ provider, adapter: null, manifest, changeLogPath: join(root, "changes.jsonl"), appVersion: "test", ...(mediaProbe ? { mediaProbe } : {}) });
  coordinator.emit({ type: "provider.status", at: AT, providers: [
    { id: "fal", configured: true, validation: "valid", fault: null, probes: [{ capability: "image", available: true }, { capability: "video", available: true }, { capability: "music", available: true }] },
    { id: "mistral", configured: true, validation: "valid", fault: null, probes: [{ capability: "voice-tts", available: true }] },
  ] });
  const host = coordinator as unknown as { conversationActionDependencies(store: WorldStore): WorldChatActionAdapterDeps;
    enqueueWithSpeechChecks(input: EnqueueInput): Promise<Job>; jobQueue: { listJobs(): Job[] };
    voiceService: { catalogue(): Promise<VoiceCandidate[]> }; benchVoiceCatalogue(store: WorldStore): Promise<VoiceCandidate[]> };
  const admitted: EnqueueInput[] = [], jobs: Job[] = [];
  host.jobQueue = { listJobs: () => jobs };
  host.enqueueWithSpeechChecks = async input => { admitted.push(input); const { voiceReference, ...durable } = input; const job = JobSchema.parse({ ...durable,
    params: { ...input.params, ...(voiceReference ? { voiceReference: true } : {}) },
    id: newId("jb"), status: "queued", createdAt: AT, updatedAt: AT }); jobs.push(job); return job; };
  return { store, worldDir, manifest, coordinator, host, admitted, deps: () => host.conversationActionDependencies(store) };
}

it("sequences production music into a fenced human editor request, blocks denied dependencies, and recovers placement once", async t => {
  const { store, worldDir, admitted, deps } = await setup(t, { durationSec: async () => 1,
    info: async () => ({ durationSec: 1, hasAudio: true, hasVideo: false }) });
  let timeline = await assembleStory(store, "saltlight");
  await applyTimelineCommand(store, "saltlight", { kind: "commands", baseRevision: timeline.revision, sourceFingerprint: "", label: "Add music track",
    commands: [{ kind: "add-track", trackId: "tr_music", trackKind: "audio", name: "Music", defaultRole: "music" }] });
  const conversationId = newId("cv"), log = new WorldChatStore(conversationDir(worldDir, conversationId));
  await log.create(conversationId, AT); await log.append({ type: "conversation.created", title: "Production cue", entryContext: { kind: "production", productionId: "saltlight" } }, { at: AT });
  const dependencies = deps(), lifecycle = new ConversationActionLifecycle({ worldPath: worldDir, worldId: store.worldId,
    adapters: worldChatActionAdapters(store, null, () => AT, dependencies), now: () => AT });
  const view = async () => foldConversation(conversationId, AT, (await log.read()).events).view;
  const bind = async () => {
    const production = store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
    const reads = [{ requirement: "jobs" as const, id: store.worldId, fence: jobsFence([], store.worldId) },
      { requirement: "generation-routes" as const, id: store.worldId, fence: productionReadFence(dependencies.getGenerationRouteRows!()) },
      { requirement: "timeline" as const, id: "saltlight", fence: timelineFence(production, store.getBundle().artifacts) }];
    const receipts = reads.map(read => ({ id: newId("check"), runId: newId("run"), tool: "target-read" as const, status: "complete" as const,
      consulted: [], target: { requirement: read.requirement, id: read.id }, observedRevisionOrDigest: read.fence, complete: true, nextCursor: null, at: AT }));
    const actions: ModelWorldChatAction[] = [{ ...music(), ref: "cue", checkReceiptIds: receipts.slice(0, 2).map(r => r.id) },
      { kind: "production-audio-cue", productionId: "saltlight", source: { kind: "generation", actionRef: "cue", outputIndex: 0 }, after: ["cue"],
        trackId: "tr_music", startFrame: 0, durationFrames: 12, sourceInFrames: 0, gainDb: -6, role: "music", checkReceiptIds: [receipts[2]!.id] }];
    const turn = { conversationId, turnId: newId("turn"), entryContext: { kind: "production" as const, productionId: "saltlight" },
      candidates: [], groups: [], existingCandidates: [], existingGroups: [], bibleEdits: [], bibleBaseVersion: 1, sceneEdits: [], sceneBaseVersion: null, editorRequests: [], actions, receipts, at: AT };
    assert.throws(() => prepareWorldChatActions(store, lifecycle, { ...turn, actions: [actions[0]!, { ...actions[1]!, after: [] }] }, dependencies), /earlier generation action in after/);
    const prepared = prepareWorldChatActions(store, lifecycle, turn, dependencies);
    for (const item of prepared) { await log.append({ type: "action.prepare-intent", intent: item.intent }, { at: AT }); await lifecycle.bindIntent(item.intent, item.payload); }
    return (await view()).actions.slice(-2);
  };
  const decide = async (card: ConversationActionCard, decision: "approve" | "deny" = "approve") => lifecycle.decide({ kind: "conversation-action-decide",
    worldId: store.worldId, conversationId, actionId: card.actionId, expectedConversationSeq: (await view()).seq, expectedStatus: "pending", decision, requestId: ulid() });
  const denied = await bind();
  assert.equal(denied[1]!.availableDecisions.includes("approve"), false);
  await decide(denied[0]!, "deny");
  assert.equal((await view()).actions.find(c => c.actionId === denied[1]!.actionId)!.availableDecisions.includes("approve"), false);
  assert.equal(admitted.length, 0);
  const cards = await bind();
  const generationOutcome = await decide(cards[0]!);
  assert.equal(generationOutcome.status, "queued", JSON.stringify((await view()).actions.find(card => card.actionId === cards[0]!.actionId)));
  assert.equal((await readWorldMeta(worldDir)).schemaVersion, 57);
  await assert.rejects(readWorldMeta(worldDir, { supports: 56 }), /newer|schema|version/i);
  const sessionId = cards[0]!.authority.id, bench = new BenchStore(sessionDir(worldDir, sessionId));
  const session = readBenchSession(worldDir, sessionId)!;
  assert.deepEqual(session.subject, { kind: "production", productionId: "saltlight", productionTitle: store.getBundle().productions.find(p => p.meta.id === "saltlight")!.meta.title, role: "music" });
  const take = session.takes[0]!, bytes = wav(Array(48000).fill(1000)), hash = audioHash(bytes);
  await mkdir(join(sessionDir(worldDir, sessionId), "media", take.id), { recursive: true });
  await writeFile(join(sessionDir(worldDir, sessionId), "media", take.id, "cue.wav"), bytes);
  await bench.append({ type: "take-completed", takeId: take.id, media: { file: "cue.wav", hash, info: { durationSec: 1, hasAudio: true, hasVideo: false } }, completedAt: AT }, { at: AT });
  await lifecycle.reconcileAction(conversationId, cards[0]!.actionId);
  const child = (await view()).actions.find(card => card.actionId === cards[1]!.actionId)!;
  assert.equal(child.availableDecisions.includes("approve"), true);
  assert.equal((await decide(child)).status, "completed");
  let production = store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
  const request = production.editorRequests.find(r => r.actionId === child.actionId)!;
  assert.equal(request.status, "pending");
  const artifact = store.getBundle().artifacts.find(a => a.generation?.source === "bench" && a.generation.takeId === take.id)!;
  assert.equal(artifact.production, "saltlight");
  assert.equal(production.timeline?.status === "ready" && production.timeline.timeline.tracks.find(t => t.id === "tr_music")!.clips.length, 0);
  await lifecycle.reconcileAction(conversationId, child.actionId);
  await decideEditorRequest(store, { productionId: "saltlight", requestId: request.id, decision: "accept", now: AT });
  production = store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
  assert.ok(production.timeline?.status === "ready");
  const clip = production.timeline.timeline.tracks.find(t => t.id === "tr_music")!.clips[0]!;
  assert.equal(clip.gainDb, -6); assert.equal(clip.role, "music"); assert.equal(clip.startFrame, 0); assert.equal(clip.durationFrames, 12);
  assert.deepEqual(clip.source, { kind: "artifact", artifactId: artifact.id, label: "Music Take 1" });
  assert.equal(admitted.length, 1);
  assert.equal(production.editorRequests.filter(r => r.actionId === child.actionId).length, 1);
  const renamed = structuredClone(store.getBundle()); renamed.productions.find(p => p.meta.id === "saltlight")!.meta.title = "New production title";
  store.getBundle = () => renamed;
  const reused = await prepareBenchChatSession(store, { ...music(), productionId: "saltlight", sessionId }, newId("act"), AT);
  assert.equal(reused.session.subject?.productionId, "saltlight");
  const { references: _references, ...rerunComposer } = music().composer;
  await prepareBenchChatSession(store, { kind: "bench-generation", productionId: "saltlight", sessionId, rerunTakeId: take.id, composer: rerunComposer, checkReceiptIds: [] }, newId("act"), AT);
  await assert.rejects(prepareBenchChatSession(store, { ...music(), productionId: "saltlight", cueRole: "ambience", sessionId }, newId("act"), AT), /another production or audio role/);
});

it("quotes and denies a title cue without creating a session, then approves one session and one job exactly once", async t => {
  const { store, worldDir, admitted, deps } = await setup(t);
  const action = music(), deniedId = newId("act");
  const denied = benchChatSessionId(action, deniedId);
  const scope = { conversationId: newId("cv") };
  const body = await deps().benchGenerationQuotes!.prepare(action, deniedId, AT, scope);
  assert.equal(body.quantity, 1);
  assert.match(body.prompt, /slow solo piano/);
  assert.match(body.prompt, /\[instrumental\]/);
  assert.equal(readBenchSession(worldDir, denied), null);
  await deps().benchGenerationQuotes!.abandon(deniedId);
  assert.equal(readBenchSession(worldDir, denied), null);
  assert.equal(admitted.length, 0);
  const id = newId("act"), sessionId = benchChatSessionId(action, id);
  await deps().benchGenerationQuotes!.prepare(action, id, AT, scope);
  const frozen = JSON.parse(await readFile(join(worldDir, ".history/world/prepared", `${id}.generation.json`), "utf8"));
  // Crash after creating the header and composer, before any admission record: repeat the
  // exact materialization, recompose dependencies, then rejoin the durable quote.
  await materializeBenchChatSession(store, id, frozen.materialization);
  await materializeBenchChatSession(store, id, frozen.materialization);
  assert.equal(readBenchSession(worldDir, sessionId)!.takes.length, 0);
  await deps().benchGenerationQuotes!.validate(action, id);
  assert.equal((await deps().benchGenerationQuotes!.dispatch(action, id)).status, "queued");
  assert.equal((await deps().benchGenerationQuotes!.dispatch(action, id)).status, "running");
  const session = readBenchSession(worldDir, sessionId)!;
  assert.equal(session.takes.length, 1);
  assert.equal(session.composer.mode, "music");
  assert.equal(session.title, action.composer.brief);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]!.idempotencyKey, frozen.inputs[0].idempotencyKey);
});

it("pages safe route and Bench reads and rejects changed cursors and damaged journals without repairing them", async t => {
  const { store, worldDir, manifest, deps } = await setup(t);
  const action = music(), id = newId("act");
  await deps().benchGenerationQuotes!.prepare(action, id, AT);
  await deps().benchGenerationQuotes!.dispatch(action, id);
  const sessionId = benchChatSessionId(action, id);
  let disabled: string[] = [];
  const routes = () => generationRouteReadRows({ ...manifest, models: [{ ...IMAGE, speechPlan: "free-credit" }, MUSIC] }, disabled);
  assert.doesNotMatch(JSON.stringify(routes()), /speechPlan|free-credit|credential/);
  const lease = new QueryLeaseRegistry(() => WORLD_ID).mint({ worldId: WORLD_ID, conversationId: newId("cv"), runId: newId("run") });
  const reads = new WorldChatTargetReads({ getBenchRows: id => benchReadRows(worldDir, id), getGenerationRouteRows: routes });
  const first = await reads.call(lease, store.getBundle(), "list_generation_routes", { limit: 1 });
  assert.equal(first.result.complete, false);
  disabled = [IMAGE.id];
  await assert.rejects(reads.call(lease, store.getBundle(), "list_generation_routes", { cursor: first.result.nextCursor }), /changed|current|stale/i);
  const session = await reads.call(lease, store.getBundle(), "get_bench_session", { sessionId, limit: 1 });
  assert.equal(session.result.target.id, sessionId);
  const log = new BenchStore(sessionDir(worldDir, sessionId));
  await log.append({ type: "title-set", title: "Changed elsewhere" }, { at: AT });
  await assert.rejects(reads.call(lease, store.getBundle(), "get_bench_session", { sessionId, cursor: session.result.nextCursor }), /changed|current|stale/i);
  const path = join(sessionDir(worldDir, sessionId), "events.jsonl");
  const damaged = (await readFile(path, "utf8")) + "{torn";
  await writeFile(path, damaged);
  assert.throws(() => benchReadRows(worldDir, sessionId), /recovery/);
  assert.equal(await readFile(path, "utf8"), damaged);
});

it("takes the full reference composer through approval and rejects silent media/reference substitution", async t => {
  const { store, worldDir, deps } = await setup(t);
  const file = join(worldDir, "references", "maren-kest", "main.png");
  await mkdir(join(worldDir, "references", "maren-kest"), { recursive: true });
  await writeFile(file, pngBytes());
  // Use the world's own accepted kit identity; no model-authored path enters the action.
  await store.gateOp(() => writeFile(join(worldDir, "references", "maren-kest", "kit.json"), JSON.stringify(ReferenceKitSchema.parse({
    sheetId: "maren-kest", tiles: [], compilations: [], mainPhoto: { file: "main.png", source: "upload", acceptedAt: AT },
  }))));
  const action: Extract<ModelWorldChatAction, { kind: "bench-generation" }> = { kind: "bench-generation", composer: {
    mode: "image", brief: "Image 1 beside a tide clock", provider: IMAGE.provider, model: IMAGE.id,
    params: { kind: "image", count: 1 }, references: [{ kind: "kit", sheetId: "maren-kest", image: "main-photo", role: "reference" }],
  }, checkReceiptIds: [newId("check")] };
  const id = newId("act");
  const body = await deps().benchGenerationQuotes!.prepare(action, id, AT);
  assert.equal(body.references.length, 1);
  await deps().benchGenerationQuotes!.dispatch(action, id);
  const session = readBenchSession(worldDir, benchChatSessionId(action, id))!;
  assert.deepEqual(session.composer.activeTokens, ["Image 1"]);
  assert.equal(session.tokenRegistry[0]!.source.source, "world-file");
  assert.equal(session.takes[0]!.request.references.length, 1);
  const { references: _references, ...composer } = action.composer;
  const completed = completeBenchChatAction(worldDir, { ...action, sessionId: session.id, composer });
  assert.deepEqual(completed.composer.references, [{ kind: "session-token", token: "Image 1", role: "reference" }], "prepared legacy composers disclose every inherited reference");
  await assert.rejects(prepareBenchChatSession(store, { ...action, composer: { ...action.composer, mode: "video",
    params: { kind: "video", durationSec: 4, sound: false }, references: [
      { kind: "kit", sheetId: "maren-kest", image: "main-photo", role: "start-frame" },
      { kind: "kit", sheetId: "maren-kest", image: "main-photo", role: "end-frame" },
    ] } }, newId("act"), AT), /different references/);
  await assert.rejects(prepareBenchChatSession(store, { ...music(), composer: { ...music().composer, references: action.composer.references } }, newId("act"), AT), /cannot send reference/);
  await assert.rejects(prepareBenchChatSession(store, { ...action, rerunTakeId: newId("tk") }, newId("act"), AT), /rerun.*existing/i);
});

it("binds one cue card, denies without creation, and applies fenced take decisions through the actual lifecycle", async t => {
  const { store, worldDir, admitted, deps } = await setup(t);
  const conversationId = newId("cv");
  const log = new WorldChatStore(conversationDir(worldDir, conversationId));
  await log.create(conversationId, AT);
  await log.append({ type: "conversation.created", title: "Title cue", entryContext: { kind: "world" } }, { at: AT });
  const dependencies = deps();
  const lifecycle = new ConversationActionLifecycle({ worldPath: worldDir, worldId: store.worldId,
    adapters: worldChatActionAdapters(store, null, () => AT, dependencies), now: () => AT });
  const view = async () => foldConversation(conversationId, AT, (await log.read()).events).view;
  const bind = async (raw: ModelWorldChatAction) => {
    const reads = raw.kind === "bench-generation"
      ? [{ requirement: "jobs" as const, id: store.worldId, fence: jobsFence([], store.worldId) },
        { requirement: "generation-routes" as const, id: store.worldId, fence: productionReadFence(dependencies.getGenerationRouteRows!()) }]
      : "sessionId" in raw && raw.sessionId ? [{ requirement: "bench" as const, id: raw.sessionId, fence: productionReadFence(benchReadRows(worldDir, raw.sessionId)) },
        ...(raw.kind === "bench-keep" ? [{ requirement: "artifacts" as const, id: store.worldId, fence: artifactsFence(store.getBundle()) }] : [])] : [];
    const receipts = reads.map(read => ({ id: newId("check"), runId: newId("run"), tool: "target-read" as const, status: "complete" as const,
      consulted: [], target: { requirement: read.requirement, id: read.id }, observedRevisionOrDigest: read.fence, complete: true, nextCursor: null, at: AT }));
    const action = { ...raw, checkReceiptIds: receipts.map(receipt => receipt.id) };
    const prepared = prepareWorldChatActions(store, lifecycle, { conversationId, turnId: newId("turn"), entryContext: { kind: "world" },
      candidates: [], groups: [], existingCandidates: [], existingGroups: [], bibleEdits: [], bibleBaseVersion: 1,
      sceneEdits: [], sceneBaseVersion: null, editorRequests: [], actions: [action], receipts, at: AT }, dependencies);
    assert.equal(prepared.length, 1);
    await log.append({ type: "action.prepare-intent", intent: prepared[0]!.intent }, { at: AT });
    await lifecycle.bindIntent(prepared[0]!.intent, prepared[0]!.payload);
    return (await view()).actions.at(-1)!;
  };
  const decide = async (card: Awaited<ReturnType<typeof bind>>, decision: "approve" | "deny" = "approve") => lifecycle.decide({
    kind: "conversation-action-decide", worldId: store.worldId, conversationId, actionId: card.actionId,
    expectedConversationSeq: (await view()).seq, expectedStatus: "pending", decision, requestId: ulid(),
  });
  const denied = await bind(music());
  assert.equal(readBenchSession(worldDir, denied.authority.id), null);
  await decide(denied, "deny");
  assert.equal(readBenchSession(worldDir, denied.authority.id), null);
  assert.equal(admitted.length, 0);
  const generation = await bind({ kind: "bench-generation", composer: { mode: "image", provider: IMAGE.provider, model: IMAGE.id,
    brief: "A tide clock", params: { kind: "image", count: 2 }, references: [] }, checkReceiptIds: [] });
  assert.equal((await decide(generation)).status, "queued");
  const sessionId = generation.authority.id;
  const session = readBenchSession(worldDir, sessionId)!;
  const bench = new BenchStore(sessionDir(worldDir, sessionId));
  const take = session.takes[0]!, other = session.takes[1]!;
  const bytes = pngBytes(), hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await mkdir(join(sessionDir(worldDir, sessionId), "media", take.id), { recursive: true });
  await writeFile(join(sessionDir(worldDir, sessionId), "media", take.id, "result.png"), bytes);
  await bench.append({ type: "take-completed", takeId: take.id, media: { file: "result.png", hash }, completedAt: AT }, { at: AT });
  const selection = await bind({ kind: "bench-select", sessionId, takeId: take.id, checkReceiptIds: [] });
  assert.equal((await decide(selection)).status, "completed");
  assert.equal(readBenchSession(worldDir, sessionId)!.selectedTakeId, take.id);
  const keep = await bind({ kind: "bench-keep", sessionId, takeId: take.id, checkReceiptIds: [] });
  assert.equal((await decide(keep)).status, "completed");
  assert.equal(store.getBundle().artifacts.filter(a => a.generation?.source === "bench" && a.generation.takeId === take.id).length, 1);
  const discard = await bind({ kind: "bench-discard", sessionId, takeId: other.id, checkReceiptIds: [] });
  assert.equal(discard.shown.permissionReason, "destructive-change");
  assert.equal(discard.shown.body.family, "destructive");
  assert.equal(readBenchSession(worldDir, sessionId)!.takes[1]!.disposition, "open");
  assert.equal((await decide(discard)).status, "completed");
  assert.equal(readBenchSession(worldDir, sessionId)!.takes[1]!.disposition, "discarded");
  assert.equal(admitted.length, 2);
});

it("retains conversation attachment bytes used by Bench, including immutable reruns", async t => {
  const { store, worldDir, deps } = await setup(t);
  const service = new WorldChatService(worldDir, () => AT);
  const conversation = await service.create({ title: "Reference photo" });
  const attachment = await new WorldChatAttachmentStore(worldDir, () => AT).ingest(conversation.id, { fileName: "photo.png", bytes: pngBytes() });
  const action: Extract<ModelWorldChatAction, { kind: "bench-generation" }> = { kind: "bench-generation", composer: {
    mode: "image", brief: "A tide clock beside this photo", provider: IMAGE.provider, model: IMAGE.id,
    params: { kind: "image", count: 2 }, references: [{ kind: "attachment", attachmentId: attachment.id, role: "reference" }],
  }, checkReceiptIds: [newId("check")] };
  const id = newId("act");
  await deps().benchGenerationQuotes!.prepare(action, id, AT, { conversationId: conversation.id });
  assert.equal(await service.blockedFromDeletion(conversation.id), null);
  await deps().benchGenerationQuotes!.dispatch(action, id);
  assert.equal(await service.blockedFromDeletion(conversation.id), "bench-references");
  assert.equal((await service.load(conversation.id))!.deletionBlock, "bench-references");
  await assert.rejects(service.delete(conversation.id, ulid()), /Bench.*attachments/);
  const sessionId = benchChatSessionId(action, id), session = readBenchSession(worldDir, sessionId)!;
  const request = session.takes[0]!.request;
  const rerun = { kind: "bench-generation" as const, sessionId, rerunTakeId: session.takes[0]!.id, checkReceiptIds: [newId("check")],
    composer: { mode: request.mode, brief: request.brief, params: request.params, provider: request.provider, model: request.model } };
  const rerunId = newId("act");
  const bench = new BenchStore(sessionDir(worldDir, sessionId));
  await bench.append({ type: "composer-set", brief: "An unrelated unfinished draft", mode: "music", provider: MUSIC.provider, model: MUSIC.id,
    params: { kind: "music", lyrics: "[instrumental]", count: 1 }, subjectRouting: { activeTokens: [], keyframeTokens: [] } }, { at: AT });
  const liveComposer = structuredClone(readBenchSession(worldDir, sessionId)!.composer);
  const quote = await deps().benchGenerationQuotes!.prepare(rerun, rerunId, AT, { conversationId: conversation.id });
  assert.equal(quote.quantity, 1, "rerun repeats one immutable take, regardless of its original batch count");
  assert.match(quote.purpose, /Rerun Take 1/);
  assert.equal((await deps().benchGenerationQuotes!.dispatch(rerun, rerunId)).status, "queued");
  assert.deepEqual(readBenchSession(worldDir, sessionId)!.composer, liveComposer, "a rerun never replaces the unrelated live draft or token lanes");
  const source = session.tokenRegistry[0]!.source;
  assert.equal(source.source, "world-file");
  if (source.source !== "world-file") return;
  await writeFile(join(worldDir, source.path), encodePng(solidImage(2, 2, [20, 60, 80, 255])));
  await assert.rejects(prepareBenchChatSession(store, rerun, newId("act"), AT), /reference changed/);
  const unrelated = newId("sess");
  await new BenchStore(sessionDir(worldDir, unrelated)).create(unrelated, AT);
  await writeFile(join(sessionDir(worldDir, unrelated), "events.jsonl"), "{torn");
  // Readable conversations stay available, while an incomplete scan cannot clear deletion.
  assert.equal((await service.load(conversation.id))!.deletionBlock, "bench-references-unavailable");
  await assert.rejects(service.delete(conversation.id, ulid()), /Bench references could not be checked/);
});

it("settles a reservation crash before queue admission without opening Bench or resubmitting", async t => {
  const { store, worldDir, admitted, deps } = await setup(t);
  const action = music(), id = newId("act"), sessionId = benchChatSessionId(action, id);
  await deps().benchGenerationQuotes!.prepare(action, id, AT);
  const path = join(worldDir, ".history/world/prepared", `${id}.generation.json`);
  const frozen = JSON.parse(await readFile(path, "utf8"));
  await materializeBenchChatSession(store, id, frozen.materialization);
  await new BenchStore(sessionDir(worldDir, sessionId)).append({ type: "takes-reserved", takes: frozen.materialization.reserved }, { at: AT, requestId: id });
  frozen.dispatchStarted = true;
  await writeFile(path, JSON.stringify(frozen));
  const result = await deps().benchGenerationQuotes!.reconcile({ actionId: id, authority: { id: sessionId } } as ConversationActionCard);
  assert.equal(result?.status, "failed");
  assert.equal(result?.receipt?.generation?.unattempted, 1);
  assert.equal(result?.receipt?.generation?.actualMicroUsd, 0);
  assert.equal(readBenchSession(worldDir, sessionId)!.takes[0]!.status, "failed");
  await deps().benchGenerationQuotes!.dispatch(action, id);
  assert.equal(admitted.length, 0);
});

it("removes unavailable provider routes and refuses a quote when provider eligibility changes", async t => {
  const { store, coordinator, deps } = await setup(t);
  const action = music(), id = newId("act");
  await deps().benchGenerationQuotes!.prepare(action, id, AT);
  assert.ok(deps().getGenerationRouteRows!().some(row => row.key === `fal:${MUSIC.id}`));
  coordinator.emit({ type: "provider.status", at: AT, providers: [{ id: "fal", configured: false, validation: "untested", fault: null, probes: [] }] });
  assert.ok(!deps().getGenerationRouteRows!().some(row => row.key.startsWith("fal:")));
  await assert.rejects(deps().benchGenerationQuotes!.validate(action, id), /eligible/);
  await assert.rejects(deps().benchGenerationQuotes!.prepare(action, newId("act"), AT), /eligible/);
  assert.equal(store.getBundle().meta.worldId, WORLD_ID);
});

it("pages public selectable catalogue voices, fences catalogue changes and validates the selected target", async t => {
  const { store, host, deps } = await setup(t);
  let voices: VoiceCandidate[] = ["Preset A", "Preset B"].map(label => ({ provider: VOICE.provider, model: VOICE.id, voiceId: label,
    label, attributes: ["warm"], local: false, canClone: false, previewUrl: "https://private.example/preview" }));
  host.voiceService = { catalogue: async () => voices };
  const reads = new WorldChatTargetReads({ getVoiceCatalogue: () => host.benchVoiceCatalogue(store) });
  const lease = new QueryLeaseRegistry(() => WORLD_ID).mint({ worldId: WORLD_ID, conversationId: newId("cv"), runId: newId("run") });
  const page = await reads.call(lease, store.getBundle(), "list_voices", { limit: 1 });
  assert.equal(page.result.total, 2 + store.getBundle().clonedVoices.length + store.getBundle().sheets.filter(sheet => sheet.voice).length);
  assert.match(JSON.stringify(page.result.items), /Preset A/);
  assert.doesNotMatch(JSON.stringify(page.result.items), /previewUrl|private.example/);
  const action: Extract<ModelWorldChatAction, { kind: "bench-generation" }> = { kind: "bench-generation", composer: {
    mode: "voice", brief: "The harbour remembers", provider: VOICE.provider, model: VOICE.id,
    params: { kind: "voice", voiceId: "Preset A", voiceProvider: VOICE.provider, voiceModel: VOICE.id, count: 1 }, references: [],
  }, checkReceiptIds: [newId("check")] };
  const id = newId("act");
  await deps().benchGenerationQuotes!.prepare(action, id, AT);
  voices = voices.map(voice => ({ ...voice, unavailableReason: "Provider no longer offers this voice" }));
  await assert.rejects(reads.call(lease, store.getBundle(), "list_voices", { cursor: page.result.nextCursor }), /changed/);
  await assert.rejects(deps().benchGenerationQuotes!.validate(action, id), /available speech voice/);
});

it("discloses and pins cloned recording uploads, records approval consent, and refuses changed or missing clips before reservation", async t => {
  const { store, worldDir, host, admitted, deps } = await setup(t);
  const source = join(worldDir, "recording.wav");
  const bytes = wav(Array.from({ length: 144_000 }, (_, index) => index % 100));
  await writeFile(source, bytes);
  const clone = await cloneVoice(store, [], { sourcePath: source, name: "Harbour glass", description: "Warm and dry", consent: true });
  assert.ok(clone.ok);
  host.voiceService = { catalogue: async () => [{ provider: VOICE.provider, model: VOICE.id, voiceId: clone.voice.id,
    label: clone.voice.name, attributes: [], local: false, canClone: true, readsClone: clone.voice.id }] };
  const action: Extract<ModelWorldChatAction, { kind: "bench-generation" }> = { kind: "bench-generation", composer: {
    mode: "voice", brief: "The harbour remembers", provider: VOICE.provider, model: VOICE.id,
    params: { kind: "voice", voiceId: clone.voice.id, voiceProvider: VOICE.provider, voiceModel: VOICE.id, count: 2 }, references: [],
  }, checkReceiptIds: [newId("check")] };
  const id = newId("act"), sessionId = benchChatSessionId(action, id);
  const body = await deps().benchGenerationQuotes!.prepare(action, id, AT);
  assert.equal(body.quantity, 2);
  assert.equal(body.references.length, 1, "batch speech discloses each source recording once");
  assert.match(body.references[0]!.role, /Cloned voice recording: Harbour glass/);
  assert.match(body.privacy!.join(" "), /upload.*Mistral.*training/);
  assert.equal(store.getBundle().clonedVoices[0]!.remote?.mistral?.confirmedAt, undefined);
  const path = join(worldDir, clone.voice.clip);
  await writeFile(path, wav(Array.from({ length: 144_000 }, () => 200)));
  await assert.rejects(deps().benchGenerationQuotes!.dispatch(action, id), /changed/);
  assert.equal(readBenchSession(worldDir, sessionId), null);
  await writeFile(path, "missing recording");
  await assert.rejects(deps().benchGenerationQuotes!.prepare(action, newId("act"), AT), /missing or invalid/);
  assert.equal(admitted.length, 0);
  await writeFile(path, bytes);
  assert.equal((await deps().benchGenerationQuotes!.dispatch(action, id)).status, "queued");
  assert.ok(store.getBundle().clonedVoices[0]!.remote?.mistral?.confirmedAt);
  assert.equal(admitted[0]!.voiceReference, true);
  assert.equal(admitted[0]!.voiceUploadConfirmedFor, `vendor:mistral:${clone.voice.id}`);
  assert.equal(admitted.length, 2);
  assert.equal(admitted[1]!.voiceUploadConfirmedFor, admitted[0]!.voiceUploadConfirmedFor);
  const breeze = await inspectBenchVoiceInputs(store, [{ ...admitted[0]!, provider: "breezeblue", model: "breeze-tts-2" }]);
  assert.match(breeze.privacy.join(" "), /clone charge.*BreezeBlue/);
});

it("includes automatic On screen voice references in the generation card and privacy disclosure", async t => {
  const { store, worldDir, deps } = await setup(t);
  const dir = join(worldDir, "references", "maren-kest");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "main.png"), pngBytes());
  const pcm = wav(Array.from({ length: 48_000 }, (_, i) => Math.round(Math.sin(i / 10) * 8000)));
  const report = analyzePcmWav(pcm, AT), outputHash = audioHash(pcm);
  await store.gateOp(() => writeFile(join(dir, "kit.json"), JSON.stringify(ReferenceKitSchema.parse({
    sheetId: "maren-kest", tiles: [], compilations: [], mainPhoto: { file: "main.png", source: "upload", acceptedAt: AT },
    designatedVoiceSample: { schemaVersion: 1, file: `voice/${outputHash.replace(":", "-")}.wav`, operationId: randomUUID(), designatedAt: AT,
      warningCodes: [], attestations: [], acknowledgementId: "reviewed-cloud-sample",
      provenance: { schemaVersion: 1, source: { kind: "legacy-character-sample", sheetId: "maren-kest", sourceFile: "voice/clone.wav",
        legacySource: "cloning-recording", legacyDesignatedAt: AT, sourceMediaHash: outputHash },
        sourceTechnical: report.technical, outputHash, outputTechnical: report.technical, preparation: [], qualityReport: report, createdAt: AT } },
  }))));
  const action: Extract<ModelWorldChatAction, { kind: "bench-generation" }> = { kind: "bench-generation", composer: {
    mode: "video", brief: "Maren speaks by the quay", provider: VIDEO.provider, model: VIDEO.id,
    params: { kind: "video", durationSec: 4, sound: true }, references: [{ kind: "kit", sheetId: "maren-kest", image: "main-photo", role: "reference" }],
  }, checkReceiptIds: [newId("check")] };
  const body = await deps().benchGenerationQuotes!.prepare(action, newId("act"), AT);
  assert.equal(body.references.length, 2);
  assert.equal(body.references[1]!.id, "@Audio1");
  assert.match(body.references[1]!.role, /Maren.*voice-reference/);
  assert.match(body.privacy!.join(" "), /2 attached references/);
});

it("recovers accepted production filing before a pending chat discard can hide its receipt", async t => {
  const { store, worldDir, deps } = await setup(t);
  const sessionId = newId("sess"), takeId = newId("tk"), productionTakeId = newId("tk"), frameArtifactId = newId("ar");
  const bench = await openSubjectBenchSession(worldDir, sessionId, AT, {
    title: "The quay",
    subject: { kind: "shot", productionId: "saltlight", productionTitle: "Saltlight", sceneId: "sc_04", sceneNumber: 4,
      sceneTitle: "The verse rises", shotId: "sh_12", shotNumber: 12, shotTitle: "The quay", durationSec: 4, aspect: "16:9" },
    composer: { mode: "image", brief: "A quay still", provider: IMAGE.provider, model: IMAGE.id,
      params: { kind: "image", count: 1 }, activeTokens: [], keyframeTokens: [] }, references: [],
  });
  await bench.store.append({ type: "takes-reserved", takes: [{ id: takeId, n: 1, requestId: "original", createdAt: AT,
    request: { mode: "image", brief: "A quay still", provider: IMAGE.provider, model: IMAGE.id, params: { kind: "image", count: 1 }, references: [], keyframes: [],
      productionProvenance: { canonRevision: store.getBundle().meta.canonRevision, sheets: {} },
      filing: { kind: "shot", productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12", productionTakeId, frameArtifactId } } }] }, { at: AT });
  await mkdir(join(sessionDir(worldDir, sessionId), "media", takeId), { recursive: true });
  const bytes = pngBytes();
  await writeFile(join(sessionDir(worldDir, sessionId), "media", takeId, "take.png"), bytes);
  await bench.store.append({ type: "take-completed", takeId, media: { file: "take.png", hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }, completedAt: AT }, { at: AT });
  const action = { kind: "bench-discard" as const, sessionId, takeId, checkReceiptIds: [newId("check")] };
  deps().benchControls!.prepare(action);
  const session = (await bench.store.fold())!;
  await fileBenchSubjectTake(store, session, session.takes[0]!);
  assert.equal((await bench.store.fold())!.takes[0]!.disposition, "open", "crash before the Bench receipt");
  assert.throws(() => deps().benchControls!.prepare(action), /already accepted/);
  await assert.rejects(deps().benchControls!.execute(action, newId("act"), () => null), /accepted|open Bench take/);
  assert.equal((await bench.store.fold())!.takes[0]!.disposition, "filed");
  assert.equal(store.getBundle().productions.find(production => production.meta.id === "saltlight")!.selections.sh_12!.startFrameArtifactId, frameArtifactId);
});
