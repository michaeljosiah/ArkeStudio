import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent, ManifestModel, VoiceCandidate } from "@arke-studio/contracts";
import { ProviderRequestRejectedError } from "@arke-studio/providers";
import { until, untilAsync } from "../wait.js";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { piecesFor } from "../../src/voice/pieces.js";
import { authoritativeSheetSpeech, cachedVoiceAudioLooksRight, speechCacheFile, splitForSpeech } from "../../src/voice/service.js";
import { toExtendedLength } from "../../src/world/paths.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { FakeProvider } from "../queue/fake-provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * A read over the reader's cap is made in pieces rather than refused (issue 1208). Through the
 * coordinator: a hosted narrator whose row takes 220 characters a request, a sheet section of
 * about six hundred, and every path the pieces can take — heard as they land, joined for the
 * next read, one part of a page, and the block that cannot be made whole.
 */
const CLOCK = "2026-09-16T12:00:00.000Z";
const REQUEST = "01J8F3K2QW9VZX4N7M0RTYB6R1";
const AGAIN = "01J8F3K2QW9VZX4N7M0RTYB6R2";
const PAGE = "01J8F3K2QW9VZX4N7M0RTYB6R3";
const CAP = 220;
const VOXTRAL: ManifestModel = {
  id: "voxtral-mini-tts",
  provider: "mistral",
  capability: "voice-tts",
  displayName: "Voxtral TTS",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: CAP, audioFormat: "wav" },
  pricing: { kind: "perCharacter", microUsdPerCharacter: 16 },
};
const PAUL: VoiceCandidate = { provider: "mistral", model: VOXTRAL.id, voiceId: "en_paul_neutral", label: "Paul · neutral", attributes: [], local: false, canClone: false };

/** A wav whose samples all say one number, so a join can be checked for order. */
function wav(fill: number, samples = 8): Uint8Array {
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

/** The fake reader answers each piece with a wav numbered by the order of the words, and refuses the one piece a test names. */
class Reader extends FakeProvider {
  refuse: string | null = null;
  pieces: readonly string[] = [];
  /** Every request, the refused one included — `submitCount` counts only those the fake answered. */
  attempts = 0;
  override async submit(key: string, request: Parameters<FakeProvider["submit"]>[1]): ReturnType<FakeProvider["submit"]> {
    this.attempts += 1;
    const text = String(request.params["text"]);
    if (text === this.refuse) throw new ProviderRequestRejectedError("mistral: refused this line");
    this.inlineArtifacts = [{ name: "speech.wav", contentType: "audio/wav", data: wav(this.pieces.indexOf(text) + 1) }];
    return super.submit(key, request);
  }
}

async function harness() {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const reader = new Reader();
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-09-16", models: [VOXTRAL] },
    voice: { sidecar: null, localPresets: [], cloudSources: [{ provider: "mistral", list: async () => [PAUL] }] },
    dispatchClients: { mistral: reader },
    observeEvent: (event) => events.push(event),
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  // The narrator is Paul, through Mistral (SPEC-046 R-9): the read that used to be refused.
  const narrate = async () => {
    await coordinator.start(0);
    await send({ kind: "set-credential", provider: "mistral", key: "mistral-test-key" });
    await send({ kind: "set-narrator", voice: { provider: "mistral", model: VOXTRAL.id, voiceId: PAUL.voiceId, label: PAUL.label } });
    const sheet = provider.openStore()?.getBundle().sheets.find((candidate) => candidate.id === "maren-kest");
    assert.ok(sheet);
    const essence = authoritativeSheetSpeech(sheet, "Essence").text;
    const pieces = splitForSpeech(essence, CAP);
    assert.ok(pieces.length >= 2, `the fixture's Essence splits at ${CAP}: ${pieces.length}`);
    reader.pieces = pieces;
    return { essence, pieces };
  };
  const audio = (requestId: string) => events.filter((event): event is Audio => event.type === "voice.audio" && event.requestId === requestId);
  const file = (text: string) => speechCacheFile({ provider: VOXTRAL.provider, model: VOXTRAL.id, voiceId: PAUL.voiceId, text, format: "wav" });
  const bytes = async (rel: string) => new Uint8Array(await readFile(toExtendedLength(join(worldDir, rel))));
  /** Each piece's job as it stands, by the events the queue published for this request. */
  const jobs = (requestId: string) => {
    const seen = new Map<string, string>();
    for (const event of events) {
      if (event.type === "job.updated" && event.job.params["requestId"] === requestId) seen.set(event.job.id, event.job.status);
    }
    return [...seen.values()];
  };
  const priced = (pieces: readonly string[]) => pieces.reduce((sum, piece) => sum + piece.length * 16, 0);
  return { coordinator, events, reader, send, narrate, audio, file, bytes, jobs, priced };
}

const readSection = (send: (message: ClientMessage) => Promise<void>, requestId: string, confirmationToken?: string) =>
  send({ kind: "read-sheet-section", requestId, worldId: WORLD_ID, sheetId: "maren-kest", sectionHeading: "Essence", ...(confirmationToken !== undefined ? { confirmationToken } : {}) });

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("a read over the reader's cap (issue 1208)", () => {
  it("splits at sentence ends on the row's cap; a block that fits, a row without one, and a flac reader's go whole", () => {
    const long = "One sentence here. Another follows it. And a third to be sure of it.";
    assert.deepEqual(piecesFor(long, { limits: { maxPromptChars: 40 } }, "wav"), splitForSpeech(long, 40));
    assert.ok(piecesFor(long, { limits: { maxPromptChars: 40 } }, "wav").length > 1);
    assert.deepEqual(piecesFor(long, { limits: { maxPromptChars: 400 } }, "wav"), [long]);
    assert.deepEqual(piecesFor(long, { limits: {} }, "wav"), [long], "a row that states no cap is sent whole, as it always was");
    assert.deepEqual(piecesFor(long, { limits: { maxPromptChars: 40 } }, "flac"), [long], "flac cannot be joined, so it is not split");
  });

  it("is priced once as the sum of its pieces, made a piece a job, heard as each lands, and joined for the next read", async () => {
    const h = await harness();
    try {
      const { essence, pieces } = await h.narrate();
      await readSection(h.send, REQUEST);
      const asked = h.audio(REQUEST).find((event) => event.status === "confirmation-required");
      assert.ok(asked, "the read states its price before anything is sent");
      assert.equal(asked.characterCount, essence.length, "the count is the prose's");
      assert.equal(asked.estimatedMicroUsd, h.priced(pieces), "the price is the sum of the pieces, as each request bills");
      assert.equal(asked.parts, pieces.length, "and says how many pieces the read will go as");
      assert.equal(h.reader.attempts, 0, "nothing leaves while the price is on the table");

      await readSection(h.send, REQUEST, asked.confirmationToken);
      const accepted = h.events.find((event) => event.type === "queue.enqueue-result");
      assert.ok(accepted && accepted.type === "queue.enqueue-result");
      assert.equal(accepted.requestedCount, pieces.length, "a piece is a job of its own");
      await until(() => h.audio(REQUEST).filter((event) => event.status === "ready").length === pieces.length, "every piece to land");
      const ready = h.audio(REQUEST).filter((event) => event.status === "ready").sort((a, b) => a.part! - b.part!);
      assert.deepEqual(ready.map((event) => [event.part, event.parts]), pieces.map((_, index) => [index, pieces.length]), "each piece is a part, numbered in the order of the words");
      assert.deepEqual(ready.map((event) => event.characterCount), pieces.map((piece) => piece.length));
      assert.deepEqual(ready.map((event) => event.file), pieces.map(h.file), "each under its own cache key");
      const sent = h.events.flatMap((event) => (event.type === "job.updated" ? [event.job.params["text"]] : []));
      for (const piece of pieces) assert.ok(sent.includes(piece), "each piece went to the reader as it was split");

      // The join: the whole block's cache file, from the pieces in the order of the words.
      const whole = h.file(essence);
      let joined = new Uint8Array();
      await untilAsync(async () => { joined = await h.bytes(whole); return true; }, "the joined file to land");
      assert.ok(cachedVoiceAudioLooksRight(joined, "wav"));
      const view = Buffer.from(joined);
      const samples = Array.from({ length: (view.length - 44) / 2 }, (_, i) => view.readInt16LE(44 + i * 2));
      assert.deepEqual([...new Set(samples)], pieces.map((_, index) => index + 1), "the pieces follow one another as split, whatever order they landed in");
      assert.equal(h.audio(REQUEST).filter((event) => event.file === whole).length, 0, "a streamed read is not announced again once joined");

      h.events.length = 0;
      await readSection(h.send, AGAIN);
      const again = h.audio(AGAIN);
      assert.equal(again.length, 1);
      assert.equal(again[0]!.status, "ready");
      assert.equal(again[0]!.cached, true);
      assert.equal(again[0]!.file, whole, "the same words again are the joined file, and free");
      assert.equal(again[0]!.part, undefined);
    } finally {
      await h.coordinator.stop();
    }
  });

  it("keeps a page's block one part: its pieces are joined before it is announced, and never announced as parts", async () => {
    const h = await harness();
    try {
      const { essence, pieces } = await h.narrate();
      const page = (confirmationToken?: string) =>
        h.send({ kind: "read-sheet-page", requestId: PAGE, worldId: WORLD_ID, sheetId: "maren-kest", sections: ["Appearance", "Essence"], ...(confirmationToken !== undefined ? { confirmationToken } : {}) });
      await page();
      const asked = h.audio(PAGE).find((event) => event.status === "confirmation-required");
      assert.ok(asked);
      assert.equal(asked.parts, undefined, "a page's parts are its blocks, which its own dialog counts");
      await page(asked.confirmationToken);
      const accepted = h.events.find((event) => event.type === "queue.enqueue-result");
      assert.ok(accepted && accepted.type === "queue.enqueue-result");
      assert.equal(accepted.requestedCount, 1 + pieces.length, "the Appearance fits; the Essence goes in pieces");
      await until(() => h.audio(PAGE).filter((event) => event.status === "ready").length === 2, "both blocks");
      const ready = h.audio(PAGE).filter((event) => event.status === "ready").sort((a, b) => a.part! - b.part!);
      assert.deepEqual(ready.map((event) => [event.sectionHeading, event.part, event.parts]), [["Appearance", 0, 2], ["Essence", 1, 2]]);
      const block = ready[1]!;
      assert.equal(block.file, h.file(essence), "announced from the joined file");
      assert.equal(block.characterCount, essence.length, "as the whole block");
      assert.equal(block.estimatedMicroUsd, h.priced(pieces), "at the price of all its pieces");
      assert.ok(cachedVoiceAudioLooksRight(await h.bytes(block.file!), "wav"));
      await settle();
      assert.equal(h.audio(PAGE).filter((event) => event.status === "ready").length, 2, "nothing follows a settled page");
    } finally {
      await h.coordinator.stop();
    }
  });

  it("a piece the reader refuses fails the block once; what landed before it was heard, nothing after it is, and the block is never joined", async () => {
    const h = await harness();
    try {
      const { essence, pieces } = await h.narrate();
      h.reader.refuse = pieces.at(-1)!;
      await readSection(h.send, REQUEST);
      const asked = h.audio(REQUEST).find((event) => event.status === "confirmation-required")!;
      await readSection(h.send, REQUEST, asked.confirmationToken);
      await until(() => h.audio(REQUEST).some((event) => event.status === "failed"), "the refused piece to fail the read");
      await until(() => h.jobs(REQUEST).length === pieces.length && h.jobs(REQUEST).every((status) => status !== "queued" && status !== "running" && status !== "submitting"), "every piece's job to settle");
      await settle();
      const heard = h.audio(REQUEST).filter((event) => event.status === "ready");
      assert.equal(h.audio(REQUEST).filter((event) => event.status === "failed").length, 1, "failed once");
      assert.ok(heard.length >= 1 && heard.length < pieces.length, `the pieces that landed first were heard: ${heard.length} of ${pieces.length}`);
      assert.deepEqual(heard.map((event) => event.part), heard.map((_, index) => index), "in order, from the first");
      // A piece still landing when its block failed is not announced: the screen has been told
      // the read failed, and a part after that would say the read was going on.
      const failedAt = h.audio(REQUEST).findIndex((event) => event.status === "failed");
      assert.ok(h.audio(REQUEST).slice(failedAt + 1).every((event) => event.status !== "ready"), "nothing is heard after the failure");
      await assert.rejects(h.bytes(h.file(essence)), "no whole file was made from a block short of a piece");
    } finally {
      await h.coordinator.stop();
    }
  });

  it("a piece that fails first stops the block paying for the rest: the siblings are cancelled, and their cancellation is not a second failure", async () => {
    const h = await harness();
    try {
      const { pieces } = await h.narrate();
      h.reader.refuse = pieces[0]!;
      await readSection(h.send, REQUEST);
      const asked = h.audio(REQUEST).find((event) => event.status === "confirmation-required")!;
      await readSection(h.send, REQUEST, asked.confirmationToken);
      await until(() => h.jobs(REQUEST).length === pieces.length && h.jobs(REQUEST).every((status) => status === "failed" || status === "cancelled"), "every piece's job to settle");
      assert.deepEqual(h.jobs(REQUEST).sort(), [...pieces.slice(1).map(() => "cancelled"), "failed"].sort(), "one failed, the rest cancelled unpaid");
      assert.equal(h.reader.attempts, 1, "the siblings never reached the reader");
      await settle();
      assert.equal(h.audio(REQUEST).filter((event) => event.status === "failed").length, 1, "the cancelled siblings are not news");
      assert.equal(h.audio(REQUEST).filter((event) => event.status === "ready").length, 0);
    } finally {
      await h.coordinator.stop();
    }
  });
});
