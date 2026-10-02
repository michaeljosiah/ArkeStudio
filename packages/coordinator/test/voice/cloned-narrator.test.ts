import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent, ManifestModel, VoiceCandidate } from "@arke-studio/contracts";
import { until } from "../wait.js";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { CataloguePreviewService } from "../../src/voice/catalogue-preview.js";
import { authoritativeSheetSpeech } from "../../src/voice/service.js";
import { toExtendedLength } from "../../src/world/paths.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { FakeProvider } from "../queue/fake-provider.js";
import { tempDir } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * A cloned voice as the app's narrator (issue 1215; SPEC-046 §1.12). Through the coordinator: the
 * library's Harbour glass read through Voxtral narrates a sheet section — the vendor's question
 * before the price, the recording with the job, the answer remembered on the voice — and falls to
 * the shipped local voice when its recording is gone, as a stored narrator whose key is gone does.
 */
const CLOCK = "2026-10-02T12:00:00.000Z";
const REQUEST = "01J8F3K2QW9VZX4N7M0RTYB6N1";
const AGAIN = "01J8F3K2QW9VZX4N7M0RTYB6N2";
const PAGE = "01J8F3K2QW9VZX4N7M0RTYB6N3";
const ELSEWHERE = "01J8F3K2QW9VZX4N7M0RTYB6B2";
const VOXTRAL: ManifestModel = {
  id: "voxtral-mini-tts",
  provider: "mistral",
  capability: "voice-tts",
  displayName: "Voxtral TTS",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 5000, audioFormat: "wav" },
  pricing: { kind: "perCharacter", microUsdPerCharacter: 16 },
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
  requests: Array<{ text: unknown; language: unknown; clipHash: unknown; reference: Uint8Array | null }> = [];
  override async submit(key: string, request: Parameters<FakeProvider["submit"]>[1]): ReturnType<FakeProvider["submit"]> {
    this.requests.push({ text: request.params["text"], language: request.params["language"], clipHash: request.params["voiceClipHash"], reference: request.voiceReference?.data ?? null });
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
    manifest: { manifestVersion: 1, generated: "2026-10-02", models: [VOXTRAL] },
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
  const library = async () => (JSON.parse(await readFile(join(worldDir, "voices", "voices.json"), "utf8")) as { voices: Array<{ remote?: Record<string, { confirmedAt?: string }> }> }).voices[0];
  const forgetClip = () => unlink(toExtendedLength(join(worldDir, "voices", "harbour-glass.wav")));
  const reRecord = (bytes: Uint8Array) => writeFile(toExtendedLength(join(worldDir, "voices", "harbour-glass.wav")), bytes);
  // The settings file the coordinator reads, for a choice made as if in another world.
  const settings = (coordinator as unknown as { appSettings: { setNarrator(voice: unknown): Promise<unknown> } }).appSettings;
  // A harness that started the coordinator stops it: closing only the provider leaves the
  // transport listening and the file hangs past every timeout.
  const close = () => coordinator.stop();
  return { events, reader, spoken, send, essence, audio, asked, library, forgetClip, reRecord, settings, close };
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
      assert.deepEqual(changed.voice, { ...HARBOUR, worldId: WORLD_ID }, "a cloned choice records its world (SPEC-046 R-37)");

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
      assert.equal(typeof (await h.library())?.remote?.["mistral"]?.confirmedAt, "string", "the answer is written onto the voice");
      const priced = h.audio(REQUEST).find((event) => event.status === "confirmation-required");
      assert.ok(priced, "then the price, as any cloud read's");
      assert.equal(priced.provider, "mistral");
      assert.equal(priced.voiceId, "harbour-glass");
      assert.equal(priced.estimatedMicroUsd, h.essence.length * 16);
      assert.equal(priced.voiceReference, true, "and the quote says the recording goes with the words");
      assert.equal(priced.notices, undefined, "Mistral keeps no slot, so a first read adds nothing to say");
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
      assert.equal(h.audio(REQUEST).find((event) => event.status === "ready")?.voiceId, "harbour-glass");

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

  it("reads a page the same way, and the page's quote says the recording goes", async () => {
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
      assert.ok(h.reader.requests.length >= 2 && h.reader.requests.every((request) => request.reference !== null), "every block's job carried the recording");
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
      const ready = h.audio(REQUEST).filter((event) => event.status === "ready");
      assert.ok(ready.length > 0, `read, not refused: ${JSON.stringify(h.audio(REQUEST).map((event) => [event.status, event.error]))}`);
      assert.ok(ready.every((event) => event.provider === "kokoro" && event.voiceId === "bm_george"), "the default, as a stored narrator whose key is gone falls to it");
      // A local read arrives in the engine's chunks: the first is a prefix of the section.
      assert.ok(h.spoken.length > 0 && h.essence.startsWith(h.spoken[0]!), "and made on this machine");
      assert.equal(h.reader.requests.length, 0);
    } finally {
      await h.close();
    }
  });

  it("is its own world's: the same id chosen in another world is not this recording, and the default reads", async () => {
    const h = await harness();
    try {
      // A choice made in another world — the same minted id, somebody else's recording there.
      await h.settings.setNarrator({ ...HARBOUR, worldId: ELSEWHERE });
      await readSection(h.send, REQUEST);
      assert.equal(h.asked(REQUEST).length, 0, "this world's Harbour glass is not asked for, because it was not chosen");
      const ready = h.audio(REQUEST).filter((event) => event.status === "ready");
      assert.ok(ready.length > 0 && ready.every((event) => event.voiceId === "bm_george"), "the default reads here");
      assert.equal(h.reader.requests.length, 0, "and no recording left the machine");
    } finally {
      await h.close();
    }
  });

  it("keys its cache on the recording: re-record the voice and the same words are made again, not replayed", async () => {
    const h = await harness();
    try {
      await h.send({ kind: "set-narrator", voice: HARBOUR });
      await readSection(h.send, REQUEST);
      const [question] = h.asked(REQUEST);
      await readSection(h.send, REQUEST, { voiceUploadConfirmedFor: question!.confirmationToken });
      const priced = h.audio(REQUEST).find((event) => event.status === "confirmation-required")!;
      await readSection(h.send, REQUEST, { confirmationToken: priced.confirmationToken });
      await until(() => h.audio(REQUEST).some((event) => event.status === "ready"), "the first read to land", PATIENCE);
      const first = h.audio(REQUEST).find((event) => event.status === "ready")!.file;

      // The voice is re-recorded under the same entry: the old speech is another recording's.
      await h.reRecord(wav(99, 16));
      h.events.length = 0;
      await readSection(h.send, AGAIN);
      const again = h.audio(AGAIN).find((event) => event.status === "confirmation-required");
      assert.ok(again, `the same words are priced again rather than replayed: ${JSON.stringify(h.audio(AGAIN).map((event) => [event.status, event.cached]))}`);
      assert.equal(h.asked(AGAIN).length, 0, "the vendor's answer stands — it was given for the voice, not the recording");
      await readSection(h.send, AGAIN, { confirmationToken: again.confirmationToken });
      await until(() => h.audio(AGAIN).some((event) => event.status === "ready"), "the second read to land", PATIENCE);
      assert.notEqual(h.audio(AGAIN).find((event) => event.status === "ready")!.file, first, "under a key of its own");
      assert.deepEqual(h.reader.requests.at(-1)!.reference, wav(99, 16), "made from the new recording");
    } finally {
      await h.close();
    }
  });

  it("is listed as unable to speak when its recording is gone, so the picker offers nothing set-narrator would refuse", async () => {
    const h = await harness();
    try {
      await h.forgetClip();
      await h.send({ kind: "voice-catalogue", worldId: WORLD_ID });
      const listed = h.events.find((event) => event.type === "voice.catalogue");
      assert.ok(listed && listed.type === "voice.catalogue");
      const rows = listed.voices.filter((voice) => voice.readsClone === "harbour-glass");
      assert.equal(rows.length, 1, "the voice is still listed, as an assignment to it stays visible");
      assert.equal(rows[0]!.unavailableReason, "recording missing — re-clone it");
      assert.equal(rows[0]!.preview?.kind, "unavailable", "and never previewed from the catalogue");
      assert.ok(listed.voices.some((voice) => voice.voiceId === PAUL.voiceId && voice.unavailableReason === undefined), "a preset is untouched");
      await h.send({ kind: "set-narrator", voice: HARBOUR });
      assert.equal(h.events.filter((event) => event.type === "narrator.changed").length, 0, "a clone with no recording to send is not chosen, as it could not be assigned");
    } finally {
      await h.close();
    }
  });

  it("cannot be deleted from the library while it narrates, as a voice a sheet reads with cannot (SPEC-046 R-41)", async () => {
    const h = await harness();
    try {
      await h.send({ kind: "set-narrator", voice: HARBOUR });
      await h.send({ kind: "delete-voice", requestId: REQUEST, worldId: WORLD_ID, voiceId: "harbour-glass" });
      const answer = h.events.find((event) => event.type === "voice.deleted");
      assert.ok(answer && answer.type === "voice.deleted");
      assert.equal(answer.status, "refused");
      assert.match(answer.reason ?? "", /narrator still reads with this voice/);
      assert.ok((await h.library()) !== undefined, "the entry stays");
      // Chosen elsewhere, the voice is not this world's narrator and goes.
      await h.settings.setNarrator({ ...HARBOUR, worldId: ELSEWHERE });
      await h.send({ kind: "delete-voice", requestId: AGAIN, worldId: WORLD_ID, voiceId: "harbour-glass" });
      const gone = h.events.filter((event) => event.type === "voice.deleted").at(-1);
      assert.equal(gone && gone.type === "voice.deleted" ? gone.status : null, "deleted");
    } finally {
      await h.close();
    }
  });

  it("ignores a world the client claims: set-narrator records the open world on a clone, and none on a preset", async () => {
    const h = await harness();
    try {
      await h.send({ kind: "set-narrator", voice: { ...HARBOUR, worldId: ELSEWHERE } });
      const cloned = h.events.filter((event) => event.type === "narrator.changed").at(-1);
      assert.ok(cloned && cloned.type === "narrator.changed");
      assert.equal(cloned.voice?.worldId, WORLD_ID);
      await h.send({ kind: "set-narrator", voice: { provider: PAUL.provider, model: PAUL.model, voiceId: PAUL.voiceId, label: PAUL.label, worldId: ELSEWHERE } });
      const preset = h.events.filter((event) => event.type === "narrator.changed").at(-1);
      assert.ok(preset && preset.type === "narrator.changed");
      assert.equal(preset.voice?.worldId, undefined, "a preset reads wherever its reader does");
    } finally {
      await h.close();
    }
  });
});

it("the voice browser never offers a catalogue preview of a library voice: that path sends no recording", async () => {
  const service = new CataloguePreviewService({ root: await tempDir("voice-browser-"), sidecar: null, manifest: { manifestVersion: 1, generated: "2026-10-02", models: [VOXTRAL] }, emit: () => {},
    enqueue: async () => { throw new Error("not reached"); } });
  const [preset, clone] = service.catalogue([PAUL, { ...PAUL, voiceId: "harbour-glass", label: "Harbour glass", readsClone: "harbour-glass" }]);
  assert.equal(preset?.preview?.kind, "generate");
  assert.equal(clone?.preview?.kind, "unavailable");
});
