import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChapterAudiobookSchema,
  audiobookBlocks,
  audiobookHeading,
  billableCharacters,
  normalizeSpeechText,
  type ChapterVoices,
  type ClientMessage,
  type DomainEvent,
  type ManifestModel,
  type VoiceCandidate,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { audiobookBookPath, audiobookPath, legacyAudiobookPath } from "../../src/productions/audiobook.js";
import { priorPartJob, type PartIdentity } from "../../src/productions/audiobook-run.js";
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
/** A reader that bills by the byte, as the shipped Fish row does (SPEC-046 R-8). */
const FISH: ManifestModel = {
  id: "fish-s2.1-pro",
  provider: "fishaudio",
  capability: "voice-tts",
  displayName: "Fish Audio S2.1 Pro",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 2000, audioFormat: "wav" },
  pricing: { kind: "perCharacter", microUsdPerCharacter: 15, unit: "utf8-byte" },
};
const LOW_TIDE: VoiceCandidate = { provider: "elevenlabs", model: ELEVEN.id, voiceId: "v_8Kq2", label: "Low tide", attributes: [], local: false, canClone: false };
const HARBOUR: VoiceCandidate = { provider: "fishaudio", model: FISH.id, voiceId: "fv_harbour", label: "Harbour", attributes: [], local: false, canClone: false };
const castRecord = (hash: string): ChapterVoices => ({
  version: 4,
  hash,
  derivedAt: CLOCK,
  passes: 1,
  dropped: 0,
  omitted: 0,
  lines: [{ speaker: "Maren Kest", sheet: "maren-kest", paragraph: 0, occurrence: 0, quote: SPAN }],
});

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
  input: {
    cloud?: readonly VoiceCandidate[];
    fish?: readonly VoiceCandidate[];
    castHash?: string;
    /** Edits to the world's copy before it is loaded: a cloned voice, a sheet's voice. */
    before?: (worldDir: string) => Promise<void>;
    /** A composition without voice at all. */
    voiceless?: boolean;
    /** The sidecar's synthesis, when a test needs to watch it or hold it. */
    synthesize?: (request: { voiceId: string; text: string }, options?: { signal?: AbortSignal }) => Promise<Uint8Array>;
    /** A measurement for every filed take, so a test can see a restored file measured afresh. */
    durations?: () => number;
  },
  run: (h: {
    root: string;
    worldDir: string;
    events: DomainEvent[];
    spoken: string[];
    send: (message: ClientMessage) => Promise<void>;
    bundle: () => import("@arke-studio/contracts").WorldBundle;
    reload: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await input.before?.(worldDir);
  const castDir = join(worldDir, "productions", LEDGER, ".voices");
  await mkdir(castDir, { recursive: true });
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore?.();
  assert.ok(store);
  const chapter = store.getBundle().productions.find((p) => p.meta.id === LEDGER)?.chapters.find((c) => c.id === "neap");
  assert.ok(chapter?.bodyHash, "the fixture's chapter carries its prose hash");
  await writeFile(join(castDir, "01-neap.json"), JSON.stringify(castRecord(input.castHash ?? chapter.bodyHash)), "utf8");
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
    manifest: { manifestVersion: 1, generated: "2026-09-14", models: [ELEVEN, KOKORO, FISH] },
    observeEvent: (event) => events.push(event),
    ...(input.durations ? { mediaProbe: { durationSec: async () => input.durations!(), info: async () => ({ durationSec: input.durations!(), hasAudio: true }) } } : {}),
    ...(input.voiceless
      ? {}
      : {
          voice: {
            sidecar: {
              health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
              listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
              synthesize: async (request: { voiceId: string; text: string }, options?: { signal?: AbortSignal }) => {
                spoken.push(request.text);
                return input.synthesize ? input.synthesize(request, options) : wav();
              },
              transcribe: async () => ({ text: "" }),
            } as never,
            localPresets: [],
            cloudSources: [
              { provider: "elevenlabs", list: async () => [...(input.cloud ?? [])] },
              { provider: "fishaudio", list: async () => [...(input.fish ?? [])] },
            ],
            hostedReaders: [{ provider: "fishaudio", model: FISH.id }],
          },
        }),
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  try {
    await run({
      root,
      worldDir,
      events,
      spoken,
      send,
      bundle: () => provider.openStore!()!.getBundle(),
      reload: async () => {
        await provider.openStore!()!.reload();
      },
    });
  } finally {
    await provider.close();
  }
}

const read = (send: (message: ClientMessage) => Promise<void>, extra: { confirmationToken?: string; voiceUploadConfirmedFor?: string; chapterFile?: string } = {}) =>
  send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", ...extra });
const recordPath = (worldDir: string, chapterFile = "01-neap") => join(worldDir, "productions", LEDGER, ".audiobook", "chapters", `${chapterFile}.json`);
const readRecord = async (worldDir: string, chapterFile = "01-neap") => ChapterAudiobookSchema.parse(JSON.parse(await readFile(recordPath(worldDir, chapterFile), "utf8")));

describe("a part already in the queue (codex on PR 1180)", () => {
  const identity: PartIdentity = { productionId: LEDGER, chapterId: "neap", block: "p0.0", textHash: "text-v1:abc", provider: "elevenlabs", model: ELEVEN.id, voiceId: "v_8Kq2", parts: 1 };
  const job = (id: string, status: string, extra: Record<string, unknown> = {}, params: Record<string, unknown> = {}) =>
    ({
      id,
      status,
      provider: "elevenlabs",
      model: ELEVEN.id,
      target: { kind: "voice-preview", id: "x" },
      params: { purpose: "audiobook", productionId: LEDGER, chapterId: "neap", block: "p0.0", textHash: "text-v1:abc", voiceId: "v_8Kq2", part: 0, parts: 1, ...params },
      ...extra,
    }) as unknown as import("@arke-studio/contracts").Job;

  it("finds a landed job to file rather than asking for the part again", () => {
    const found = priorPartJob([job("j1", "succeeded", { landedFiles: [".staging/audiobook/x/p0-0.mp3"] })], identity, 0);
    assert.equal(found?.kind, "landed");
    assert.equal(found?.job.id, "j1");
  });

  it("waits for a job still being made, and the newest row wins over an older failure", () => {
    const found = priorPartJob([job("j1", "failed"), job("j2", "running")], identity, 0);
    assert.equal(found?.kind, "running");
    assert.equal(found?.job.id, "j2");
  });

  it("nothing usable: a failed job, another part, other words, another voice or another chapter", () => {
    assert.equal(priorPartJob([job("j1", "failed")], identity, 0), null);
    assert.equal(priorPartJob([job("j1", "succeeded", { landedFiles: ["a"] }, { part: 1 })], identity, 0), null);
    assert.equal(priorPartJob([job("j1", "succeeded", { landedFiles: ["a"] }, { textHash: "text-v1:other" })], identity, 0), null);
    assert.equal(priorPartJob([job("j1", "succeeded", { landedFiles: ["a"] }, { voiceId: "other" })], identity, 0), null);
    assert.equal(priorPartJob([job("j1", "succeeded", { landedFiles: ["a"] }, { chapterId: "slack-water" })], identity, 0), null);
    assert.equal(priorPartJob([job("j1", "succeeded", { landedFiles: ["a"] }, { productionId: "other" })], identity, 0), null, "another production's job is not this one's part");
  });
});

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
      const record = await readRecord(worldDir);
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

  it("the chapters' records sit under chapters/, so a chapter named book is not the book's file (codex on PR 1180)", () => {
    assert.notEqual(audiobookPath("p", "book"), audiobookBookPath("p"));
    assert.equal(audiobookPath("p", "01-neap"), "productions/p/.audiobook/chapters/01-neap.json");
  });

  it("a reader that bills by the byte is priced by the byte, the card counting the prose (codex on PR 1180)", () =>
    withHarness({ fish: [HARBOUR] }, async ({ worldDir, events, send, bundle }) => {
      await send({ kind: "set-credential", provider: "fishaudio", key: "k-test" });
      await send({ kind: "set-narrator", voice: { provider: "fishaudio", model: FISH.id, voiceId: HARBOUR.voiceId, label: "Harbour" } });
      await read(send);
      const priced = events.find((e): e is Priced => e.type === "audiobook.priced");
      assert.ok(priced, `every block is the narrator's, and the narrator is a cloud voice: ${events.map((e) => e.type).join(" | ")}`);
      const chapter = bundle().productions.find((p) => p.meta.id === LEDGER)!.chapters.find((c) => c.id === "neap")!;
      const raw = await readFile(join(worldDir, "productions", LEDGER, "chapters", "01-neap.md"), "utf8");
      const body = raw.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "");
      const texts = audiobookBlocks(body, castRecord(chapter.bodyHash!), audiobookHeading(chapter.order, chapter.title)).blocks.map((block) => normalizeSpeechText(block.text));
      const characters = texts.reduce((sum, text) => sum + text.length, 0);
      const bytes = texts.reduce((sum, text) => sum + billableCharacters(FISH, text), 0);
      assert.ok(bytes > characters, "the fixture's dashes and quotes are more bytes than characters, or this proves nothing");
      assert.equal(priced.characters, characters, "the card counts the prose");
      assert.equal(priced.estimatedMicroUsd, bytes * 15, "the price is the vendor's count");
      assert.deepEqual(priced.voices.map((v) => [v.label, v.provider, v.estimatedMicroUsd]), [["Harbour", "fishaudio", bytes * 15]]);
    }));

  it("a hosted reader's cloned voice is asked for its consent by voice and vendor, once, before the price (codex on PR 1180)", () =>
    withHarness(
      {
        before: async (worldDir) => {
          await mkdir(join(worldDir, "voices"), { recursive: true });
          await writeFile(join(worldDir, "voices", "harbour-glass.wav"), wav());
          await writeFile(
            join(worldDir, "voices", "voices.json"),
            JSON.stringify({ voices: [{ id: "harbour-glass", name: "Harbour glass", clip: "voices/harbour-glass.wav", description: "", attributes: [], consent: true, created: CLOCK }] }),
          );
          const sheet = join(worldDir, "characters", "maren-kest.md");
          const raw = await readFile(sheet, "utf8");
          const swapped = raw.replace(/voice:\r?\n  provider: elevenlabs\r?\n  voiceId: v_8Kq2\r?\n  label: Low tide\r?\n/, `voice:\n  provider: fishaudio\n  model: ${FISH.id}\n  voiceId: harbour-glass\n  label: Harbour glass\n`);
          assert.notEqual(swapped, raw, "the fixture sheet's voice is what this test swaps");
          await writeFile(sheet, swapped);
        },
      },
      async ({ worldDir, events, send }) => {
        await send({ kind: "set-credential", provider: "fishaudio", key: "k-test" });
        await send({ kind: "set-audiobook-reading", worldId: WORLD_ID, productionId: LEDGER, reading: "cast" });
        await read(send);
        type Asked = Extract<DomainEvent, { type: "voice.upload-confirmation-required" }>;
        const asked = events.find((e): e is Asked => e.type === "voice.upload-confirmation-required");
        assert.ok(asked, `the recording is asked about before anything is priced: ${events.map((e) => e.type).join(" | ")}`);
        assert.equal(asked.confirmationToken, "vendor:fishaudio:harbour-glass", "per voice and vendor");
        assert.match(asked.destinationLabel, /Fish Audio · Harbour glass/);
        assert.equal(events.filter((e) => e.type === "audiobook.priced").length, 0);
        assert.equal(events.filter((e) => e.type === "audiobook.finished").length, 0, "the run waits for the answer");

        await read(send, { voiceUploadConfirmedFor: asked.confirmationToken });
        const priced = events.find((e): e is Priced => e.type === "audiobook.priced");
        assert.ok(priced, `answered, the run goes on to its price: ${events.map((e) => e.type).join(" | ")}`);
        assert.deepEqual(priced.voices.map((v) => [v.label, v.provider]), [["Harbour glass", "fishaudio"]]);
        const library = JSON.parse(await readFile(join(worldDir, "voices", "voices.json"), "utf8")) as { voices: { remote?: Record<string, { confirmedAt?: string }> }[] };
        assert.equal(typeof library.voices[0]!.remote?.["fishaudio"]?.confirmedAt, "string", "the answer is written onto the voice, so it is never asked twice");
        assert.equal(events.filter((e) => e.type === "voice.upload-confirmation-required").length, 1, "asked once");
      },
    ));

  it("without voice in the build, the press is answered as unavailable rather than with nothing (codex on PR 1180)", () =>
    withHarness({ voiceless: true }, async ({ events, send }) => {
      await read(send);
      const finished = events.find((e): e is Finished => e.type === "audiobook.finished");
      assert.equal(finished?.outcome, "unavailable");
      assert.ok(finished?.reason);
    }));

  it("local synthesis is one call at a time across chapters (codex on PR 1180)", async () => {
    let inFlight = 0;
    let most = 0;
    await withHarness(
      {
        synthesize: async () => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 8));
          inFlight -= 1;
          return wav();
        },
      },
      async ({ events, send }) => {
        await Promise.all([read(send), read(send, { chapterFile: "02-the-same-ink" })]);
        const finished = events.filter((e): e is Finished => e.type === "audiobook.finished");
        assert.equal(finished.length, 2, "two chapters, two runs");
        assert.ok(finished.every((e) => e.outcome === "read"), finished.map((e) => e.reason ?? e.outcome).join(" | "));
        assert.equal(most, 1, "never two syntheses at once on the one small engine");
      },
    );
  });

  it("a stop ends the local block in flight rather than finishing it (codex on PR 1180)", async () => {
    let stop: (() => Promise<void>) | null = null;
    let sawAbort = false;
    await withHarness(
      {
        synthesize: (_request, options) =>
          new Promise<Uint8Array>((resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                sawAbort = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
            // The stop arrives while the first chunk is being made; without the signal the
            // engine would finish it and the run would keep the take before noticing.
            void stop?.().then(() => setTimeout(() => resolve(wav()), 300));
          }),
      },
      async ({ events, spoken, send, worldDir }) => {
        stop = () => send({ kind: "stop-audiobook", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap" });
        await read(send);
        const finished = events.find((e): e is Finished => e.type === "audiobook.finished");
        assert.equal(finished?.outcome, "stopped");
        assert.ok(sawAbort, "the chunk in flight was cancelled");
        assert.equal(spoken.length, 1, "no second chunk was asked for");
        assert.equal(finished?.made, 0, "a cancelled block is not kept");
        assert.ok(!existsSync(recordPath(worldDir)), "nothing was made, so nothing was written");
      },
    );
  });

  it("a local block over the engine's chunk records its parts, and a file the cache already held is adopted (codex on PR 1180)", () =>
    withHarness({}, async ({ worldDir, events, spoken, send }) => {
      const chapterFile = "04-her-own-hand";
      await read(send, { chapterFile });
      const record = await readRecord(worldDir, chapterFile);
      const takes = Object.values(record.takes);
      assert.ok(takes.some((take) => take.parts > 1), "a paragraph over 450 characters is made in more than one request");
      assert.equal(spoken.length, takes.reduce((sum, take) => sum + take.parts, 0), "the parts recorded are the requests made");
      assert.ok(takes.every((take) => take.adopted === undefined));

      // The record gone and the cache still holding every file: the next run adopts rather than makes.
      await rm(recordPath(worldDir, chapterFile));
      const before = spoken.length;
      await read(send, { chapterFile });
      const finished = events.filter((e): e is Finished => e.type === "audiobook.finished").at(-1)!;
      assert.equal(finished.outcome, "read", finished.reason);
      assert.equal(spoken.length, before, "nothing is synthesised twice");
      const again = await readRecord(worldDir, chapterFile);
      const adopted = Object.values(again.takes);
      assert.equal(adopted.length, takes.length);
      assert.ok(adopted.every((take) => take.adopted === true), "every take says it came from the cache");
      assert.deepEqual(adopted.map((take) => take.parts), takes.map((take) => take.parts), "a hit names the parts the file was made from");
      const progress = events.filter((e): e is Progress => e.type === "audiobook.progress").slice(-adopted.length);
      assert.ok(progress.every((e) => e.outcome === "adopted"), progress.map((e) => e.outcome).join(","));
    }));

  it("a take whose file is gone from the shelf is made again, not shown as made, and the open answer names it (codex on PR 1180, 1183)", () =>
    withHarness({}, async ({ worldDir, events, send, bundle }) => {
      await read(send);
      const record = await readRecord(worldDir);
      const title = bundle().artifacts.find((a) => a.id === record.takes["title"]!.artifactId);
      assert.ok(title, "the title's take is on the shelf");
      await rm(join(worldDir, "artifacts", title.file));
      // The window cannot look at the media, so opening the chapter says which takes are gone.
      type Opened = Extract<DomainEvent, { type: "chapter.open-result" }>;
      const requestId = "01J8F3K2QW9VZX4N7M0RTYB6H7";
      await send({ kind: "open-chapter", requestId, worldId: WORLD_ID, productionId: LEDGER, chapterId: "neap" });
      const opened = events.find((e): e is Opened => e.type === "chapter.open-result" && e.requestId === requestId);
      assert.ok(opened && opened.disposition === "opened");
      assert.deepEqual(opened.audiobookMissing, [title.id], "the title's take is named as gone");
      await read(send);
      const finished = events.filter((e): e is Finished => e.type === "audiobook.finished").at(-1)!;
      assert.equal(finished.outcome, "read", finished.reason);
      assert.equal(finished.made, 1, "the title alone is made again");
      const progress = events.filter((e): e is Progress => e.type === "audiobook.progress").at(-1)!;
      assert.equal(progress.block, "title");
      const again = await readRecord(worldDir);
      const kept = bundle().artifacts.find((a) => a.id === again.takes["title"]!.artifactId);
      assert.ok(kept && existsSync(join(worldDir, "artifacts", kept.file)), "the record names a take that is there");
      assert.equal(kept.id, title.id, "restored under the sidecar it always had, so the id every record names stays true");
      const requestId2 = "01J8F3K2QW9VZX4N7M0RTYB6H8";
      await send({ kind: "open-chapter", requestId: requestId2, worldId: WORLD_ID, productionId: LEDGER, chapterId: "neap" });
      const reopened = events.find((e): e is Opened => e.type === "chapter.open-result" && e.requestId === requestId2);
      assert.ok(reopened && reopened.disposition === "opened");
      assert.equal(reopened.audiobookMissing, undefined, "nothing is gone any more");
    }));

  it("a restored take is measured afresh: the last file's duration does not outlive its bytes (codex on PR 1183)", async () => {
    let duration = 3;
    await withHarness({ durations: () => duration }, async ({ worldDir, send, bundle }) => {
      await read(send);
      const record = await readRecord(worldDir);
      const title = bundle().artifacts.find((a) => a.id === record.takes["title"]!.artifactId);
      assert.equal(title?.mediaInfo?.durationSec, 3, "measured when filed");
      await rm(join(worldDir, "artifacts", title!.file));
      duration = 5;
      await read(send);
      const restored = bundle().artifacts.find((a) => a.id === title!.id);
      assert.equal(restored?.mediaInfo?.durationSec, 5, "the restored file is measured, not handed the old file's duration");
    });
  });

  it("a record the first build wrote beside the book's file is read from there and moved by the next write (codex on PR 1183)", () =>
    withHarness({}, async ({ worldDir, events, spoken, send, bundle, reload }) => {
      await read(send);
      const made = await readRecord(worldDir);
      const legacy = join(worldDir, legacyAudiobookPath(LEDGER, "01-neap"));
      await rename(recordPath(worldDir), legacy);
      await reload();
      const stamp = bundle().productions.find((p) => p.meta.id === LEDGER)!.chapters.find((c) => c.id === "neap")!.audiobook;
      assert.ok(stamp && "takes" in stamp && stamp.takes === Object.keys(made.takes).length, "the scanner's stamp reads the old path");
      type Opened = Extract<DomainEvent, { type: "chapter.open-result" }>;
      const requestId = "01J8F3K2QW9VZX4N7M0RTYB6H6";
      await send({ kind: "open-chapter", requestId, worldId: WORLD_ID, productionId: LEDGER, chapterId: "neap" });
      const opened = events.find((e): e is Opened => e.type === "chapter.open-result" && e.requestId === requestId);
      assert.ok(opened && opened.disposition === "opened");
      assert.deepEqual(opened.audiobook, made, "the chapter opens with its record");

      // Nothing to make: nothing is written, and the old file stays where it was.
      const before = spoken.length;
      await read(send);
      assert.equal(spoken.length, before, "every take is still made — nothing is paid for or spoken again");
      assert.ok(existsSync(legacy) && !existsSync(recordPath(worldDir)));

      // One take gone: the run makes it and writes the record to the chapter's own path, and the old file goes.
      const title = bundle().artifacts.find((a) => a.id === made.takes["title"]!.artifactId)!;
      await rm(join(worldDir, "artifacts", title.file));
      await read(send);
      const finished = events.filter((e): e is Finished => e.type === "audiobook.finished").at(-1)!;
      assert.equal(finished.outcome, "read", finished.reason);
      assert.equal(finished.made, 1);
      assert.ok(existsSync(recordPath(worldDir)) && !existsSync(legacy), "moved, not shadowed");
      assert.equal(Object.keys((await readRecord(worldDir)).takes).length, Object.keys(made.takes).length);
    }));

  it("the runtime's Test control takes its turn on the engine like every other synthesis (codex on PR 1183)", async () => {
    let inFlight = 0;
    let most = 0;
    await withHarness(
      {
        synthesize: async () => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 8));
          inFlight -= 1;
          return wav();
        },
      },
      async ({ events, send }) => {
        const requestId = "01J8F3K2QW9VZX4N7M0RTYB6H5";
        await Promise.all([read(send), send({ kind: "test-local-voice", requestId })]);
        type Tested = Extract<DomainEvent, { type: "voice.runtime-test" }>;
        const tested = events.filter((e): e is Tested => e.type === "voice.runtime-test" && e.requestId === requestId).at(-1);
        assert.equal(tested?.status, "ready", tested?.detail);
        assert.equal(most, 1, "the test never ran beside the run's synthesis");
      },
    );
  });

  it("a run stopped while it waits its turn behind another synthesis ends then, not when that synthesis does (codex on PR 1183)", async () => {
    let releaseFirst: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    await withHarness(
      {
        synthesize: async () => {
          calls += 1;
          if (calls === 1) await first;
          return wav();
        },
      },
      async ({ events, send }) => {
        const ahead = read(send);
        while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        const behind = read(send, { chapterFile: "02-the-same-ink" });
        while (!events.some((e) => e.type === "audiobook.started" && e.chapterId === "the-same-ink")) await new Promise((resolve) => setTimeout(resolve, 5));
        await new Promise((resolve) => setTimeout(resolve, 100));
        await send({ kind: "stop-audiobook", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "02-the-same-ink" });
        await behind;
        const stopped = events.find((e): e is Finished => e.type === "audiobook.finished" && e.chapterId === "the-same-ink");
        assert.equal(stopped?.outcome, "stopped");
        assert.equal(calls, 1, "the run behind asked the engine for nothing, and the one ahead is still on its first chunk");
        releaseFirst();
        await ahead;
        const done = events.find((e): e is Finished => e.type === "audiobook.finished" && e.chapterId === "neap");
        assert.equal(done?.outcome, "read", done?.reason);
      },
    );
  });

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
