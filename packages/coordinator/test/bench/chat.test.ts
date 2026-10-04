import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { it, type TestContext } from "node:test";
import { JobSchema, ReferenceKitSchema, newId, ulid, type Job, type ManifestModel, type ModelWorldChatAction } from "@arke-studio/contracts";
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
import { jobsFence, artifactsFence } from "../../src/world-chat/target-reads.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { BenchStore, sessionDir } from "../../src/bench/store.js";
import { benchReadRows, generationRouteReadRows, readBenchSession } from "../../src/bench/chat-reads.js";
import { benchChatSessionId, completeBenchChatAction, materializeBenchChatSession, prepareBenchChatSession } from "../../src/bench/chat-session.js";
import { WorldChatTargetReads } from "../../src/world-chat/target-reads.js";
import { QueryLeaseRegistry } from "../../src/world-chat/lease.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { pngBytes } from "../queue/fake-provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const AT = "2026-10-04T02:00:00.000Z";
const IMAGE: ManifestModel = { id: "chat-image", provider: "fal", capability: "image", displayName: "Chat image",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perImage", microUsdPerImage: 10_000 } };
const MUSIC: ManifestModel = { id: "minimax-music-3", provider: "fal", capability: "music", displayName: "Piano route",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perSecond", microUsdPerSecond: 100 } };
const music = (): Extract<ModelWorldChatAction, { kind: "bench-generation" }> => ({ kind: "bench-generation", composer: {
  mode: "music", brief: "A slow solo piano cue for the title. Instrumental; no vocals.", provider: MUSIC.provider, model: MUSIC.id,
  params: { kind: "music", lyrics: "[instrumental]", count: 1 }, references: [],
}, checkReceiptIds: [newId("check")] });
async function setup(t: TestContext) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => AT });
  t.after(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore()!;
  const manifest = { manifestVersion: 1 as const, generated: "2026-10-04", models: [IMAGE, MUSIC] };
  const coordinator = new Coordinator({ provider, adapter: null, manifest, changeLogPath: join(root, "changes.jsonl"), appVersion: "test" });
  const host = coordinator as unknown as { conversationActionDependencies(store: WorldStore): WorldChatActionAdapterDeps;
    enqueueWithSpeechChecks(input: EnqueueInput): Promise<Job>; jobQueue: { listJobs(): Job[] } };
  const admitted: EnqueueInput[] = [], jobs: Job[] = [];
  host.jobQueue = { listJobs: () => jobs };
  host.enqueueWithSpeechChecks = async input => { admitted.push(input); const job = JobSchema.parse({ ...input,
    id: newId("jb"), status: "queued", createdAt: AT, updatedAt: AT }); jobs.push(job); return job; };
  return { store, worldDir, manifest, admitted, deps: () => host.conversationActionDependencies(store) };
}

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
  const quote = await deps().benchGenerationQuotes!.prepare(rerun, rerunId, AT, { conversationId: conversation.id });
  assert.equal(quote.quantity, 1, "rerun repeats one immutable take, regardless of its original batch count");
  assert.match(quote.purpose, /Rerun Take 1/);
  assert.equal((await deps().benchGenerationQuotes!.dispatch(rerun, rerunId)).status, "queued");
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
