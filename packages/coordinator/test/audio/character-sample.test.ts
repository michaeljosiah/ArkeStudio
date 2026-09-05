import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, ulid, orderedShots, planCharacterAudio, characterAudioInstructions } from "@arke-studio/contracts";
import { FAL_MODELS } from "../../../providers/src/fal-catalogue.generated.js";
import { FalClient } from "../../../providers/src/clients/fal.js";
import { readCharacterAudioInputs } from "../../src/audio/reference-inputs.js";
import { prepareCharacterSample, resumeCharacterSample, acceptCharacterSample, clearCharacterSample, withdrawCharacterSample } from "../../src/audio/character-sample.js";
import { createAudioMediaTools } from "../../src/audio/media-tools.js";
import { audioHash } from "../../src/audio/qc.js";
import { WorldStore } from "../../src/world/store.js";
import { readKit } from "../../src/references/kit.js";
import { makeTempWorld } from "../world/helpers.js";
import { wav } from "./helpers.js";

it("reviewed assignment survives reopen, leaves source and TTS intact, and clear retains historical audio", async t => {
  const dir = await makeTempWorld(), artifactId = newId("ar");
  const bytes = wav(Array.from({ length: 48000 }, (_, i) => Math.round(Math.sin(i / 10) * 3000)));
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await writeFile(join(dir, "artifacts/sample.wav"), bytes);
  await writeFile(join(dir, "artifacts/sample.wav.json"), JSON.stringify({ id: artifactId, kind: "audio", file: "sample.wav",
    hash: audioHash(bytes), origin: { by: "user" }, links: [], created: "2026-09-05T12:00:00Z" }));
  let store = await WorldStore.open(dir);
  t.after(() => store.close());
  const voice = store.getBundle().sheets.find(s => s.id === "maren-kest")!.voice;
  const tools = createAudioMediaTools({ async run(tool, args) {
    let stdout = "";
    if (tool === "ffprobe") stdout = JSON.stringify({ format: { duration: "1", format_name: "wav" }, streams: [{
      codec_type: "audio", codec_name: "pcm_s16le", sample_fmt: "s16", sample_rate: "48000", channels: 1, bits_per_sample: 16 }] });
    else if (args[0] === "-version") stdout = "ffmpeg version test\n";
    else await writeFile(args.at(-1)!, bytes);
    return { code: 0, stdout: Buffer.from(stdout), stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false };
  } });
  const review = await prepareCharacterSample(store, tools, { kind: "prepare-character-voice-sample", worldId: store.worldId,
    sheetId: "maren-kest", requestId: ulid(), source: { kind: "artifact", artifactId } });
  await store.close(); store = await WorldStore.open(dir);
  assert.deepEqual(await resumeCharacterSample(store, "maren-kest", review.operationId), review);
  const warnings = Object.values(review.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code);
  const accept = { kind: "accept-character-voice-sample" as const, worldId: store.worldId, sheetId: "maren-kest", requestId: ulid(),
    operationId: review.operationId, warningCodes: warnings, singleSpeaker: true, noMusic: true, rightsBasis: "self" as const };
  await assert.rejects(acceptCharacterSample(store, { ...accept, noMusic: false }), /one speaker and no music/);
  await acceptCharacterSample(store, accept);
  await acceptCharacterSample(store, accept); // Lost response does not create another acceptance.
  await store.close(); store = await WorldStore.open(dir);
  const sample = (await readKit(store, "maren-kest"))!.kit.designatedVoiceSample!;
  assert.ok("schemaVersion" in sample);
  assert.equal(sample.provenance.outputHash, audioHash(bytes));
  assert.deepEqual(store.getBundle().sheets.find(s => s.id === "maren-kest")!.voice, voice);
  const path = join(dir, "references/maren-kest", sample.file);
  assert.deepEqual(await readFile(path), Buffer.from(bytes));
  const bundle = store.getBundle(), scene = bundle.productions[0]!.scenes[0]!;
  const shot = { ...orderedShots(scene)[0]!, covers: undefined, audio: { kind: "dialogue", speaker: "maren-kest", line: "These are different scene words." } };
  const model = FAL_MODELS.find(m => m.id === "seedance-2.0")!;
  const audioPlan = planCharacterAudio({ scene, shots: [shot], sheets: bundle.sheets, kits: bundle.referenceKits, model, imageCount: 1 });
  assert.equal(audioPlan.problems.length, 0);
  assert.equal(audioPlan.references[0]!.sheetId, "maren-kest");
  const prompt = `${shot.audio.line}\n${characterAudioInstructions(audioPlan)}`;
  const job = { model: model.id, provider: model.provider, params: { audioReferences: audioPlan,
    references: ["references/maren-kest/head-front.png"], prompt, durationSec: 5 } };
  const audio = await readCharacterAudioInputs(store, job);
  assert.deepEqual(Buffer.from(audio[0]!.data), Buffer.from(bytes));
  let sent: { url: string; body: Record<string, unknown> } | undefined;
  const fal = new FalClient(async (url, init) => { sent = { url, body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ request_id: "verified-mock" }), { status: 200 }); });
  await fal.submit("mock", { ...job, capability: "video", audioReferences: audio,
    imageReferences: [{ name: "character.png", contentType: "image/png", data: new Uint8Array([1]) }] });
  assert.ok(sent!.url.endsWith("bytedance/seedance-2.0/reference-to-video"));
  assert.deepEqual(sent!.body.audio_urls, [`data:audio/wav;base64,${Buffer.from(bytes).toString("base64")}`]);
  assert.equal(sent!.body.generate_audio, true);
  assert.equal(sent!.body.prompt, prompt);
  assert.equal(sent!.body.audioReferences, undefined);
  const fastModel = FAL_MODELS.find(m => m.id === "seedance-2.0-fast")!;
  const fastPlan = planCharacterAudio({ scene, shots: [shot], sheets: bundle.sheets, kits: bundle.referenceKits, model: fastModel, imageCount: 1 });
  const fastJob = { ...job, model: fastModel.id, params: { ...job.params, audioReferences: fastPlan } };
  await fal.submit("mock", { ...fastJob, capability: "video", audioReferences: await readCharacterAudioInputs(store, fastJob),
    imageReferences: [{ name: "character.png", contentType: "image/png", data: new Uint8Array([1]) }] });
  assert.ok(sent!.url.endsWith("bytedance/seedance-2.0/fast/reference-to-video"));
  const tooManyImages = Array.from({ length: 10 }, () => "references/maren-kest/head-front.png");
  assert.match(planCharacterAudio({ scene, shots: [shot], sheets: bundle.sheets, kits: bundle.referenceKits,
    model, imageCount: 10 }).problems.join(" "), /budget/);
  await assert.rejects(readCharacterAudioInputs(store, { ...job, params: { ...job.params, references: tooManyImages } }), /budget/);
  await assert.rejects(fal.submit("mock", { ...job, params: { ...job.params, references: tooManyImages }, capability: "video", audioReferences: audio,
    imageReferences: tooManyImages.map(() => ({ name: "character.png", contentType: "image/png" as const, data: new Uint8Array([1]) })) }), /budget/);
  const unsupported = planCharacterAudio({ scene, shots: [shot], sheets: bundle.sheets, kits: bundle.referenceKits,
    model: { ...model, id: "unsupported" }, imageCount: 1 });
  assert.match(unsupported.problems.join(" "), /cannot carry/);
  const off = planCharacterAudio({ scene, shots: [shot], sheets: bundle.sheets, kits: bundle.referenceKits,
    model: { ...model, id: "unsupported" }, imageCount: 1, disabled: true });
  assert.equal(off.references.length, 0); assert.equal(off.problems.length, 0);
  const framed = planCharacterAudio({ scene, shots: [shot], sheets: bundle.sheets, kits: bundle.referenceKits,
    model, imageCount: 1, taskMode: "first-frame" });
  assert.match(framed.problems.join(" "), /cannot carry/);
  const missingSpeaker = planCharacterAudio({ scene, shots: [{ ...shot, audio: { kind: "dialogue", line: "Who speaks?" } }],
    sheets: bundle.sheets, kits: bundle.referenceKits, model, imageCount: 1 });
  assert.match(missingSpeaker.problems.join(" "), /Resolve the speaker/);
  await writeFile(path, wav([1]));
  await assert.rejects(readCharacterAudioInputs(store, job), /audio-source-changed/);
  await writeFile(path, bytes);
  await assert.rejects(clearCharacterSample(store, "maren-kest", "stale"), /changed/);
  await withdrawCharacterSample(store, "maren-kest", sample.provenance.outputHash);
  await assert.rejects(readCharacterAudioInputs(store, job), /audio-rights-required/);
  await clearCharacterSample(store, "maren-kest", sample.provenance.outputHash);
  assert.equal((await readKit(store, "maren-kest"))!.kit.designatedVoiceSample, undefined);
  assert.deepEqual(await readFile(path), Buffer.from(bytes));
  assert.deepEqual(await readFile(join(dir, "artifacts/sample.wav")), Buffer.from(bytes));
});
