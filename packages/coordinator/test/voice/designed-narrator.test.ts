import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { designedVoiceTarget, narratorDesignedRecord, type ClientMessage, type DomainEvent, type WorldDesignedVoice } from "@arke-studio/contracts";
import { GoogleClient, SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { readAudiobookBook } from "../../src/productions/audiobook.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { until } from "../wait.js";

/**
 * A designed Gemini voice as the app narrator, in a world that does not hold it (2026-10-02).
 * The narrator was chosen in another world — `Ife's voice`, saved in that world's library — and
 * every other world read in George without a word, because each catalogue is built from the
 * open world's designed voices. The choice now keeps the voice's identity and binding (SPEC-049
 * R-12), every narration path resolves the copy where the world lacks the voice, synthesis binds
 * the remote id, and a fallback that still happens is one the screens name.
 */
const model = SHIPPED_MANIFEST.models.find((row) => row.id === "gemini-3.8-flash-tts")!;
const REQUEST = "01J8F3K2QW9VZX4N7M0RTYB6D1";
const AGAIN = "01J8F3K2QW9VZX4N7M0RTYB6D2";
const IFE: WorldDesignedVoice = {
  kind: "designed", id: "dv_01M3WMVV9W7J85PPRYQJ0YB26G", revision: 1, name: "Ife's voice", description: "Warm, unhurried Lagos storyteller.",
  language: "en-NG", provider: "google", model: "gemini-3.8-flash-tts", remoteId: "voice_mall1uvc7rp3",
  expiresAt: "2099-10-01T00:00:00Z", created: "2026-10-01T00:00:00Z", origin: "generated", sample: "voices/dv_01M3WMVV9W7J85PPRYQJ0YB26G.wav",
};
const TARGET = designedVoiceTarget(IFE);
const CHOICE = { provider: "google", model: model.id, voiceId: TARGET, label: "Ife's voice" };

function wav(): Buffer {
  const b = Buffer.alloc(48);
  b.write("RIFF"); b.writeUInt32LE(40, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(4, 40);
  return b;
}
const usage = { input_tokens_by_modality: [{ modality: "text", tokens: 20 }], output_tokens_by_modality: [{ modality: "audio", tokens: 100 }] };
const remote = () => ({ id: IFE.remoteId, type: "prompted", model: model.id, display_name: IFE.name, prompted: { input: IFE.description },
  language_code: IFE.language, expire_time: IFE.expiresAt, sample_audio: { mime_type: "audio/wav", data: wav().toString("base64") }, usage });

type Audio = Extract<DomainEvent, { type: "voice.audio" }>;

async function harness(options: { worldHoldsTheVoice?: boolean } = {}) {
  const { root, worldDir } = await makeTempRoot();
  if (options.worldHoldsTheVoice) {
    await mkdir(join(worldDir, "voices"), { recursive: true });
    await writeFile(join(worldDir, IFE.sample), wav());
    await writeFile(join(worldDir, "voices", "voices.json"), JSON.stringify({ voices: [IFE] }));
  }
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const spokenWith: unknown[] = [];
  const bodies: string[] = [];
  const google = new GoogleClient(async (url, init) => {
    if (init?.body !== undefined) bodies.push(String(init.body));
    if (String(url).endsWith(`/voices/${IFE.remoteId}`)) return Response.json(remote());
    if (String(url).endsWith("/interactions")) {
      const body = JSON.parse(String(init?.body));
      spokenWith.push(body.generation_config.speech_config[0].voice);
      return Response.json({ id: `speech-${spokenWith.length}`, model: body.model, status: "completed", usage,
        steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: wav().toString("base64") }] }] });
    }
    throw new Error(`Unexpected fixture request ${url}`);
  });
  const spoken: string[] = [];
  const coordinator = new Coordinator({
    provider, adapter: null, appRoot: root, cipher: devCipher(), credentialsFileName: "credentials.dev.dat",
    dispatchClients: { google }, manifest: SHIPPED_MANIFEST, appVersion: "test", changeLogPath: join(root, "logs", "changes.jsonl"),
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async (input: { voiceId: string; text: string }) => { spoken.push(input.text); return new Uint8Array(wav()); },
        transcribe: async () => ({ text: "" }),
      } as never,
      localPresets: [],
      cloudSources: [],
    },
    observeEvent: (event) => events.push(event),
  });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  await coordinator.start(0);
  await send({ kind: "set-credential", provider: "google", key: "fixture-key" });
  const settings = (coordinator as unknown as { appSettings: { setNarrator(voice: unknown): Promise<unknown>; load(): Promise<{ narrator: unknown }> } }).appSettings;
  const audio = (requestId: string) => events.filter((event): event is Audio => event.type === "voice.audio" && event.requestId === requestId);
  const read = (requestId: string, confirmationToken?: string) =>
    send({ kind: "read-sheet-section", requestId, worldId: WORLD_ID, sheetId: "maren-kest", sectionHeading: "Essence", ...(confirmationToken ? { confirmationToken } : {}) });
  const close = async () => { await coordinator.stop(); await provider.close(); };
  const store = () => provider.openStore()!;
  return { events, send, settings, audio, read, spoken, spokenWith, bodies, store, close };
}

describe("a designed narrator in a world that does not hold it", () => {
  it("narrates there: listed for the narrator only, priced in its own voice, and read with its remote binding", async () => {
    const h = await harness();
    try {
      // Chosen in another world: the choice carries the voice's identity and binding.
      await h.settings.setNarrator({ ...CHOICE, designed: narratorDesignedRecord(IFE) });
      await h.send({ kind: "voice-catalogue", worldId: WORLD_ID });
      const listed = h.events.findLast((event) => event.type === "voice.catalogue");
      assert.ok(listed && listed.type === "voice.catalogue");
      const row = listed.voices.find((voice) => voice.voiceId === TARGET && voice.model === model.id);
      assert.ok(row, "the narrator picker sees the voice that narrates here");
      assert.equal(row.unavailableReason, undefined);
      assert.equal(row.narratorCopy, true, "marked, so nothing but the narrator is given it");

      await h.read(REQUEST);
      const priced = h.audio(REQUEST).find((event) => event.status === "confirmation-required");
      assert.ok(priced, `a cloud read is priced: ${JSON.stringify(h.audio(REQUEST).map((event) => [event.status, event.provider, event.error]))}`);
      assert.equal(priced.provider, "google");
      assert.equal(priced.voiceId, TARGET, "in Ife's voice, not George's");
      await h.read(REQUEST, priced.confirmationToken);
      await until(() => h.audio(REQUEST).some((event) => event.status === "ready" || event.status === "failed"), "the read to land", 60_000);
      const ready = h.audio(REQUEST).find((event) => event.status === "ready");
      assert.ok(ready, `read, not refused: ${JSON.stringify(h.audio(REQUEST).map((event) => [event.status, event.error]))}`);
      assert.deepEqual(h.spokenWith, [IFE.remoteId], "synthesis bound the remote voice from the kept copy");
      assert.equal(h.spoken.length, 0, "and nothing was read in George");
      // The binding rides on the job it admitted, so dispatch reads the voice the read was
      // priced in rather than whatever the app narrator is by then — and it never reaches Google.
      const job = h.events.findLast((event) => event.type === "job.updated" && event.job.params["requestId"] === REQUEST);
      assert.ok(job && job.type === "job.updated");
      assert.deepEqual(job.job.params["designedBinding"], { remoteId: IFE.remoteId, expiresAt: IFE.expiresAt });
      assert.equal(h.bodies.some((body) => body.includes("designedBinding")), false);
      // Never previewed from the catalogue: a preview job is no narration and carries no binding.
      assert.equal(row.preview?.kind, "unavailable");
      // And never a book's narrator: a book is written into the world, which lacks the record.
      await h.send({ kind: "set-audiobook-narrator", worldId: WORLD_ID, productionId: "the-ledger-of-nights", voice: CHOICE });
      const book = await readAudiobookBook(h.store(), "the-ledger-of-nights");
      assert.ok(book === null || book === "unreadable" || book.narrator === undefined, "the book keeps its own narrator, or none");
    } finally {
      await h.close();
    }
  });

  it("falls back only when the voice cannot read, and then reads in George", async () => {
    const h = await harness();
    try {
      // An expired binding: the catalogue marks it, and the narrator falls to the shipped voice
      // (the screens name the fallback through `narratorLabelFor`).
      await h.settings.setNarrator({ ...CHOICE, designed: { ...narratorDesignedRecord(IFE), expiresAt: "2026-01-01T00:00:00Z" } });
      await h.read(AGAIN);
      const ready = h.audio(AGAIN).filter((event) => event.status === "ready");
      assert.ok(ready.length > 0 && ready.every((event) => event.provider === "kokoro" && event.voiceId === "bm_george"), JSON.stringify(h.audio(AGAIN).map((event) => [event.status, event.provider, event.error])));
      assert.deepEqual(h.spokenWith, []);
    } finally {
      await h.close();
    }
  });
});

describe("choosing a designed narrator where the world holds it", () => {
  it("keeps the voice's identity and binding with the choice, never its sample path, and ignores a record the client sends", async () => {
    const h = await harness({ worldHoldsTheVoice: true });
    try {
      await h.send({ kind: "set-narrator", voice: { ...CHOICE, designed: { ...narratorDesignedRecord(IFE), remoteId: "voice_forged" } } });
      const changed = h.events.findLast((event) => event.type === "narrator.changed");
      assert.ok(changed && changed.type === "narrator.changed");
      assert.deepEqual(changed.voice?.designed, narratorDesignedRecord(IFE), "the world's record, not the client's");
      assert.equal(JSON.stringify(changed.voice).includes("voices/"), false, "the sample is the world's");
    } finally {
      await h.close();
    }
  });

  it("gives a narrator chosen before this change its copy the first time a read resolves it there", async () => {
    const h = await harness({ worldHoldsTheVoice: true });
    try {
      await h.settings.setNarrator(CHOICE);
      await h.read(REQUEST);
      const changed = h.events.findLast((event) => event.type === "narrator.changed");
      assert.ok(changed && changed.type === "narrator.changed", "the kept copy is written and announced");
      assert.equal(changed.voice?.designed?.remoteId, IFE.remoteId);
      assert.equal(((await h.settings.load()).narrator as { designed?: { remoteId: string } }).designed?.remoteId, IFE.remoteId);
    } finally {
      await h.close();
    }
  });
});
