import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { designedVoiceCandidates, designedVoiceTarget, quoteVoiceDesign, quoteSpeech, ulid,
  type ClientMessage, type DomainEvent, type Job } from "@arke-studio/contracts";
import { GoogleClient, SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { readAudiobookBook } from "../../src/productions/audiobook.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { until } from "../wait.js";

function wav() {
  const b = Buffer.alloc(48);
  b.write("RIFF"); b.writeUInt32LE(40, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(4, 40);
  return b;
}
const model = SHIPPED_MANIFEST.models.find(row => row.id === "gemini-3.8-flash-tts")!;
const usage = { input_tokens_by_modality: [{ modality: "text", tokens: 20 }], output_tokens_by_modality: [{ modality: "audio", tokens: 100 }] };
const remoteVoice = () => ({ id: "voice_fixture", type: "prompted", model: model.id, display_name: "Maren imagined",
  prompted: { input: "Low, patient, coastal British storyteller." }, language_code: "en-GB", expire_time: "2099-09-28T00:00:00Z",
  sample_audio: { mime_type: "audio/wav", data: wav().toString("base64") }, usage });

it("creates once, keeps a portable audition, assigns a character and a book, and replays a line without another call", async () => {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  let creations = 0, readings = 0;
  const keys: string[] = [];
  const google = new GoogleClient(async (url, init) => {
    keys.push(new Headers(init?.headers).get("x-goog-api-key")!);
    if (String(url).endsWith("/voices") && init?.method === "POST") {
      const rows = (await readFile(join(root, "queue", "jobs.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Job);
      assert.equal(rows.at(-1)!.status, "submitting", "intent is durable before paid I/O");
      creations++;
      return Response.json(remoteVoice());
    }
    if (String(url).endsWith("/voices/voice_fixture")) return Response.json(remoteVoice());
    if (String(url).endsWith("/interactions")) {
      readings++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.generation_config.speech_config[0].voice, "voice_fixture");
      return Response.json({ id: `speech-${readings}`, model: body.model, status: "completed", usage,
        steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: wav().toString("base64") }] }] });
    }
    throw new Error(`Unexpected fixture request ${url}`);
  });
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat", dispatchClients: { google }, manifest: SHIPPED_MANIFEST,
    voice: { sidecar: null, localPresets: [], cloudSources: [] }, appVersion: "test",
    changeLogPath: join(root, "logs", "changes.jsonl"), observeEvent: event => events.push(event) });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  const jobs = () => events.filter(event => event.type === "job.updated").map(event => event.job);
  await coordinator.start(0);
  try {
    await send({ kind: "set-credential", provider: "google", key: "fixture-key" });
    await send({ kind: "voice-catalogue", worldId: WORLD_ID });
    assert.equal(creations, 0);
    const draft = { model: "gemini-3.8-flash-tts" as const, name: "Maren imagined", description: "Low, patient, coastal British storyteller.", language: "en-GB" };
    await send({ kind: "design-voice", requestId: ulid(), worldId: WORLD_ID, draft, confirmedEstimateMicroUsd: 0 });
    assert.equal(creations, 0);
    const command = { kind: "design-voice" as const, requestId: ulid(), worldId: WORLD_ID, draft,
      confirmedEstimateMicroUsd: quoteVoiceDesign(model, draft.description).authorisedMicroUsd };
    await send(command);
    await send(command);
    await until(() => jobs().some(job => job.target.kind === "voice-design" && job.status === "succeeded"), "voice creation", 30000);
    assert.equal(creations, 1);
    const created = jobs().findLast(job => job.target.kind === "voice-design")!;
    assert.equal(created.speechQuote?.costBasis, "estimate");
    assert.equal(created.speechQuote?.tokenLimits, undefined);
    assert.deepEqual(created.speechUsage, { inputTextTokens: 20, outputAudioTokens: 100 });
    await send({ kind: "save-designed-voice", requestId: ulid(), worldId: WORLD_ID, jobId: created.id });
    const outcome = events.findLast(event => event.type === "voice.designed-saved")!;
    assert.equal(outcome.reason, null);
    assert.ok(outcome.voice);
    const voice = outcome.voice;
    assert.deepEqual(await readFile(join(worldDir, voice.sample)), wav());
    assert.equal(provider.openStore()!.getBundle().meta.schemaVersion, 42);
    assert.equal(provider.openStore()!.getBundle().clonedVoices.length, 0);
    await send({ kind: "save-designed-voice", requestId: ulid(), worldId: WORLD_ID, jobId: created.id });
    assert.equal(provider.openStore()!.getBundle().designedVoices?.length, 1);
    const target = { provider: "google", model: model.id, voiceId: designedVoiceTarget(voice), label: voice.name };
    await send({ kind: "assign-voice", requestId: ulid(), worldId: WORLD_ID, path: "characters/maren-kest.md", voice: target });
    assert.equal(events.findLast(event => event.type === "voice.assignment-result")?.status, "assigned");
    assert.equal(provider.openStore()!.getBundle().sheets.find(sheet => sheet.id === "maren-kest")!.voice?.voiceId, target.voiceId);
    await send({ kind: "set-audiobook-narrator", worldId: WORLD_ID, productionId: "the-ledger-of-nights", voice: target });
    const book = await readAudiobookBook(provider.openStore()!, "the-ledger-of-nights");
    assert.ok(book && book !== "unreadable");
    assert.deepEqual(book.narrator, target);
    assert.equal(readings, 0, "assignment does not synthesize");
    const audition = { kind: "hear-designed-voice" as const, requestId: ulid(), worldId: WORLD_ID, model: model.id,
      voiceId: target.voiceId, text: "The tide remembers.", confirmedSpeechMicroUsd: quoteSpeech(model, "The tide remembers.").expectedMicroUsd };
    await send(audition);
    await until(() => jobs().some(job => job.params.requestId === audition.requestId && job.status === "succeeded"), "audition", 30000);
    assert.equal(readings, 1);
    await send({ kind: "set-credential", provider: "google", key: "different-fixture-key" });
    const before = keys.length;
    await send({ ...audition, requestId: ulid() });
    assert.ok(events.some(event => event.type === "voice.design-audition"));
    assert.equal(keys.length, before, "cached replay needs no provider call, including verification");
    const liteRequest = ulid();
    await send({ ...audition, requestId: liteRequest, model: "gemini-3.8-flash-lite-tts", text: "A different tide." });
    await until(() => jobs().some(job => job.params.requestId === liteRequest && job.status === "succeeded"), "Lite audition with changed credential", 30000);
    assert.equal(readings, 2);
    assert.equal(keys.at(-1), "different-fixture-key");
    assert.equal(designedVoiceCandidates([voice]).length, 2);
    assert.ok(designedVoiceCandidates([voice], Date.parse(voice.expiresAt) + 1).every(candidate => candidate.unavailableReason));
  } finally { await coordinator.stop(); await provider.close(); }
});

it("lists the connected project's designed voices by name for the import, and says why when it cannot (design turn 204, issue 1635)", async () => {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const listed: string[] = [];
  const google = new GoogleClient(async (url) => {
    if (String(url).includes("/voices?")) {
      listed.push(String(url));
      const named = (id: string, name: string) => ({ ...remoteVoice(), id, display_name: name, sample_audio: undefined, usage: undefined });
      return Response.json({ voices: [named("voice_e9ki3cpkdhf0", "Nigerian Woman 2"), named("voice_fjwyh1zr45jr", "Nigerian Woman 1")] });
    }
    throw new Error(`Unexpected fixture request ${url}`);
  });
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat", dispatchClients: { google }, manifest: SHIPPED_MANIFEST,
    voice: { sidecar: null, localPresets: [], cloudSources: [] }, appVersion: "test",
    changeLogPath: join(root, "logs", "changes.jsonl"), observeEvent: event => events.push(event) });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  await coordinator.start(0);
  try {
    const before = ulid();
    await send({ kind: "list-designed-voices", requestId: before, worldId: WORLD_ID });
    const refused = events.findLast((event): event is Extract<DomainEvent, { type: "voice.designed-listed" }> => event.type === "voice.designed-listed")!;
    assert.equal(refused.requestId, before);
    assert.equal(refused.voices, null);
    assert.match(refused.reason ?? "", /Connect Google/, "with no key it says what to do, and asks Google nothing");
    assert.equal(listed.length, 0);
    await send({ kind: "set-credential", provider: "google", key: "fixture-key" });
    const requestId = ulid();
    await send({ kind: "list-designed-voices", requestId, worldId: WORLD_ID });
    const answer = events.findLast((event): event is Extract<DomainEvent, { type: "voice.designed-listed" }> => event.type === "voice.designed-listed")!;
    assert.equal(answer.requestId, requestId);
    assert.equal(answer.reason, null);
    assert.deepEqual(answer.voices?.map(voice => [voice.remoteId, voice.name]), [["voice_e9ki3cpkdhf0", "Nigerian Woman 2"], ["voice_fjwyh1zr45jr", "Nigerian Woman 1"]]);
    assert.match(listed[0]!, /type=prompted/, "the project's own voices, not Google's ready-made ones");
  } finally { await coordinator.stop(); await provider.close(); }
});
