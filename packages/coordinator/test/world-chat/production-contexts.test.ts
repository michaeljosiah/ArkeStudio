import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConversationActionCardSchema, EditorRequestSchema, newId, ulid, type AudioRightsEvent, type WorldChatContext, type ManifestModel } from "@arke-studio/contracts";
import { readAudioRights, readAudioRightsSync } from "../../src/audio/rights.js";
import { analyzePcmWav, audioHash } from "../../src/audio/qc.js";
import { wav } from "../audio/helpers.js";
import { fixtureBundle } from "../index-db/helpers.js";
import { tempDir } from "../tmp.js";
import { worldChatContextExists, worldChatSubjectExists } from "../../src/world-chat/context-validation.js";
import { productionOfContext } from "../../src/productions/editor-requests.js";
import { sceneOfContext } from "../../src/productions/scene-edits.js";
import { compileFrameRun } from "../../src/productions/frame-run.js";
import { describeEntryContext } from "../../src/world-chat/entry-context.js";
import { actionGuideScopes, renderActionGuide } from "../../src/world-chat/action-guide.js";
import { assembleContext } from "../../src/world-chat/context.js";
import { frameRunReadRows, productionReadFence, voiceSampleReadRows } from "../../src/world-chat/production-reads.js";
import { WorldChatTargetReads } from "../../src/world-chat/target-reads.js";
import { QueryLeaseRegistry } from "../../src/world-chat/lease.js";
import { receiptBinding } from "./production-context-fixtures.js";

describe("Production Chat contexts and records (SPEC-051 R-37, R-41..45)", () => {
  it("resolves all workspace contexts and refuses foreign or missing subjects", async () => {
    const bundle = await fixtureBundle();
    for (const kind of ["shot", "stage", "takes"] as const) {
      const context = { kind, productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12" };
      assert.equal(worldChatContextExists(bundle, context), true);
      assert.equal(worldChatContextExists(bundle, { ...context, shotId: "sh_missing" }), false);
      assert.equal(worldChatContextExists(bundle, { ...context, sceneId: "sc_missing" }), false);
      assert.equal(worldChatSubjectExists(bundle, context, { kind: "shot", sceneId: "sc_02", shotId: "sh_12" }), false);
      assert.equal(productionOfContext(context), "saltlight");
      assert.deepEqual(sceneOfContext(context), { productionId: "saltlight", sceneId: "sc_04" });
    }
    assert.equal(worldChatContextExists(bundle, { kind: "generate", productionId: "saltlight" }), true);
    assert.equal(worldChatContextExists(bundle, { kind: "generate", productionId: "saltlight", shotId: "sh_12" }), false);
    assert.equal(worldChatContextExists(bundle, { kind: "generate", productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12" }), true);
    assert.equal(worldChatContextExists(bundle, { kind: "cut", productionId: "missing" }), false);
    assert.equal(productionOfContext({ kind: "cut", productionId: "saltlight" }), "saltlight");
  });

  it("puts relevant real actions first without dropping the full guide, and announces timeline reads in both modes", async () => {
    const bundle = await fixtureBundle();
    const kinds = ["shot", "stage", "takes", "generate", "cut"] as const;
    const expected = ["production-scene-command", "production-stage-construct", "production-take-review", "production-frame-run-start", "production-audio-generation"];
    for (const [index, kind] of kinds.entries()) {
      const context = (kind === "cut" ? { kind, productionId: "saltlight" }
        : { kind, productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12" }) as WorldChatContext;
      for (const budget of [1_000, 10_000_000]) {
        const guide = renderActionGuide(actionGuideScopes(context), budget, context).text;
        assert.equal([...guide.matchAll(/^- ([a-z-]+) ·/gm)][0]?.[1], expected[index]);
        assert.match(guide, /^- canon ·/m);
        assert.match(guide, /get_timeline.*complete=true/);
      }
      assert.match(describeEntryContext(context, bundle), new RegExp(`This is the ${kind} workspace`));
    }
  });

  it("carries current outcomes and ids while bounding history and excluding private receipt prose", async () => {
    const bundle = await fixtureBundle();
    const actions = Array.from({ length: 80 }, () => ConversationActionCardSchema.parse({
      ...receiptBinding(newId("cv"), bundle.meta.worldId), status: "completed", availableDecisions: [],
      receipt: { kind: "take", id: newId("tk"), summary: "C:/private/receipt and a secret prompt" },
    }));
    const input = { actions, candidates: [], messages: [], tombstones: [], currentUserMessage: "What did we make?", currentUserMessageId: newId("msg") };
    const context = assembleContext(input);
    assert.match(context.actionReceipts, new RegExp(actions.at(-1)!.receipt!.id));
    assert.match(context.actionReceipts, /"status":"completed"/);
    assert.match(context.actionReceipts, /omitted/);
    assert.ok(context.actionReceipts.length <= 12_000);
    assert.doesNotMatch(context.actionReceipts, /private|secret|Private prompt/);
    const changed = structuredClone(actions); changed.at(-1)!.status = "stale";
    assert.notEqual(assembleContext({ ...input, actions: changed }).digest, context.digest);
    const tiny = assembleContext({ ...input, budgetChars: 100 });
    assert.equal(tiny.actionReceipts, "", "a tiny budget never cuts an identity into a partial JSON record");
  });

  it("pages retained editor history and refuses a cursor after a status change", async () => {
    const bundle = await fixtureBundle(), production = bundle.productions.find(p => p.meta.id === "saltlight")!;
    production.editorRequests = [0, 1].map(i => EditorRequestSchema.parse({ id: `req_${ulid()}`, productionId: "saltlight", conversationId: newId("cv"), createdAt: "2026-10-04T00:00:00Z",
      summary: `Request ${i}`, status: "pending", baseRevision: 0, sourceFingerprint: `story-picture-v1:${"a".repeat(16)}`, commands: [{kind:"set-mix", mix:{speechFirst:true}}] }));
    const lease = new QueryLeaseRegistry(() => bundle.meta.worldId).mint({ worldId: bundle.meta.worldId, conversationId: newId("cv"), runId: newId("run") });
    const reads = new WorldChatTargetReads({ getAudioRights: async () => [] });
    const first = await reads.call(lease, bundle, "list_editor_requests", { productionId: "saltlight", limit: 1 });
    assert.equal(first.result.complete, false);
    const last = await reads.call(lease, bundle, "list_editor_requests", { productionId: "saltlight", limit: 1, cursor: first.result.nextCursor });
    assert.equal(last.result.complete, true);
    production.editorRequests[0]!.status = "rejected";
    await assert.rejects(reads.call(lease, bundle, "list_editor_requests", { productionId: "saltlight", cursor: first.result.nextCursor }), /changed/);
    for (const tool of ["list_performances", "get_audio_cut"] as const) {
      const read = await reads.call(lease, bundle, tool, { productionId: "saltlight" });
      assert.equal(read.result.complete, true);
      assert.equal((await reads.call(lease, bundle, tool, { productionId: "missing" })).result.total, 0);
    }
    const samples = await reads.call(lease, bundle, "list_voice_samples", {});
    assert.equal(samples.result.target.requirement, "voice-samples");
    await assert.rejects(reads.call(lease, bundle, "list_voice_samples", { path: "C:/other-world" }), /unexpected argument/);
  });

  it("reads durable frame runs after restart, omits provider inputs, and fences controls and job status", async () => {
    const world = await fixtureBundle(), production = world.productions.find(p => p.meta.id === "saltlight")!;
    const scene = production.scenes.find(s => s.id === "sc_04")!;
    const model: ManifestModel = { id: "read-image", provider: "fal", capability: "image", displayName: "Read image",
      accepts: { referenceImages: 8, startFrame: false, endFrame: false }, limits: { aspects: ["16:9"] }, pricing: { kind: "perImage", microUsdPerImage: 1000 } };
    const run = await compileFrameRun({ worldId: world.meta.worldId, productionId: "saltlight", production, world, scene, model,
      mode: "per-shot", scope: "all", boardCapSec: 10, eligible: true, clock: () => "2026-10-04T00:00:00Z" });
    const dir = await tempDir("arke-chat-frame-reads-");
    const recordDir = join(dir, "productions/saltlight/runs");
    await mkdir(recordDir, { recursive: true });
    const path = join(recordDir, `${run.id}.json`);
    await writeFile(path, JSON.stringify(run));
    const store = { dir, worldId: world.meta.worldId };
    const first = frameRunReadRows(store, "saltlight", []);
    assert.match(JSON.stringify(first), new RegExp(run.id));
    assert.doesNotMatch(JSON.stringify(first), /idempotencyKey|references|params|prompt/);
    assert.equal(first.length, run.steps.length + 1);
    const lease = new QueryLeaseRegistry(() => world.meta.worldId).mint({ worldId: world.meta.worldId, conversationId: newId("cv"), runId: newId("run") });
    const reads = new WorldChatTargetReads({ getFrameRunRows: id => frameRunReadRows(store, id, []) });
    const page = await reads.call(lease, world, "list_frame_runs", { productionId: "saltlight", limit: 1 });
    assert.equal(page.result.target.requirement, "frame-runs");
    assert.equal(page.result.complete, false);
    run.paused = true;
    await writeFile(path, JSON.stringify(run));
    assert.notEqual(productionReadFence(frameRunReadRows({ ...store }, "saltlight", [])), productionReadFence(first));
    await assert.rejects(reads.call(lease, world, "list_frame_runs", { productionId: "saltlight", cursor: page.result.nextCursor }), /changed/);
    run.steps[0]!.jobId = newId("jb");
    await writeFile(path, JSON.stringify(run));
    const jobs = [{ id: run.steps[0]!.jobId!, worldId: world.meta.worldId, productionId: "saltlight", status: "failed" as const }];
    assert.notEqual(productionReadFence(frameRunReadRows(store, "saltlight", jobs)), productionReadFence(frameRunReadRows(store, "saltlight", [])));
    const transient = [{ ...jobs[0]!, failureClass: "transient" as const }];
    const retryable = frameRunReadRows(store, "saltlight", transient);
    assert.match(JSON.stringify(retryable), /"canRetry":true/);
    assert.doesNotMatch(JSON.stringify(retryable), /"canRetryCell":true/, "a per-shot run retries its step, not a board cell");
    const terminal = [{ ...jobs[0]!, failureClass: "terminal" as const }];
    assert.doesNotMatch(JSON.stringify(frameRunReadRows(store, "saltlight", terminal)), /"canRetry":true/);
    assert.notEqual(productionReadFence(retryable), productionReadFence(frameRunReadRows(store, "saltlight", terminal)));
    await assert.rejects(async () => frameRunReadRows(store, "../elsewhere", []));
    await writeFile(path, "corrupt");
    assert.throws(() => frameRunReadRows(store, "saltlight", []), /JSON/);
  });

  it("reads current voice-sample rights, invalidates pages on withdrawal, and refuses damaged rights logs", async () => {
    const bundle = await fixtureBundle(), dir = await tempDir("arke-chat-sample-rights-");
    await mkdir(join(dir, "audio"));
    const at = "2026-10-04T00:00:00Z", bytes = wav([1000, -1000]), hash = audioHash(bytes), report = analyzePcmWav(bytes, at);
    const sample = { schemaVersion: 1 as const, file: `voice/${hash.replace(":", "-")}.wav`, operationId: "00000000-0000-4000-8000-000000000001", designatedAt: at,
      warningCodes: [], attestations: [], acknowledgementId: "sample-ack", provenance: { schemaVersion: 1 as const,
        source: { kind: "legacy-character-sample" as const, sheetId: "maren-kest", sourceFile: "voice/clone.wav", legacySource: "cloning-recording" as const,
          legacyDesignatedAt: at, sourceMediaHash: hash }, sourceTechnical: report.technical, outputHash: hash, outputTechnical: report.technical,
        preparation: [], qualityReport: report, createdAt: at } };
    bundle.referenceKits[0]!.designatedVoiceSample = sample;
    bundle.referenceKits.push({ ...bundle.referenceKits[0]!, sheetId: "other-speaker" });
    const ack: AudioRightsEvent = { schemaVersion: 1, action: "acknowledge", audioHash: hash, id: "sample-ack", basis: "self",
      scopes: ["cloud-reference-upload"], statementVersion: 1, at, performerRef: "private-performer" };
    const path = join(dir, "audio/rights.jsonl"), store = { dir };
    await writeFile(path, `${JSON.stringify(ack)}\n`);
    const lease = new QueryLeaseRegistry(() => bundle.meta.worldId).mint({ worldId: bundle.meta.worldId, conversationId: newId("cv"), runId: newId("run") });
    const reads = new WorldChatTargetReads({ getAudioRights: () => readAudioRights(store) });
    const first = await reads.call(lease, bundle, "list_voice_samples", { limit: 1 });
    assert.equal(first.result.complete, false);
    assert.match(JSON.stringify(first.result), /acknowledged/);
    assert.doesNotMatch(JSON.stringify(first.result), /private-performer/);
    const live = productionReadFence(voiceSampleReadRows(bundle, readAudioRightsSync(store)));
    const withdrawal: AudioRightsEvent = { schemaVersion: 1, action: "withdraw", acknowledgementId: ack.id, audioHash: hash, at };
    await writeFile(path, `${JSON.stringify(ack)}\n${JSON.stringify(withdrawal)}\n`);
    await assert.rejects(reads.call(lease, bundle, "list_voice_samples", { cursor: first.result.nextCursor }), /changed/);
    const withdrawn = await reads.call(lease, bundle, "list_voice_samples", {});
    assert.match(JSON.stringify(withdrawn.result), /withdrawn/);
    assert.notEqual(productionReadFence(voiceSampleReadRows(bundle, readAudioRightsSync(store))), live);
    assert.deepEqual(readAudioRightsSync(store), await readAudioRights(store));
    await writeFile(path, `${JSON.stringify(ack)}\n{"action":"withdraw"`);
    await assert.rejects(reads.call(lease, bundle, "list_voice_samples", {}), /rights-unavailable/);
    assert.throws(() => readAudioRightsSync(store), /rights-unavailable/);
    await assert.rejects(new WorldChatTargetReads().call(lease, bundle, "list_voice_samples", {}), /unavailable/);
  });
});
