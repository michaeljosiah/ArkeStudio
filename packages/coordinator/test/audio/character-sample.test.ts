import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, ulid } from "@arke-studio/contracts";
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
  await assert.rejects(clearCharacterSample(store, "maren-kest", "stale"), /changed/);
  await withdrawCharacterSample(store, "maren-kest", sample.provenance.outputHash);
  await clearCharacterSample(store, "maren-kest", sample.provenance.outputHash);
  assert.equal((await readKit(store, "maren-kest"))!.kit.designatedVoiceSample, undefined);
  assert.deepEqual(await readFile(path), Buffer.from(bytes));
  assert.deepEqual(await readFile(join(dir, "artifacts/sample.wav")), Buffer.from(bytes));
});
