import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChapterAudiobookSchema, type ClientMessage, type DomainEvent, type ManifestModel, type VoiceCandidate } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * A chapter read into kept takes (design turn 146, SPEC-047 R-16..R-19): every block that is
 * not made, in reading order, filed as the production's artifacts and written into the record
 * block by block; a second press makes nothing; a cloud voice is priced once and named before
 * anything leaves; and under `cast` a moved cast refuses the run rather than voicing a line the
 * door never said would fall to the narrator.
 */
const CLOCK = "2026-09-14T09:00:00.000Z";
const LEDGER = "the-ledger-of-nights";
const SPAN = "kept in a hand that changes every generation";
const ELEVEN: ManifestModel = {
  id: "eleven_multilingual_v2",
  provider: "elevenlabs",
  capability: "voice-tts",
  displayName: "ElevenLabs",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 5000, audioFormat: "mp3" },
  pricing: { kind: "perCharacter", microUsdPerCharacter: 300 },
};
const KOKORO: ManifestModel = {
  id: "kokoro-82m",
  provider: "kokoro",
  capability: "voice-tts",
  displayName: "Kokoro",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 5000, audioFormat: "wav" },
  pricing: { kind: "unmetered" },
};
const LOW_TIDE: VoiceCandidate = { provider: "elevenlabs", model: ELEVEN.id, voiceId: "v_8Kq2", label: "Low tide", attributes: [], local: false, canClone: false };

function wav(): Uint8Array {
  const samples = 8;
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
  return new Uint8Array(out);
}

type Finished = Extract<DomainEvent, { type: "audiobook.finished" }>;
type Progress = Extract<DomainEvent, { type: "audiobook.progress" }>;
type Priced = Extract<DomainEvent, { type: "audiobook.priced" }>;

async function withHarness(
  input: { cloud?: readonly VoiceCandidate[]; castHash?: string },
  run: (h: { root: string; worldDir: string; events: DomainEvent[]; spoken: string[]; send: (message: ClientMessage) => Promise<void>; bundle: () => import("@arke-studio/contracts").WorldBundle }) => Promise<void>,
): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  const castDir = join(worldDir, "productions", LEDGER, ".voices");
  await mkdir(castDir, { recursive: true });
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore?.();
  assert.ok(store);
  const chapter = store.getBundle().productions.find((p) => p.meta.id === LEDGER)?.chapters.find((c) => c.id === "neap");
  assert.ok(chapter?.bodyHash, "the fixture's chapter carries its prose hash");
  await writeFile(
    join(castDir, "01-neap.json"),
    JSON.stringify({
      version: 4,
      hash: input.castHash ?? chapter.bodyHash,
      derivedAt: CLOCK,
      passes: 1,
      dropped: 0,
      omitted: 0,
      lines: [{ speaker: "Maren Kest", sheet: "maren-kest", paragraph: 0, occurrence: 0, quote: SPAN }],
    }),
    "utf8",
  );
  await store.reload();
  const events: DomainEvent[] = [];
  const spoken: string[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-09-14", models: [ELEVEN, KOKORO] },
    observeEvent: (event) => events.push(event),
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async (request: { voiceId: string; text: string }) => {
          spoken.push(request.text);
          return wav();
        },
        transcribe: async () => ({ text: "" }),
      } as never,
      localPresets: [],
      cloudSources: [{ provider: "elevenlabs", list: async () => [...(input.cloud ?? [])] }],
    },
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  try {
    await run({ root, worldDir, events, spoken, send, bundle: () => provider.openStore!()!.getBundle() });
  } finally {
    await provider.close();
  }
}

const read = (send: (message: ClientMessage) => Promise<void>, extra: { confirmationToken?: string } = {}) =>
  send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", ...extra });

describe("the audiobook run (turn 146)", () => {
  it("reads every block in the narrator's voice, files each take as the production's artifact, and a second press makes nothing", () =>
    withHarness({}, async ({ worldDir, events, spoken, send, bundle }) => {
      await read(send);
      const finished = events.filter((e): e is Finished => e.type === "audiobook.finished");
      assert.equal(finished.length, 1);
      assert.equal(finished[0]!.outcome, "read", finished[0]!.reason);
      const progress = events.filter((e): e is Progress => e.type === "audiobook.progress");
      assert.ok(progress.length >= 2, "the title and at least one paragraph");
      assert.ok(progress.every((e) => e.outcome === "made"), "every block made locally");
      assert.equal(progress[0]!.block, "title", "the title is the chapter's first block (R-2)");
      assert.ok(spoken[0]!.startsWith("Chapter "), "the narrator reads the title");
      assert.equal(finished[0]!.made, progress.length);
      const takes = bundle().artifacts.filter((a) => a.generation?.source === "audiobook");
      assert.equal(takes.length, progress.length, "a take an artifact, each");
      assert.ok(takes.every((a) => a.production === LEDGER && a.kind === "audio"), "owned by the production, listed as audio");
      assert.ok(takes.every((a) => a.links.includes("neap")), "linked to the chapter");
      const raw = await readFile(join(worldDir, "productions", LEDGER, ".audiobook", "01-neap.json"), "utf8");
      const record = ChapterAudiobookSchema.parse(JSON.parse(raw));
      assert.equal(Object.keys(record.takes).length, progress.length);
      assert.ok(record.takes["title"]?.reader.provider === "kokoro");
      assert.equal(bundle().productions.find((p) => p.meta.id === LEDGER)?.chapters.find((c) => c.id === "neap")?.audiobook && "takes" in bundle().productions.find((p) => p.meta.id === LEDGER)!.chapters.find((c) => c.id === "neap")!.audiobook!, true, "the summary carries the stamp");

      const before = spoken.length;
      await read(send);
      const again = events.filter((e): e is Finished => e.type === "audiobook.finished");
      assert.equal(again.length, 2);
      assert.equal(again[1]!.outcome, "read");
      assert.equal(spoken.length, before, "nothing made twice (R-16)");
      assert.equal(bundle().artifacts.filter((a) => a.generation?.source === "audiobook").length, takes.length);
    }));

  it("under cast, a cloud voice is priced once and named before anything leaves; confirmed, the narration is still made locally (R-17)", () =>
    withHarness({ cloud: [LOW_TIDE] }, async ({ events, spoken, send, bundle }) => {
      await send({ kind: "set-credential", provider: "elevenlabs", key: "k-test" });
      await send({ kind: "set-audiobook-reading", worldId: WORLD_ID, productionId: LEDGER, reading: "cast" });
      assert.equal(bundle().productions.find((p) => p.meta.id === LEDGER)?.audiobook?.reading, "cast", "the reading is the book's, on the bundle");
      await read(send);
      const priced = events.find((e): e is Priced => e.type === "audiobook.priced");
      assert.ok(priced, "the run states its price once");
      assert.equal(priced.characters, SPAN.length, "only the cloud block is priced");
      assert.equal(priced.estimatedMicroUsd, SPAN.length * 300);
      assert.deepEqual(priced.voices.map((v) => [v.label, v.provider, v.characters]), [["Low tide", "elevenlabs", SPAN.length]]);
      assert.equal(spoken.length, 0, "nothing sounds while the price is on the table");
      assert.equal(events.filter((e) => e.type === "audiobook.finished").length, 0, "a priced run waits for its answer");

      await read(send, { confirmationToken: priced.confirmationToken });
      const finished = events.filter((e): e is Finished => e.type === "audiobook.finished");
      assert.equal(finished.length, 1);
      assert.equal(finished[0]!.outcome, "read");
      const progress = events.filter((e): e is Progress => e.type === "audiobook.progress");
      const line = progress.find((e) => e.block === "p0.1" || e.block === "p0.0");
      assert.ok(line, "Maren's line is a block of its own");
      // No provider client stands behind the queue here, so the cloud block cannot be made: it
      // is flagged with the reason and the narration around it is still made and kept.
      const flagged = progress.filter((e) => e.outcome === "flagged");
      assert.equal(flagged.length, 1, "the one cloud block is flagged, not silently narrated");
      assert.ok(spoken.length >= 2, "the title and the narration were made locally");
      assert.equal(finished[0]!.flagged, 1);
    }));

  it("under cast, a cast the prose moved under refuses the run by name (R-12)", () =>
    withHarness({ castHash: `sha256:${"0".repeat(64)}` }, async ({ events, spoken, send }) => {
      await send({ kind: "set-audiobook-reading", worldId: WORLD_ID, productionId: LEDGER, reading: "cast" });
      await read(send);
      const finished = events.find((e): e is Finished => e.type === "audiobook.finished");
      assert.ok(finished);
      assert.equal(finished.outcome, "refused");
      assert.equal(finished.reason, "cast moved · cast again");
      assert.equal(spoken.length, 0);
    }));
});
