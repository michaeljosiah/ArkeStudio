import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GenesisBlueprintSchema, JobSchema, newId, ulid, type VoiceCandidate, type ManifestModel } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { decideGenesisVoice, generateLocalGenesisVoice, reviewGenesisVoices, reviewedGenesisVoices, savedGenesisVoices, genesisVoiceRequest } from "../../src/harness/genesis-voices.js";
import { genesisControlDir } from "../../src/harness/genesis-conversation.js";

function wav(): Uint8Array {
  const out = Buffer.alloc(52);
  out.write("RIFF"); out.writeUInt32LE(44, 4); out.write("WAVE", 8); out.write("fmt ", 12);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24000, 24); out.writeUInt32LE(48000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(8, 40);
  return out;
}
const voice: VoiceCandidate = { provider: "kokoro", model: "kokoro-82m", voiceId: "af_heart", label: "Heart", attributes: [], local: true, canClone: false };
async function setup() {
  const provider = new FsWorldProvider(await tempDir("founding-voice-"));
  const dir = await provider.genesisDir("gen-voices");
  const draft = GenesisBlueprintSchema.parse({ name: "Harbour", characters: [{ slug: "maren", name: "Maren" }],
    voices: [{ id: "maren-voice", target: "character:maren", voice: { provider: voice.provider, model: voice.model, voiceId: voice.voiceId }, text: "The gate stays closed." }] });
  return { dir, draft, provider };
}
it("auditions once, plays immutable audio and selects separately across rename and resume", async () => {
  const { dir, draft, provider } = await setup();
  const plan = (await reviewGenesisVoices(dir, draft, [], [voice], [])).plans[0]!;
  let calls = 0; const requestId = ulid();
  await generateLocalGenesisVoice(dir, plan, requestId, async () => { calls++; return wav(); });
  await generateLocalGenesisVoice(dir, plan, requestId, async () => { calls++; return wav(); });
  assert.equal(calls, 1);
  const state = await savedGenesisVoices(dir);
  assert.equal(state.selections.length, 0);
  const candidate = state.candidates[0]!;
  assert.ok(await provider.serveGenesisMedia("gen-voices", candidate.file));
  await assert.rejects(decideGenesisVoice(dir, draft, [voice], { target: "character:other", decision: "approve", requestId: ulid(), candidateId: candidate.id, hash: candidate.hash }), /current audition/);
  await decideGenesisVoice(dir, draft, [voice], { target: "character:maren", decision: "reject", requestId: ulid(), candidateId: candidate.id, hash: candidate.hash });
  assert.equal((await savedGenesisVoices(dir)).selections.length, 0);
  const choice = { target: "character:maren", decision: "approve" as const, requestId: ulid(), candidateId: candidate.id, hash: candidate.hash };
  await decideGenesisVoice(dir, draft, [voice], choice);
  await decideGenesisVoice(dir, draft, [voice], choice);
  draft.characters[0]!.name = "Maren Kest";
  assert.equal((await reviewedGenesisVoices(dir, draft, [], [voice])).selectedVoices?.[0]?.plan.voice.voiceId, voice.voiceId);
  await assert.rejects(reviewedGenesisVoices(dir, draft, [], []), /unavailable/);
  await decideGenesisVoice(dir, draft, [], { target: "character:maren", decision: "unassign", requestId: ulid() });
  assert.equal((await reviewedGenesisVoices(dir, draft, [], [])).selectedVoices, undefined);
  await writeFile(join(genesisControlDir(dir), candidate.file), "corrupt");
  await assert.rejects(decideGenesisVoice(dir, draft, [voice], { ...choice, requestId: ulid() }), /changed/);
});
it("does not repeat an uncertain local audition and quotes queued previews before selection", async () => {
  const { dir, draft } = await setup();
  const plan = (await reviewGenesisVoices(dir, draft, [], [voice], [])).plans[0]!;
  const requestId = ulid(); let calls = 0;
  await assert.rejects(generateLocalGenesisVoice(dir, plan, requestId, async () => { calls++; throw new Error("interrupted"); }));
  await assert.rejects(generateLocalGenesisVoice(dir, plan, requestId, async () => { calls++; return wav(); }), /not be repeated/);
  assert.equal(calls, 1);
  const cloud = { ...voice, provider: "elevenlabs", model: "cloud-tts", local: false };
  draft.voices![0]!.voice = { provider: cloud.provider, model: cloud.model, voiceId: cloud.voiceId };
  const model: ManifestModel = { provider: "elevenlabs", id: cloud.model, capability: "voice-tts", displayName: "Cloud TTS",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perCharacter", microUsdPerCharacter: 10 } };
  const quoted = (await reviewGenesisVoices(dir, draft, [], [cloud], [model])).plans[0]!;
  assert.ok(quoted.estimatedMicroUsd > 0); assert.match(quoted.transfer, /sent to elevenlabs/);
  const request = genesisVoiceRequest("gen-voices", quoted, ulid());
  assert.equal(request.estimatedMicroUsd, quoted.estimatedMicroUsd);
  assert.equal(request.params["text"], quoted.text);
  const now = new Date().toISOString();
  const job = JobSchema.parse({ ...request, id: newId("jb"), status: "running", providerJobId: null, attempt: 1, error: null, createdAt: now, updatedAt: now });
  await assert.rejects(reviewedGenesisVoices(dir, draft, [job], [cloud]), /finish or cancel/);
});
