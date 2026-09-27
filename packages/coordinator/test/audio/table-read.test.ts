import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFile } from "node:fs/promises";
import { ulid, deriveRehearsalLines, legacySceneView, orderedShots, type Job, type ProviderStatus } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { audioWorldPath } from "../../src/audio/storage.js";
import { planTableRead, finalizeTableReadCache } from "../../src/audio/table-read.js";
import { cachedVoiceAudioLooksRight } from "../../src/voice/service.js";
import { SHIPPED_MANIFEST } from "../../../providers/src/manifest-data.js";
import { makeTempWorld } from "../world/helpers.js";
import { applyVoiceAssignment } from "../../src/sheets/authoring.js";
it("validates a repeated table-read voice once per plan and checks again on confirmation", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const bundle = structuredClone(store.getBundle());
  const production = bundle.productions.find(p => p.scenes.some(s => deriveRehearsalLines(s, bundle.sheets).some(l => l.speakerSheetId === "maren-kest")))!;
  const source = legacySceneView(production.scenes.find(s => deriveRehearsalLines(s, bundle.sheets).some(l => l.speakerSheetId === "maren-kest"))!);
  const shot = source.shots.find(shot => shot.audio?.speaker === "maren-kest")!;
  const scene = { ...source, shots: Array.from({ length: 50 }, (_, index) => ({ ...shot, id: `sh_${100 + index}`, number: index + 1,
    audio: { ...shot.audio!, line: `A distinct line ${index}.` } })) };
  production.scenes = production.scenes.map(row => row.id === scene.id ? scene : row);
  bundle.sheets.find(sheet => sheet.id === "maren-kest")!.voice = { provider: "google", model: "gemini-3.8-flash-tts", voiceId: "Charon", assignedAtVersion: 4 };
  store.getBundle = () => bundle;
  const providers: ProviderStatus[] = [{ id: "google", configured: true, validation: "valid", fault: null, probes: [{ capability: "voice-tts", available: true }] }];
  let calls = 0;
  let problem: string | null = null;
  const check = async () => { calls++; return problem; };
  const first = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers, check);
  assert.equal(first.cloud.length, 50);
  assert.equal(calls, 1);
  problem = "The current key no longer has this reader.";
  const confirmed = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers, check);
  assert.equal(calls, 2, "each plan gets fresh reader availability");
  assert.equal(confirmed.cloud.length, 0);
  assert.ok(confirmed.plan.items.every(item => item.reason === problem));
});
it("Gemini table reads quote bounded WAV jobs, retain cached audio and refuse unavailable readers", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const bundle = store.getBundle();
  const production = bundle.productions.find(p => p.scenes.some(s => deriveRehearsalLines(s, bundle.sheets).some(l => l.speakerSheetId === "maren-kest")))!;
  const scene = production.scenes.find(s => deriveRehearsalLines(s, bundle.sheets).some(l => l.speakerSheetId === "maren-kest"))!;
  const sheet = bundle.sheets.find(s => s.id === "maren-kest")!;
  const providers: ProviderStatus[] = [{ id: "google", configured: true, validation: "valid", fault: null, probes: [{ capability: "voice-tts", available: true }] }];
  for (const model of SHIPPED_MANIFEST.models.filter(m => m.provider === "google" && m.capability === "voice-tts")) {
    await applyVoiceAssignment(store, { path: "characters/maren-kest.md", voice: { provider: "google", model: model.id, voiceId: "Charon" } });
    const first = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers);
    const input = first.cloud.find(job => job.params.tableReadSpeakerSheetId === sheet.id)!;
    assert.ok(input, model.id);
    assert.equal(input.model, model.id);
    assert.ok(input.estimatedMicroUsd > 0);
    assert.match(String(input.params.tableReadCacheFile), /\.wav$/);
    const unavailable = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers, async () => "Unavailable with the current key.");
    assert.equal(unavailable.cloud.length, 0);
    assert.match(unavailable.plan.items.find(item => item.lineId === input.target.id)!.reason!, /current key/);
    const tinyLimit = { ...SHIPPED_MANIFEST, models: SHIPPED_MANIFEST.models.map(row => row.id === model.id ? { ...row, limits: { ...row.limits, maxSpeechUtf8Bytes: 1 } } : row) };
    const oversized = await planTableRead(store, production.meta.id, scene.id, tinyLimit, [], providers);
    assert.equal(oversized.cloud.length, 0);
    assert.match(oversized.plan.items.find(item => item.lineId === input.target.id)!.reason!, /speech input limit/);
    const bytes = Buffer.alloc(52);
    bytes.write("RIFF"); bytes.writeUInt32LE(44, 4); bytes.write("WAVE", 8); bytes.write("fmt ", 12);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36); bytes.writeUInt32LE(8, 40);
    const file = String(input.params.tableReadCacheFile);
    await store.ownedWrite(async () => writeFile(await audioWorldPath(store.dir, file, true), bytes));
    await finalizeTableReadCache(store, { ...input, id: `jb_${ulid()}`, status: "succeeded", landedFiles: [file] } as Job);
    const cached = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], [], async () => "Turned off.");
    assert.equal(cached.plan.items.find(item => item.lineId === input.target.id)!.route, "cached");
  }
});
it("plans exact cache preparation, sees running work, and reuses verified cache without formal performance creation", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const production = store.getBundle().productions.find(p => p.scenes.some(s => deriveRehearsalLines(s, store.getBundle().sheets).some(l => l.speakerSheetId === "maren-kest")))!;
  const scene = production.scenes.find(s => deriveRehearsalLines(s, store.getBundle().sheets).some(l => l.speakerSheetId === "maren-kest"))!;
  const providers: ProviderStatus[] = [{ id: "elevenlabs", configured: true, validation: "valid", fault: null, probes: [{ capability: "voice-tts", available: true }] }];
  const first = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers);
  assert.ok(first.cloud.length > 0);
  assert.equal(first.plan.totalEstimatedMicroUsd, first.cloud.reduce((sum, input) => sum + String(input.params.text).length * 100, 0));
  const input = first.cloud[0]!;
  const queued = { ...input, id: `jb_${ulid()}`, status: "queued" } as Job;
  const running = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [queued], providers);
  assert.equal(running.plan.items.find(i => i.lineId === input.target.id)!.route, "generating");
  assert.notEqual(running.plan.confirmationToken, first.plan.confirmationToken);
  const failed = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [{ ...queued, status: "failed" }], providers);
  assert.notEqual(failed.cloud[0]!.idempotencyKey, input.idempotencyKey, "an explicit retry after failure receives a fresh spend key");
  const bytes = new Uint8Array(417 * 3);
  for (let offset = 0; offset < bytes.length; offset += 417) bytes.set([0xff, 0xfb, 0x90, 0x64], offset);
  assert.equal(cachedVoiceAudioLooksRight(bytes, "mp3"), true);
  const file = String(input.params.tableReadCacheFile);
  await store.ownedWrite(async () => writeFile(await audioWorldPath(store.dir, file, true), bytes));
  await finalizeTableReadCache(store, { ...queued, landedFiles: [file] });
  const cached = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], []);
  assert.equal(cached.plan.items.find(i => i.lineId === input.target.id)!.route, "cached", "cached playback remains available without a configured provider");
  assert.deepEqual(store.getBundle().productions.find(p => p.meta.id === production.meta.id)!.performances, []);
  assert.deepEqual(store.getBundle().productions.find(p => p.meta.id === production.meta.id)!.performanceReview.selections, {});
});

/**
 * A visual novel voices every line the reader hears (turn 174): its narration is read in the
 * narrator's voice and planned with the characters' lines, in beat order, and a film's table read
 * stays the characters' alone even when a narrator is passed.
 */
it("plans a visual novel's narration in the narrator's voice, and leaves a film's table read alone", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const production = store.getBundle().productions.find(p => p.scenes.some(s => orderedShots(s).length > 0))!;
  const scene = production.scenes.find(s => orderedShots(s).length > 0)!;
  const shot = orderedShots(scene)[0]!;
  // In memory only: the plan reads the bundle, and this is the shape a visual novel's scene has.
  scene.script = { blocks: [{ id: "blk_wash", kind: "action", text: "They hung the washing out the morning the water came." }] };
  shot.covers = [{ blockId: "blk_wash", textDigest: "sha256:12345678" }];
  const narrator = { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "narrator-voice" };
  const providers: ProviderStatus[] = [{ id: "elevenlabs", configured: true, validation: "valid", fault: null, probes: [{ capability: "voice-tts", available: true }] }];

  const film = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers, undefined, narrator);
  assert.equal(film.plan.items.some(i => i.narration), false, "a film's table read is the characters' lines alone");

  production.meta = { ...production.meta, medium: "video", kind: "visual-novel" };
  const novel = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers, undefined, narrator);
  const item = novel.plan.items.find(i => i.narration)!;
  assert.ok(item, "the narration is planned");
  assert.equal(item.shotId, shot.id);
  assert.equal(item.speakerSheetId, undefined);
  assert.equal(item.route, "cloud");
  assert.equal(item.voiceId, "narrator-voice");
  const job = novel.cloud.find(input => input.target.id === item.lineId)!;
  assert.equal(job.params.tableReadNarration, true);
  assert.deepEqual(job.params.tableReadVoiceAssignment, narrator, "the quote binds the narrator it was made for");

  const none = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers, undefined, null);
  assert.match(none.plan.items.find(i => i.narration)!.reason!, /narrator voice/, "no narrator is said, not guessed");

  // Any narrator the app lets narrate reads narration, in the format its model returns — the
  // audiobook's Mistral presets among them — but not a cloned reader, confirmed elsewhere.
  const mistral: ProviderStatus[] = [...providers, { id: "mistral", configured: true, validation: "valid" as const, fault: null, probes: [{ capability: "voice-tts" as const, available: true }] }];
  const voxtral = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], mistral, undefined, { provider: "mistral", model: "voxtral-mini-tts", voiceId: "preset-voice" });
  const read = voxtral.plan.items.find(i => i.narration)!;
  assert.equal(read.route, "cloud");
  assert.equal((voxtral.cloud.find(input => input.target.id === read.lineId)!.params.tableReadSpec as { format: string }).format, "wav");
  const cloned = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers, undefined, { provider: "comfyui", model: "x", voiceId: "clone" });
  assert.match(cloned.plan.items.find(i => i.narration)!.reason!, /narrator voice/);
});
