import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFile } from "node:fs/promises";
import { ulid, deriveRehearsalLines, orderedShots, type Job, type ProviderStatus } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { audioWorldPath } from "../../src/audio/storage.js";
import { planTableRead, finalizeTableReadCache } from "../../src/audio/table-read.js";
import { cachedVoiceAudioLooksRight } from "../../src/voice/service.js";
import { SHIPPED_MANIFEST } from "../../../providers/src/manifest-data.js";
import { makeTempWorld } from "../world/helpers.js";
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
 * A visual novel voices every line the reader hears (turn 172): its narration is read in the
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

  const film = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers, narrator);
  assert.equal(film.plan.items.some(i => i.narration), false, "a film's table read is the characters' lines alone");

  production.meta = { ...production.meta, medium: "video", kind: "visual-novel" };
  const novel = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers, narrator);
  const item = novel.plan.items.find(i => i.narration)!;
  assert.ok(item, "the narration is planned");
  assert.equal(item.shotId, shot.id);
  assert.equal(item.speakerSheetId, undefined);
  assert.equal(item.route, "cloud");
  assert.equal(item.voiceId, "narrator-voice");
  const job = novel.cloud.find(input => input.target.id === item.lineId)!;
  assert.equal(job.params.tableReadNarration, true);
  assert.deepEqual(job.params.tableReadVoiceAssignment, narrator, "the quote binds the narrator it was made for");

  const none = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers, null);
  assert.match(none.plan.items.find(i => i.narration)!.reason!, /narrator voice/, "no narrator is said, not guessed");
});
