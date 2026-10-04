import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { ulid, orderedShots, orderedTrackClips, type ClientMessage, type ConversationActionCard, type HarnessAdapter,
  type Job, type LedgerEntry, type ManifestModel, type SessionConfigInput } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "../../../providers/src/manifest-data.js";
import { Coordinator } from "../../src/coordinator.js";
import { ConversationActionService } from "../../src/application/conversation-actions.js";
import { conversationRunDependencies } from "../../src/application/conversation-runs.js";
import type { WorldChatActionAdapterDeps } from "../../src/world-chat/actions.js";
import { WorldChatRunner } from "../../src/world-chat/run.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { WorldQueryServer } from "../../src/harness/world-query.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { WorldStore } from "../../src/world/store.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { JobQueue, type EnqueueInput } from "../../src/queue/dispatcher.js";
import { readContainedImageReferences, readContainedVideoReferences } from "../../src/world/reference-files.js";
import { applyVoiceAssignment } from "../../src/sheets/authoring.js";
import { FakeProvider } from "../queue/fake-provider.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { acceptanceMedia } from "./acceptance-media.js";
import { wav } from "../audio/helpers.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { until } from "../wait.js";

const PRODUCTION = "conversation-film", AT = "2026-10-04T12:00:00.000Z";
const IMAGE: ManifestModel = { id: "acceptance-image", provider: "fal", capability: "image", displayName: "Acceptance image",
  accepts: { referenceImages: 16, startFrame: false, endFrame: false }, limits: { aspects: ["16:9"] }, pricing: { kind: "perImage", microUsdPerImage: 1000 } };
const VIDEO: ManifestModel = { id: "acceptance-video", provider: "fal", capability: "video", displayName: "Acceptance video",
  accepts: { referenceImages: 16, startFrame: true, endFrame: false }, modes: { generate: { locked: [] }, "first-frame": { locked: [], route: "first-frame" } },
  limits: { aspects: ["16:9"], maxDurationSec: 10, durations: { "4": "4" } }, pricing: { kind: "perSecond", microUsdPerSecond: 1000 } };
const LINE = "The bell is calling us home.";
type Read = [string, Record<string, unknown>];
type RecordRow = { step: number; prompt: string; actionId: string; actionKind: string; family: string; shown: ConversationActionCard["shown"];
  decision: string; estimate: number | null; dispatched: number; ledgerMicroUsd: number; jobs: string[] };

// This drives the real chat runner, leased MCP reads, action authorities, queue finalization,
// human editor decisions and export staging. Harness/provider responses are stubbed; native
// probing/encoding can run with FFmpeg. Installed playback is separate SPEC-051 R-1 evidence.
it("makes and exports a thirteen-step film through Production Chat with no pre-approval dispatch (SPEC-051 R-2)", { timeout: 240_000 }, async t => {
  const made = await makeTempRoot(), provider = new FsWorldProvider(made.root);
  await provider.loadWorld(WORLD_ID); const store = provider.openStore()!;
  await applyVoiceAssignment(store, { path: "characters/maren-kest.md", voice: { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "existing-voice" } });
  const fake = new FakeProvider({ supportsIdempotencyKey: true, supportsLookupByKey: true });
  const manifest = { ...structuredClone(SHIPPED_MANIFEST), models: [IMAGE, VIDEO, ...structuredClone(SHIPPED_MANIFEST.models)] };
  const media = await acceptanceMedia(made.root, process.env.ARKE_PRODUCTION_ACCEPTANCE_REAL_MEDIA === "1"), encoded = media.encodes;
  const coordinator = new Coordinator({ provider, adapter: null, manifest, appRoot: made.root, appVersion: "acceptance",
    changeLogPath: join(made.root, "changes.jsonl"),
    mediaProbe: media.probe, ffmpeg: media.runner });
  const internal = coordinator as unknown as { jobQueue: JobQueue; enqueueWithSpeechChecks(input: EnqueueInput): Promise<Job>;
    onJobTerminal(job: Job): Promise<void>; conversationActionDependencies(store: WorldStore): WorldChatActionAdapterDeps;
    handleClientMessage(message: ClientMessage): Promise<void> };
  await coordinator.openWorld(WORLD_ID);
  coordinator.emit({ type: "provider.status", at: AT, providers: (["fal", "elevenlabs"] as const).map(id => ({ id, configured: true, validation: "valid" as const, fault: null,
    probes: [{ capability: "image" as const, available: true }, { capability: "video" as const, available: true }, { capability: "music" as const, available: true }, { capability: "voice-tts" as const, available: true }] })) });
  const ledger: LedgerEntry[] = [];
  const queue = new JobQueue({ journalPath: join(made.root, "queue/jobs.jsonl"), clients: { fal: fake, elevenlabs: fake }, getKey: async () => "stub-key",
    emit: event => coordinator.emit(event), ledger: { readJobIds: async () => new Set(ledger.map(e => e.jobId)), has: async id => ledger.some(e => e.jobId === id), append: async entry => { ledger.push(entry); } },
    onProviderFault: () => {}, landInWorld: async (_id, land) => { await store.ownedWrite(() => land(store.dir)); return true; },
    readImageReferences: (_id, paths) => readContainedImageReferences(store.dir, paths), readVideoReferences: (_id, paths) => readContainedVideoReferences(store.dir, paths),
    onTerminal: job => internal.onJobTerminal(job), baseIntervalMs: 1, pollIntervalMs: 5 });
  internal.jobQueue = queue; internal.enqueueWithSpeechChecks = input => queue.enqueue(input); await queue.start();
  const deps = internal.conversationActionDependencies(store);
  const actions = new ConversationActionService(store, { gate: new ProposalManager(store), now: () => AT, isWorldOpen: () => true, actions: deps });
  const service = new WorldChatService(store.dir, () => AT);
  const conversation = await service.create({ title: "A film from conversation", entryContext: { kind: "production", productionId: PRODUCTION } });
  const log = new WorldChatStore(conversationDir(store.dir, conversation.id));
  const query = new WorldQueryServer(() => store);
  const prepared = new Map<string, SessionConfigInput>(); let session = "", sequence = 0;
  let answer: (url: string) => Promise<string> = async () => { throw new Error("No scripted human request"); };
  const adapter = {
    id: "acceptance-stub", capabilities: () => new Set(["events"]), readiness: () => ({ ready: true }), knownInputTokenLimit: () => 128_000,
    prepareSession: (input: SessionConfigInput) => prepared.set(input.preparationId!, input),
    createSession: async (input: { preparationId?: string }) => { session = `acceptance-${++sequence}`; prepared.set(session, prepared.get(input.preparationId!)!); return { sessionId: session }; },
    dispatchAsync: async () => ({ ok: true }), sendMessage: async () => ({ ok: true }),
    streamEvents: () => (async function* () { yield { type: "message.completed", sessionId: session, text: await answer(prepared.get(session)!.worldQueryUrl!) }; })(),
  } as unknown as HarnessAdapter;
  const runDeps = conversationRunDependencies(store, { adapter, sessionInput: input => input, scratchRoot: made.root, summaryDir: join(made.root, "summary"),
    activeStore: () => store, query, actions: actions.lifecycle, jobs: () => queue.listJobs(), generationRoutes: deps.getGenerationRouteRows,
    exports: () => deps.getExports?.() ?? [], actionExports: () => deps.getExports?.() ?? [], researchAllowed: async () => false,
    resolveLanguageModel: async () => ({}), onTurnFailed: () => {}, onProgress: () => {} });
  const runner = new WorldChatRunner({ ...runDeps, summarise: undefined, prepareActions: async turn => {
    try { return await runDeps.prepareActions!(turn); }
    catch (error) { console.info(`Acceptance preparation refused: ${error instanceof Error ? error.message : String(error)}`); throw error; }
  } });
  t.after(async () => { await query.stop(); await coordinator.stop(); await provider.close(); });
  const loaded = async () => { const meta = (await log.readMeta())!; return foldConversation(meta.id, meta.createdAt, (await log.read()).events).view; };
  const production = () => store.getBundle().productions.find(p => p.meta.id === PRODUCTION)!;
  const rows: RecordRow[] = [];
  const humanDecisions: unknown[] = [];
  // Editor preparation records a pending review. That operational record is permitted;
  // authored production data, selections and timeline must stay unchanged until a decision.
  const stateDigest = () => createHash("sha256").update(JSON.stringify(store.getBundle().productions.map(({ editorRequests: _reviews, ...authored }) => authored))).digest("hex");
  async function read(url: string, tool: string, args: Record<string, unknown>): Promise<string> {
    let cursor: string | null = null, receipt = "";
    do {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
        method: "tools/call", params: { name: tool, arguments: { ...args, ...(cursor ? { cursor } : {}) } } }) });
      const rpc = await response.json() as { error?: unknown; result?: { isError?: boolean; content: { text: string }[] } };
      assert.equal(rpc.error, undefined); assert.equal(rpc.result?.isError, undefined, tool);
      const page = JSON.parse(rpc.result!.content[0]!.text), citation = JSON.parse(rpc.result!.content[1]!.text);
      receipt = citation.checkReceiptId; cursor = page.nextCursor ?? null;
      if (!cursor) assert.equal(citation.targetRead.complete, true, `${tool} must finish its read`);
    } while (cursor);
    return receipt;
  }
  async function prepare(step: number, prompt: string, input: Record<string, unknown>, reads: Read[]) {
    const before = stateDigest(), submissions = fake.submitCount, jobs = queue.listJobs().length, encodes = encoded.length;
    answer = async url => {
      const checkReceiptIds = await Promise.all(reads.map(([tool, args]) => read(url, tool, args)));
      return JSON.stringify({ reply: "Review this step.", candidateOperations: [], groupOperations: [],
        ...(input.kind === "editor-request" ? { actions: [], editorRequests: [input.request] } : { actions: [{ ...input, checkReceiptIds }] }) });
    };
    const sent = await runner.send(log, conversation.id, prompt);
    assert.equal(sent.status, "completed", JSON.stringify(sent));
    const card = (await loaded()).actions.at(-1)!;
    assert.equal(card.status, "pending", `${prompt}: ${card.statusDetail ?? ""}`);
    const expectedKind = input.kind === "production-timeline-operation" || input.kind === "production-audio-edit"
      ? "world-chat-editor-request" : `world-chat-${input.kind}`;
    assert.equal(card.actionKind, expectedKind);
    assert.equal(fake.submitCount, submissions); assert.equal(queue.listJobs().length, jobs); assert.equal(encoded.length, encodes);
    assert.equal(stateDigest(), before, "preparation cannot mutate the production");
    if (card.shown.body.family === "generation") assert.ok(card.shown.body.estimatedMicroUsd! > 0, "spend is shown before approval");
    rows.push({ step, prompt, actionId: card.actionId, actionKind: card.actionKind, family: card.shown.body.family, shown: card.shown,
      decision: "pending", estimate: card.shown.body.family === "generation" ? card.shown.body.estimatedMicroUsd ?? null : null, dispatched: 0, ledgerMicroUsd: 0, jobs: [] });
    console.info(`Production acceptance ${step}: ${card.actionKind} pending; no dispatch`);
    return card;
  }
  async function decide(card: ConversationActionCard, decision: "approve" | "deny" = "approve") {
    const before = stateDigest(), submits = fake.submitCount, jobs = queue.listJobs().length, encodes = encoded.length;
    const result = await actions.decide({ kind: "conversation-action-decide", worldId: WORLD_ID, conversationId: conversation.id, actionId: card.actionId,
      expectedConversationSeq: (await loaded()).seq, expectedStatus: "pending", decision, requestId: ulid() });
    assert.ok(["completed", "queued", "running", "denied"].includes(result.status ?? "refused"), JSON.stringify(result));
    if (decision === "deny") { assert.equal(stateDigest(), before); assert.equal(fake.submitCount, submits); assert.equal(queue.listJobs().length, jobs); assert.equal(encoded.length, encodes); }
    else if (card.shown.body.family === "generation") {
      await until(() => {
        const added = queue.listJobs().slice(jobs);
        for (const job of added) {
          assert.notEqual(job.status, "failed", JSON.stringify(job));
          assert.notEqual(job.finalization?.status, "failed", JSON.stringify(job));
        }
        return added.length > 0 && added.every(job => job.finalization?.status === "complete");
      }, card.shown.title, 30_000).catch(error => { throw new Error(`${String(error)}: ${JSON.stringify(queue.listJobs().slice(jobs))}`); });
      await store.reload(); await actions.recover();
      assert.equal((await loaded()).actions.find(a => a.actionId === card.actionId)?.status, "completed");
    }
    const row = rows.at(-1)!; row.decision = decision; row.dispatched = fake.submitCount - submits;
    row.jobs = queue.listJobs().slice(jobs).map(job => job.id);
    row.ledgerMicroUsd = ledger.filter(entry => queue.listJobs().slice(jobs).some(job => job.id === entry.jobId)).reduce((sum, entry) => sum + (entry.actualMicroUsd ?? entry.estimatedMicroUsd), 0);
  }
  const sceneReads = (sceneId: string): Read[] => [["get_scene", { productionId: PRODUCTION, sceneId }]];
  const takeReads = (): Read[] => [["list_takes", { productionId: PRODUCTION }]];
  async function step(n: number, prompt: string, input: Record<string, unknown>, reads: Read[]) { const card = await prepare(n, prompt, input, reads); await decide(card); return card; }
  async function acceptEditor() {
    await internal.handleClientMessage({ kind: "world-chat-open", worldId: WORLD_ID, conversationId: conversation.id });
    const card = coordinator.getState().worldChat?.humanDecisions?.find(card => card.body.control.kind === "editor-request");
    assert.ok(card, "the editor decision must be available in this same thread");
    assert.equal(card.body.control.kind, "editor-request"); if (card.body.control.kind !== "editor-request") assert.fail();
    const requestId = card.body.control.requestId;
    humanDecisions.push({ step: 11, shown: card, requestId, decision: "accept" });
    await internal.handleClientMessage({ kind: "editor-request-decide", worldId: WORLD_ID, productionId: PRODUCTION, requestId, decision: "accept" });
    assert.equal(production().editorRequests.find(request => request.id === requestId)?.status, "accepted");
  }
  const creation = { kind: "production-create", production: { title: "Conversation film", medium: "video", productionKind: "film", aspect: "16:9", frameRate: 24 } };
  await decide(await prepare(1, "Make a short film in 16:9.", creation, [["list_productions", {}], ["list_series", {}]]), "deny");
  assert.equal(production(), undefined);
  await step(1, "Make that short film.", creation, [["list_productions", {}], ["list_series", {}]]);
  assert.equal(production().meta.aspect, "16:9");
  await step(2, "Write a one-scene overview about the bell calling Maren home.", { kind: "production-overview", productionId: PRODUCTION,
    changes: { logline: "Maren and Bray hear the bell at the saltmarket.", spine: "They decide to return together." } }, [["get_story", { productionId: PRODUCTION }]]);
  await step(3, "Write one scene, with three shots and Maren's line.", { kind: "production-scene", productionId: PRODUCTION, change: { operation: "create", title: "The bell",
    scriptBlocks: [{ id: "blk_arrival", kind: "action", text: "Maren and Bray stand in the saltmarket." }, { id: "blk_bell", kind: "dialogue", speaker: "maren-kest", text: LINE }] } }, [["list_scenes", { productionId: PRODUCTION }]]);
  const sceneId = production().scenes[0]!.id;
  await step(3, "Give it three four-second shots.", { kind: "production-scene-command", productionId: PRODUCTION, sceneId, commands: [3, 2, 1].map(i => ({ kind: "insert-shot", at: { atStart: true },
    shot: { title: `Shot ${i}`, description: "Maren Kest and Bray Half-Hitch hear the bell at the saltmarket.", durationSec: 4, ...(i === 1 ? { audio: { kind: "dialogue", speaker: "maren-kest", line: LINE } } : {}) } })) }, sceneReads(sceneId));
  assert.equal(orderedShots(production().scenes[0]!).length, 3);
  await step(4, "Cast Maren and Bray at the saltmarket.", { kind: "production-scene-command", productionId: PRODUCTION, sceneId,
    command: { kind: "edit-scene", inherits: { location: "the-saltmarket" }, cast: { "maren-kest": {}, "bray-half-hitch": {} } } }, sceneReads(sceneId));
  const shotIds = orderedShots(production().scenes[0]!).map(shot => shot.id), clips: string[] = [];
  for (const [index, shotId] of shotIds.entries()) {
    fake.inlineArtifacts = [{ name: "frame.png", contentType: "image/png", data: encodePng(solidImage(160, 90, [40, 90, 120, 255])) }];
    const input = { kind: "production-take-generation", productionId: PRODUCTION, sceneId, target: { kind: "shot", shotId }, mode: "image", modelId: IMAGE.id };
    if (index === 0) await decide(await prepare(5, "Try a start frame, but deny this quote.", input, [...sceneReads(sceneId), ...takeReads()]), "deny");
    await step(5, `Generate start frame ${index + 1}.`, input, [...sceneReads(sceneId), ...takeReads()]);
    const frame = production().takes.at(-1)!; assert.equal(production().selections[shotId]?.startFrameTakeId, undefined);
    await step(5, `Use start frame ${index + 1}.`, { kind: "production-take-review", productionId: PRODUCTION, takeId: frame.id, review: { decision: "accept", shotId } }, takeReads());
  }
  for (const [index, shotId] of shotIds.entries()) {
    fake.inlineArtifacts = [{ name: "clip.mp4", contentType: "video/mp4", data: media.video }];
    await step(6, `Generate video take ${index + 1}.`, { kind: "production-take-generation", productionId: PRODUCTION, sceneId,
      target: { kind: "shot", shotId }, mode: "video", modelId: VIDEO.id }, [...sceneReads(sceneId), ...takeReads()]);
    clips.push(production().takes.at(-1)!.id); assert.equal(production().selections[shotId]?.acceptedTakeId, undefined);
  }
  for (const [index, takeId] of clips.entries()) await step(7, `Select take ${index + 1}.`, { kind: "production-take-review", productionId: PRODUCTION, takeId,
    review: { decision: "accept", shotId: shotIds[index] } }, takeReads());
  fake.inlineArtifacts = [{ name: "speech.wav", contentType: "audio/wav", data: wav(Array(48000).fill(1000)) }];
  await step(8, "Voice Maren's line.", { kind: "production-audio-generation", productionId: PRODUCTION, request: { operation: "voice-line", shotId: shotIds[0], modelId: "eleven_multilingual_v2" } },
    [["list_scenes", { productionId: PRODUCTION }], ["list_sheets", {}], ["list_voices", {}]]);
  const voiceTake = production().takes.find(take => take.kind === "voice")!;
  fake.inlineArtifacts = [{ name: "score.wav", contentType: "audio/wav", data: wav(Array(48000 * 4).fill(1000)) }];
  const score = await step(9, "Generate a quiet instrumental score cue.", { kind: "bench-generation", productionId: PRODUCTION, cueRole: "music",
    composer: { mode: "music", provider: "fal", model: "minimax-music-3", brief: "A quiet instrumental harbour score.", params: { kind: "music", lyrics: "[instrumental]", count: 1 } } },
    [["list_jobs", {}], ["list_generation_routes", {}]]);
  const projected = (await actions.project([score]))[0]!, scoreResult = projected.generationWork?.results?.[0]; assert.ok(scoreResult?.mediaPath);
  const scoreJob = queue.listJobs().find(job => job.target.kind === "bench-take")!;
  const [scoreSessionId, scoreTakeId] = scoreJob.target.id!.split("/"); assert.equal(scoreResult.id, scoreTakeId);
  const timelineReads = (): Read[] => [["get_timeline", { productionId: PRODUCTION }]];
  await step(10, "Assemble the three selected takes in order.", { kind: "production-timeline-operation", productionId: PRODUCTION, request: { operation: "assemble", sceneIds: [sceneId] } },
    [...timelineReads(), ["list_scenes", { productionId: PRODUCTION }], ...takeReads(), ["list_artifacts", {}]]);
  assert.equal(production().timeline?.status, "ready");
  await step(11, "Add Dialogue and Music tracks.", { kind: "production-audio-edit", productionId: PRODUCTION, request: { summary: "Create the audio lanes", commands: [
    { kind: "add-track", trackId: "tr_dialogue", trackKind: "audio", name: "Dialogue", defaultRole: "dialogue" }, { kind: "add-track", trackId: "tr_music", trackKind: "audio", name: "Music", defaultRole: "music" }] } }, timelineReads());
  for (const [source, trackId, role, durationFrames] of [[{ kind: "take", takeId: voiceTake.id }, "tr_dialogue", "dialogue", 24],
    [{ kind: "bench-take", sessionId: scoreSessionId, takeId: scoreTakeId }, "tr_music", "music", 96]] as const) {
    const reads: Read[] = [...timelineReads(), ...(source.kind === "take" ? takeReads() : [["get_bench_session", { sessionId: scoreSessionId }] as Read])];
    await step(11, `Place the ${role}.`, { kind: "production-audio-cue", productionId: PRODUCTION, source, trackId, role, startFrame: 0, durationFrames }, reads); await acceptEditor();
  }
  await step(12, "Add the line as subtitles.", { kind: "editor-request", productionId: PRODUCTION, request: { summary: "Subtitle Maren's line", commands: [
    { kind: "add-subtitle-track", trackId: "tr_subtitles", name: "English", language: "en" }, { kind: "add-cue", trackId: "tr_subtitles", cue: { id: "cu_bell", text: LINE, startFrame: 0, endFrame: 24, speaker: "maren-kest" } }] } }, timelineReads());
  await step(13, "Export the review cut with subtitles.", { kind: "production-cut-export", productionId: PRODUCTION, scope: { kind: "production" }, preset: "review-cut",
    subtitles: { mode: "sidecar", trackId: "tr_subtitles", sidecar: "srt" } }, [...timelineReads(), ["list_episodes", { productionId: PRODUCTION }], ["list_exports", { productionId: PRODUCTION }]]);
  await until(() => deps.getExports?.().some(exported => exported.productionId === PRODUCTION && exported.status === "done") ?? false, "completed export", 30_000);
  await actions.recover();
  const exported = deps.getExports!().find(exported => exported.productionId === PRODUCTION && exported.status === "done")!;
  assert.ok(exported.output); assert.ok((await stat(join(store.dir, exported.output))).size > 0);
  const subtitles = (await readdir(join(store.dir, "exports"))).filter(file => file.endsWith(".srt")); assert.equal(subtitles.length, 1);
  const subtitleFile = `exports/${subtitles[0]!}`; assert.match(await readFile(join(store.dir, subtitleFile), "utf8"), /The bell is calling us home\./);
  assert.equal(encoded.length, 1); assert.equal(fake.submitCount, 8); assert.equal(queue.listJobs().length, 8);
  assert.deepEqual(new Set(rows.map(row => row.step)), new Set(Array.from({ length: 13 }, (_, i) => i + 1)));
  const timeline = production().timeline; assert.equal(timeline?.status, "ready"); if (timeline?.status !== "ready") assert.fail();
  assert.equal(orderedTrackClips(timeline.timeline.tracks.find(track => track.kind === "picture")!).length, 3);
  assert.equal(timeline.timeline.tracks.find(track => track.id === "tr_subtitles")?.cues?.[0]?.text, LINE);
  if (media.real) { const info = await media.probe.info(join(store.dir, exported.output)); assert.equal(info.width, 1280); assert.equal(info.height, 720); assert.equal(info.durationSec, 12); assert.equal(info.hasAudio, true); }
  const report = { platform: process.platform, providerMode: "stub", encoderMode: media.real ? "ffmpeg" : "stub", installedAcceptance: false, productionId: PRODUCTION, exportedFile: exported.output,
    outputBytes: (await stat(join(store.dir, exported.output))).size, subtitleFile, cards: rows,
    humanDecisions, settledActions: (await loaded()).actions.map(card => ({ actionId: card.actionId, status: card.status })) };
  await writeFile(join(made.root, "production-acceptance.json"), JSON.stringify(report, null, 2));
  if (process.env.ARKE_PRODUCTION_ACCEPTANCE_DIR) {
    await mkdir(process.env.ARKE_PRODUCTION_ACCEPTANCE_DIR, { recursive: true });
    await writeFile(join(process.env.ARKE_PRODUCTION_ACCEPTANCE_DIR, "report.json"), JSON.stringify(report, null, 2));
    await cp(join(store.dir, exported.output), join(process.env.ARKE_PRODUCTION_ACCEPTANCE_DIR, "review-cut.mp4"));
    await cp(join(store.dir, subtitleFile), join(process.env.ARKE_PRODUCTION_ACCEPTANCE_DIR, "review-cut.srt"));
  }
  t.diagnostic(`13 steps; ${rows.length} cards; 8 approved media jobs; export ${report.outputBytes} bytes; stub providers; ${report.encoderMode} encoder; installed acceptance remains separate`);
});
