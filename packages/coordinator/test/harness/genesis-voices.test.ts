import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GenesisBlueprintSchema, JobSchema, newId, ulid, jobOrigin, type Job, type VoiceCandidate, type ManifestModel } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
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
  await decideGenesisVoice(dir, draft, [], { target: "character:maren", decision: "unassign", requestId: ulid(), candidateId: candidate.id, hash: candidate.hash });
  assert.equal((await reviewedGenesisVoices(dir, draft, [], [])).selectedVoices, undefined);
  await writeFile(join(genesisControlDir(dir), candidate.file), "corrupt");
  await assert.rejects(decideGenesisVoice(dir, draft, [voice], { ...choice, requestId: ulid() }), /changed/);
  await generateLocalGenesisVoice(dir, plan, ulid(), async () => { calls++; return wav(); });
  assert.equal(calls, 2, "an explicit new request regenerates corrupt cached audio");
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
  assert.equal(jobOrigin(job), null, "a founding audition has no character-preview retry route");
  await assert.rejects(reviewedGenesisVoices(dir, draft, [job], [cloud]), /finish or cancel/);
});

it("disabled catalogue voices cannot produce a generation plan", async () => {
  const { dir, draft } = await setup();
  const review = await reviewGenesisVoices(dir, draft, [], [{ ...voice, unavailableReason: "This voice model is disabled in Settings." }], []);
  assert.equal(review.plans.length, 0);
  assert.match(review.problems.join(" "), /disabled/);
});

it("finalizes a queued audition without opening its chat and preserves it after job deletion", async () => {
  const { dir, draft, provider } = await setup();
  const plan = (await reviewGenesisVoices(dir, draft, [], [voice], [])).plans[0]!;
  const requestId = ulid();
  await mkdir(join(dir, "auditions"), { recursive: true });
  await writeFile(join(dir, "draft.json"), JSON.stringify({ name: "Harbour" }));
  const landed = "auditions/" + requestId + ".wav";
  await writeFile(join(dir, landed), wav());
  const now = new Date().toISOString();
  const job = JobSchema.parse({ ...genesisVoiceRequest("gen-voices", plan, requestId), id: newId("jb"),
    status: "succeeded", providerJobId: null, attempt: 1, error: null, createdAt: now, updatedAt: now, landedFiles: [landed] });
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(dir, "changes.jsonl"), appVersion: "test" });
  const finalizer = coordinator as unknown as { onJobTerminal(job: Job): Promise<void> };
  await finalizer.onJobTerminal(job);
  await finalizer.onJobTerminal(job);
  await rm(join(dir, landed));
  const review = await reviewGenesisVoices(dir, draft, [], [voice], []);
  assert.equal(review.candidates.filter(candidate => candidate.jobId === job.id).length, 1);
  assert.ok(await provider.serveGenesisMedia("gen-voices", review.candidates[0]!.file));
  await provider.close();
});
