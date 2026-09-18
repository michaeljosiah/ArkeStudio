import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent, ManifestModel, VoiceCandidate } from "@arke-studio/contracts";
import { until } from "../wait.js";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { authoritativeSheetSpeech } from "../../src/voice/service.js";
import { toExtendedLength } from "../../src/world/paths.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { FakeProvider } from "../queue/fake-provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * A cloned voice as the app's narrator (issue 1215; SPEC-046 §1.12). Through the coordinator: the
 * library's Harbour glass read through Voxtral narrates a sheet section — the vendor's question
 * before the price, the recording with the job, the answer remembered on the voice — and falls to
 * the shipped local voice when its recording is gone, as a stored narrator whose key is gone does.
 * The recipe's row is still not offered, and `set-narrator` still refuses it.
 */
const CLOCK = "2026-09-18T12:00:00.000Z";
const REQUEST = "01J8F3K2QW9VZX4N7M0RTYB6N1";
const AGAIN = "01J8F3K2QW9VZX4N7M0RTYB6N2";
const PAGE = "01J8F3K2QW9VZX4N7M0RTYB6N3";
const VOXTRAL: ManifestModel = {
  id: "voxtral-mini-tts",
  provider: "mistral",
  capability: "voice-tts",
  displayName: "Voxtral TTS",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 5000, audioFormat: "wav" },
  pricing: { kind: "perCharacter", microUsdPerCharacter: 16 },
};
const KOKORO: ManifestModel = {
  id: "kokoro-82m",
  provider: "kokoro",
  capability: "voice-tts",
  displayName: "Kokoro",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { audioFormat: "wav" },
  pricing: { kind: "unmetered" },
};
const PAUL: VoiceCandidate = { provider: "mistral", model: VOXTRAL.id, voiceId: "en_paul_neutral", label: "Paul · neutral", attributes: [], local: false, canClone: false };
const HARBOUR = { provider: "mistral", model: VOXTRAL.id, voiceId: "harbour-glass", label: "Harbour glass" };

function wav(fill = 7, samples = 8): Uint8Array {
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24_000, 24);
  out.writeUInt32LE(48_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) out.writeInt16LE(fill, 44 + i * 2);
  return new Uint8Array(out);
}

type Audio = Extract<DomainEvent, { type: "voice.audio" }>;
type Asked = Extract<DomainEvent, { type: "voice.upload-confirmation-required" }>;

/** The fake reader keeps every request it was handed, recording included. */
class Reader extends FakeProvider {
  requests: Array<{ text: unknown; language: unknown; reference: Uint8Array | null }> = [];
  override async submit(key: string, request: Parameters<FakeProvider["submit"]>[1]): ReturnType<FakeProvider["submit"]> {
    this.requests.push({ text: request.params["text"], language: request.params["language"], reference: request.voiceReference?.data ?? null });
    const result = await super.submit(key, request);
    return { ...result, artifacts: [{ name: "speech.wav", contentType: "audio/wav", data: wav(3) }] };
  }
}

const CLIP = wav(64, 16);

async function harness() {
  const { root, worldDir } = await makeTempRoot();
  // The library's one voice, with its recording where the entry says it is.
  await mkdir(join(worldDir, "voices"), { recursive: true });
  await writeFile(join(worldDir, "voices", "harbour-glass.wav"), CLIP);
  await writeFile(
    join(worldDir, "voices", "voices.json"),
    JSON.stringify({ voices: [{ id: "harbour-glass", name: "Harbour glass", clip: "voices/harbour-glass.wav", description: "low, coastal", attributes: ["low", "coastal"], language: "en", consent: true, created: CLOCK }] }),
  );
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const reader = new Reader();
  const spoken: string[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-09-18", models: [VOXTRAL, KOKORO] },
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async (input: { voiceId: string; text: string }) => {
          spoken.push(input.text);
          return wav(1);
        },
        transcribe: async () => ({ text: "" }),
      } as never,
      localPresets: [],
      cloudSources: [{ provider: "mistral", list: async () => [PAUL] }],
      hostedReaders: [{ provider: "mistral", model: VOXTRAL.id }],
    },
    dispatchClients: { mistral: reader },
    observeEvent: (event) => events.push(event),
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  await coordinator.start(0);
  await send({ kind: "set-credential", provider: "mistral", key: "mistral-test-key" });
  const sheet = provider.openStore()?.getBundle().sheets.find((candidate) => candidate.id === "maren-kest");
  assert.ok(sheet);
  const essence = authoritativeSheetSpeech(sheet, "Essence").text;
  const audio = (requestId: string) => events.filter((event): event is Audio => event.type === "voice.audio" && event.requestId === requestId);
  const asked = (requestId: string) => events.filter((event): event is Asked => event.type === "voice.upload-confirmation-required" && event.requestId === requestId);
  const library = async () => (JSON.parse(await readFile(join(worldDir, "voices", "voices.json"), "utf8")) as { voices: Array<{ remote?: Record<string, { confirmedAt?: string }> }> }).voices[0]!;
  const forgetClip = () => unlink(toExtendedLength(join(worldDir, "voices", "harbour-glass.wav")));
  const close = () => coordinator.stop();
  return { events, reader, spoken, send, essence, audio, asked, library, forgetClip, close };
}

const readSection = (send: (message: ClientMessage) => Promise<void>, requestId: string, answers: { confirmationToken?: string; voiceUploadConfirmedFor?: string } = {}) =>
  send({ kind: "read-sheet-section", requestId, worldId: WORLD_ID, sheetId: "maren-kest", sectionHeading: "Essence", ...answers });

const PATIENCE = 60_000;

describe("a cloned voice as the narrator (issue 1215)", () => {
  it("is chosen through a hosted reader, asked about before the price, and read with its recording", async () => {
    const h = await harness();
    try {
      await h.send({ kind: "set-narrator", voice: HARBOUR });
      const changed = h.events.find((event) => event.type === "narrator.changed");
      assert.ok(changed && changed.type === "narrator.changed", "the library's voice through Voxtral is a narrator now");
      assert.deepEqual(changed.voice, { ...HARBOUR });

      await readSection(h.send, REQUEST);
      const question = h.asked(REQUEST);
      assert.equal(question.length, 1, "the vendor is asked once, by request");
      assert.equal(question[0]!.confirmationToken, "vendor:mistral:harbour-glass", "per voice and vendor");
      assert.match(question[0]!.destinationLabel, /^Mistral · Harbour glass$/);
      assert.ok(question[0]!.destinationNotice, "with what the vendor does with the clip");
      assert.equal(h.audio(REQUEST).length, 0, "and nothing is priced until it is answered");
      assert.equal(h.reader.requests.length, 0);

      await readSection(h.send, REQUEST, { voiceUploadConfirmedFor: question[0]!.confirmationToken });
      assert.equal(h.asked(REQUEST).length, 1, "answered, it is not asked again");
      assert.equal(typeof (await h.library()).remote?.["mistral"]?.confirmedAt, "string", "the answer is written onto the voice");
      const priced = h.audio(REQUEST).find((event) => event.status === "confirmation-required");
      assert.ok(priced, "then the price, as any cloud read's");
      assert.equal(priced.provider, "mistral");
      assert.equal(priced.voiceId, "harbour-glass");
      assert.equal(priced.estimatedMicroUsd, h.essence.length * 16);
      assert.equal(priced.voiceReference, true, "and the quote says the recording goes with the words");
      assert.equal(priced.notice, undefined, "Mistral keeps no slot, so a first read adds nothing to say");
      assert.equal(h.reader.requests.length, 0, "nothing leaves while the price is on the table");

      await readSection(h.send, REQUEST, { confirmationToken: priced.confirmationToken });
      await until(() => h.audio(REQUEST).some((event) => event.status === "ready"), "the read to land", PATIENCE);
      assert.equal(h.reader.requests.length, 1);
      const [request] = h.reader.requests;
      assert.equal(request!.text, h.essence);
      assert.equal(request!.language, "en", "the clone's language rides on the job for the reader's tag");
      assert.deepEqual(request!.reference, CLIP, "the recording reached the reader — a preset id it had never heard of would have been refused");
      const job = h.events.find((event) => event.type === "job.updated" && event.job.params["requestId"] === REQUEST);
      assert.ok(job && job.type === "job.updated");
      assert.equal(job.job.params["voiceReference"], true, "the marker the dispatcher resolves the recording by");
      const ready = h.audio(REQUEST).find((event) => event.status === "ready");
      assert.equal(ready?.voiceId, "harbour-glass");

      // The same words again: a cache hit, and nothing asked — no recording leaves for a read
      // the cache holds.
      h.events.length = 0;
      await readSection(h.send, AGAIN);
      assert.equal(h.asked(AGAIN).length, 0);
      assert.deepEqual(h.audio(AGAIN).map((event) => [event.status, event.cached]), [["ready", true]]);
    } finally {
      await h.close();
    }
  });

  it("reads a page the same way, and the page's confirmation says the recording goes", async () => {
    const h = await harness();
    try {
      await h.send({ kind: "set-narrator", voice: HARBOUR });
      const page = (answers: { confirmationToken?: string; voiceUploadConfirmedFor?: string } = {}) =>
        h.send({ kind: "read-sheet-page", requestId: PAGE, worldId: WORLD_ID, sheetId: "maren-kest", sections: ["Essence", "Appearance"], ...answers });
      await page();
      const [question] = h.asked(PAGE);
      assert.ok(question, "the vendor's question first");
      assert.equal(h.audio(PAGE).length, 0);
      await page({ voiceUploadConfirmedFor: question.confirmationToken });
      const priced = h.audio(PAGE).find((event) => event.status === "confirmation-required");
      assert.ok(priced);
      assert.equal(priced.voiceReference, true);
      await page({ confirmationToken: priced.confirmationToken });
      await until(() => h.audio(PAGE).filter((event) => event.status === "ready").length >= 2, "both blocks to land", PATIENCE);
      assert.ok(h.reader.requests.every((request) => request.reference !== null), "every block's job carried the recording");
    } finally {
      await h.close();
    }
  });

  it("falls to the shipped local voice when the recording is gone, rather than failing the read", async () => {
    const h = await harness();
    try {
      await h.send({ kind: "set-narrator", voice: HARBOUR });
      await h.forgetClip();
      await readSection(h.send, REQUEST);
      assert.equal(h.asked(REQUEST).length, 0, "nothing to send, nothing to ask");
      const [result] = h.audio(REQUEST);
      assert.equal(result?.status, "ready", "read, not refused");
      assert.equal(result?.provider, "kokoro");
      assert.equal(result?.voiceId, "bm_george", "the default, as a stored narrator whose key is gone falls to it");
      assert.ok(h.spoken.length > 0 && h.essence.startsWith(h.spoken[0]!), "and made on this machine, in the engine's chunks");
      assert.equal(h.reader.requests.length, 0);
    } finally {
      await h.close();
    }
  });

  it("is not the recipe's row: set-narrator still refuses the clone on this machine, and takes it through the reader only while its recording is there", async () => {
    const h = await harness();
    try {
      await h.send({ kind: "set-narrator", voice: { provider: "comfyui", model: "comfyui-cloned-voice", voiceId: "harbour-glass", label: "Harbour glass" } });
      assert.equal(h.events.filter((event) => event.type === "narrator.changed").length, 0, "flac has no join; the recipe stays out");
      await h.forgetClip();
      await h.send({ kind: "set-narrator", voice: HARBOUR });
      assert.equal(h.events.filter((event) => event.type === "narrator.changed").length, 0, "a clone with no recording to send is not chosen, as it could not be assigned");
    } finally {
      await h.close();
    }
  });
});
