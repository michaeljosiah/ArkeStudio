import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { audiobookTextHash, type ChapterMix, type ClientMessage, type DomainEvent, type ManifestModel } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { AUDIOBOOK_TIMING_SCHEMA_VERSION } from "../../src/world/commit.js";
import { planAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
import { chapterTiming } from "../../src/productions/audiobook-timing.js";
import { MIX_RATE, mixSamples, renderChapterMix } from "../../src/productions/audiobook-mix.js";
import { integratedLoudness, readSpeechWav, writeSpeechWav } from "../../src/audio/speech-wav.js";
import type { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Timing on the blocks (design turn 187, SPEC-047 R-80..R-89): a block's timing written through
 * the record's lane past the build before it, held to the binding, kept across a new take while
 * its trim goes; and the one renderer mixing a chapter's takes with their timing — an
 * interruption mixed under the line it cuts, a bed ducked under the voices.
 */
const CLOCK = "2026-10-03T13:00:00.000Z";
const LEDGER = "the-ledger-of-nights";
const KOKORO: ManifestModel = {
  id: "kokoro-82m",
  provider: "kokoro",
  capability: "voice-tts",
  displayName: "Kokoro",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 5000, audioFormat: "wav" },
  pricing: { kind: "unmetered" },
};

/** One second of a steady tone: loud enough to measure, the same in every take. */
function tone(seconds = 1, level = 0.25, hz = 220): Uint8Array {
  const samples = new Float32Array(Math.round(seconds * MIX_RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = level * Math.sin((2 * Math.PI * hz * i) / MIX_RATE);
  return writeSpeechWav({ rate: MIX_RATE, samples });
}

type RecordEvent = Extract<DomainEvent, { type: "audiobook.record" }>;
type MixEvent = Extract<DomainEvent, { type: "audiobook.mix" }>;

async function withHarness(run: (h: { worldDir: string; events: DomainEvent[]; send: (message: ClientMessage) => Promise<void>; schemaVersion: () => number; store: () => WorldStore }) => Promise<void>): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "productions", LEDGER, ".voices"), { recursive: true });
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-10-03", models: [KOKORO] },
    observeEvent: (event) => events.push(event),
    mediaProbe: { durationSec: async () => 1, info: async () => ({ durationSec: 1, hasAudio: true }) },
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async () => tone(),
        transcribe: async () => ({ text: "" }),
      } as never,
      localPresets: [],
      cloudSources: [],
      hostedReaders: [],
    },
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await run({ worldDir, events, send, schemaVersion: () => provider.openStore!()!.getBundle().meta.schemaVersion, store: () => provider.openStore!()! });
  } finally {
    await provider.close();
  }
}

const REQUEST = "01J00000000000000000000187";
const NARRATOR = { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george" };
const read = (send: (message: ClientMessage) => Promise<void>, blocks?: string[]) =>
  send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", ...(blocks !== undefined ? { blocks } : {}) });
const setTiming = (send: (message: ClientMessage) => Promise<void>, block: string, timing: Extract<ClientMessage, { kind: "set-audiobook-timing" }>["timing"]) =>
  send({ kind: "set-audiobook-timing", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", block, timing, requestId: REQUEST });
const lastRecord = (events: DomainEvent[]) => events.filter((e): e is RecordEvent => e.type === "audiobook.record").at(-1)!;

describe("a block's timing (turn 187)", () => {
  it("writes a start past the build before timing, and the block before's pause is the same value", () =>
    withHarness(async ({ worldDir, events, send, schemaVersion, store }) => {
      await read(send);
      assert.ok(schemaVersion() < AUDIOBOOK_TIMING_SCHEMA_VERSION);
      await setTiming(send, "p1.0", { start: -0.4 });
      assert.equal(lastRecord(events).refused, undefined);
      assert.equal(lastRecord(events).record?.timing?.["p1.0"]?.start, -0.4);
      assert.equal(lastRecord(events).record?.timing?.["p1.0"]?.by, "author");
      assert.equal(schemaVersion(), AUDIOBOOK_TIMING_SCHEMA_VERSION, "raised before the first timed record");

      // `Pause after` on the block before writes the same value.
      await setTiming(send, "p0.0", { pauseAfter: 0.3 });
      assert.equal(lastRecord(events).record?.timing?.["p1.0"]?.start, 0.3);

      const plan = await planAudiobook(store(), LEDGER, "neap", { narrator: NARRATOR });
      const timing = chapterTiming(store(), plan, "skip");
      const p0 = timing.bars.find((bar) => bar.key === "p0.0")!;
      const p1 = timing.bars.find((bar) => bar.key === "p1.0")!;
      assert.equal(p1.at, p0.at + p0.seconds + 0.3);

      await setTiming(send, "p1.0", { reset: true });
      assert.equal(lastRecord(events).record?.timing, undefined);
      const raw = JSON.parse(await readFile(join(worldDir, "productions", LEDGER, ".audiobook", "chapters", "01-neap.json"), "utf8")) as Record<string, unknown>;
      assert.equal("timing" in raw, false, "a record with none is written without the field");
    }));

  it("keeps a block's start across a new take and drops its trim", () =>
    withHarness(async ({ events, send, store }) => {
      await read(send);
      await setTiming(send, "p1.0", { start: 0.5, trim: { head: 0.1, tail: 0.2 } });
      const first = lastRecord(events).record!;
      assert.equal(first.timing?.["p1.0"]?.trim?.artifactId, first.takes["p1.0"]!.artifactId);
      // `Make again` for the block: a new take.
      await read(send, ["p1.0"]);
      const plan = await planAudiobook(store(), LEDGER, "neap", { narrator: NARRATOR });
      const record = plan.record === "unreadable" ? null : plan.record;
      assert.notEqual(record?.takes["p1.0"]?.artifactId, first.takes["p1.0"]!.artifactId);
      const bar = chapterTiming(store(), plan, "skip").bars.find((candidate) => candidate.key === "p1.0")!;
      assert.equal(bar.start, 0.5, "the start holds");
      assert.equal(bar.trim, null, "the trim belonged to the old take");
      assert.equal(bar.trimDropped, true);
      // The next write lets it go from the record.
      await setTiming(send, "p1.0", { start: 0.6 });
      assert.equal(lastRecord(events).record?.timing?.["p1.0"]?.trim, undefined);
    }));

  it("plays a reaction's take only while it is on the shelf and says what the reaction says (codex on PR 1497)", () =>
    withHarness(async ({ send, store }) => {
      await read(send);
      const plan = await planAudiobook(store(), LEDGER, "neap", { narrator: NARRATOR });
      const host = plan.blocks.find((planned) => planned.block.key === "p1.0")!.block;
      const words = (said: string) => updateAudiobook(store(), LEDGER, plan.chapter, (current) => ({
        ...current,
        reactions: { x1: { host: { key: "p1.0", textHash: audiobookTextHash(host.text) }, speaker: "narrator", words: said, offset: 0.2, by: "author", at: CLOCK } },
        takes: { ...current.takes, x1: { ...current.takes["p0.0"]!, textHash: audiobookTextHash("mm") } },
      }));
      const reaction = async () => chapterTiming(store(), await planAudiobook(store(), LEDGER, "neap", { narrator: NARRATOR }), "estimate").bars.find((bar) => bar.key === "x1")!;
      await words("mm");
      assert.equal((await reaction()).made, true);
      await words("Ehen!");
      assert.equal((await reaction()).made, false, "a take of other words is not this reaction's");
    }));

  it("refuses what the binding forbids, in one clause", () =>
    withHarness(async ({ events, send }) => {
      await read(send);
      await setTiming(send, "p999.0", { start: 0.2 });
      assert.match(lastRecord(events).refused ?? "", /no longer in the chapter/);
      await setTiming(send, "p0.0", { nudge: 0.1 });
      assert.match(lastRecord(events).refused ?? "", /one request can be nudged/);
      await setTiming(send, "p0.0", { trim: { head: 0.6, tail: 0.6 } });
      assert.match(lastRecord(events).refused ?? "", /nothing to hear/);
      await setTiming(send, "p0.0", { under: { host: "p0.0", offset: 0 } });
      assert.match(lastRecord(events).refused ?? "", /under itself/);
    }));

  it("holds a grouped request's inside to the reader under Performed", () =>
    withHarness(async ({ events, send, store }) => {
      await read(send);
      const plan = await planAudiobook(store(), LEDGER, "neap", { narrator: NARRATOR });
      // Make p0.0 and p1.0 two cuts of one request, as a grouped read files them, and read Performed.
      await updateAudiobook(store(), LEDGER, plan.chapter, (current) => ({
        ...current,
        takes: {
          ...current.takes,
          "p0.0": { ...current.takes["p0.0"]!, grouped: { request: "rq", blocks: ["p0.0", "p1.0"], packing: "deltas", offsetSec: 0, durationSec: 1 } },
          "p1.0": { ...current.takes["p1.0"]!, grouped: { request: "rq", blocks: ["p0.0", "p1.0"], packing: "deltas", offsetSec: 1, durationSec: 1 } },
        },
      }));
      await send({ kind: "set-audiobook-reading", worldId: WORLD_ID, productionId: LEDGER, reading: "performed" });
      await setTiming(send, "p1.0", { start: -0.3 });
      assert.match(lastRecord(events).refused ?? "", /the start is the reader's/);
      await setTiming(send, "p0.0", { pauseAfter: 0.3 });
      assert.match(lastRecord(events).refused ?? "", /the pause is the reader's/);
      await setTiming(send, "p1.0", { under: { host: "title", offset: 0 } });
      assert.match(lastRecord(events).refused ?? "", /the start is the reader's/, "nor taken out of the turn by playing it under another (codex on PR 1497)");
      await setTiming(send, "p0.0", { nudge: 0.05 });
      assert.equal(lastRecord(events).refused, undefined, "the cut can still be nudged");
    }));
});

describe("the mix (turn 187, R-85)", () => {
  it("renders the chapter with an interruption mixed under the line it cuts, and reuses the render", () =>
    withHarness(async ({ worldDir, events, send, store }) => {
      await read(send);
      await setTiming(send, "p1.0", { start: -0.5 });
      const render = () => send({ kind: "render-audiobook-mix", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", requestId: REQUEST });
      await render();
      const answer = events.filter((e): e is MixEvent => e.type === "audiobook.mix").at(-1)!;
      assert.equal(answer.refused, undefined);
      const plan = await planAudiobook(store(), LEDGER, "neap", { narrator: NARRATOR });
      const blocks = plan.blocks.length;
      assert.equal(answer.mix?.seconds, blocks - 0.5, "the overlap shortens the chapter by its half second");
      const pcm = readSpeechWav(new Uint8Array(await readFile(join(worldDir, answer.mix!.file))));
      assert.ok(Math.abs(pcm.samples.length / MIX_RATE - (blocks - 0.5)) < 0.01);
      // Two copies of the same tone in phase: twice as loud where they overlap (p0.0 ends at 2, p1.0 starts at 1.5).
      const peak = (from: number, to: number) => pcm.samples.slice(Math.round(from * MIX_RATE), Math.round(to * MIX_RATE)).reduce((max, s) => Math.max(max, Math.abs(s)), 0);
      assert.ok(peak(1.6, 1.9) > 1.5 * peak(1.1, 1.4), "the voices sum where they overlap");
      const made = (await stat(join(worldDir, answer.mix!.file))).mtimeMs;
      await render();
      const again = events.filter((e): e is MixEvent => e.type === "audiobook.mix").at(-1)!;
      assert.equal(again.mix?.file, answer.mix?.file);
      assert.equal((await stat(join(worldDir, answer.mix!.file))).mtimeMs, made, "the same plan is not rendered twice");
    }));

  it("says why when nothing is made", () =>
    withHarness(async ({ events, send }) => {
      await send({ kind: "render-audiobook-mix", worldId: WORLD_ID, productionId: LEDGER, chapterFile: "01-neap", requestId: REQUEST });
      assert.match(events.filter((e): e is MixEvent => e.type === "audiobook.mix").at(-1)?.refused ?? "", /nothing made/);
    }));

  it("ducks a bed under speech and fades it, and brings the whole to one loudness", async () => {
    const { worldDir } = await makeTempRoot();
    await mkdir(join(worldDir, "artifacts"), { recursive: true });
    await writeFile(join(worldDir, "artifacts", "voice.wav"), tone(2, 0.25, 220));
    await writeFile(join(worldDir, "artifacts", "bed.wav"), tone(1, 0.25, 1000));
    const mix: ChapterMix = {
      seconds: 10,
      voices: [{ key: "p0.0", at: 4, segments: [{ file: "artifacts/voice.wav", from: 0, to: 2 }] }],
      beds: [{ id: "b1", at: 0, seconds: 10, file: "artifacts/bed.wav", levelDb: -6, fadeInSec: 1, fadeOutSec: 1, duckDb: 10 }],
      sounds: [],
      speech: [{ from: 4, to: 6 }],
    };
    const pcm = await mixSamples(worldDir, mix);
    const rms = (from: number, to: number) => {
      const slice = pcm.samples.slice(Math.round(from * MIX_RATE), Math.round(to * MIX_RATE));
      return Math.sqrt(slice.reduce((sum, s) => sum + s * s, 0) / slice.length);
    };
    assert.ok(rms(0, 0.2) < rms(2, 3) / 3, "faded in");
    assert.ok(rms(9.8, 10) < rms(2, 3) / 3, "faded out");
    // The bed alone looped at 2–3 s; at 7 s it is back up after the release.
    assert.ok(Math.abs(rms(2, 3) - rms(7, 8)) / rms(2, 3) < 0.05, "the loop holds its level");
    // Loudness: the render is near the take target whatever the parts' levels were.
    const lufs = integratedLoudness(pcm)!;
    assert.ok(Math.abs(lufs - -18) < 1.5, `one loudness after the mix: ${lufs}`);

    // The duck heard alone: a silent voice over the same bed, so all that sounds is the bed.
    await writeFile(join(worldDir, "artifacts", "silence.wav"), tone(2, 0));
    const bedOnly = await mixSamples(worldDir, { ...mix, voices: [{ key: "p0.0", at: 4, segments: [{ file: "artifacts/silence.wav", from: 0, to: 2 }] }] });
    const level = (from: number, to: number) => {
      const slice = bedOnly.samples.slice(Math.round(from * MIX_RATE), Math.round(to * MIX_RATE));
      return Math.sqrt(slice.reduce((sum, s) => sum + s * s, 0) / slice.length);
    };
    const ratio = 20 * Math.log10(level(4.5, 5.5) / level(2, 3));
    assert.ok(Math.abs(ratio - -10) < 0.5, `ducked 10 dB under speech: ${ratio}`);
    assert.ok(level(3.5, 3.8) > level(4.5, 5.5) * 2, "not yet down well before the voice");
  });

  it("reads no audio from outside the world (codex on PR 1497)", async () => {
    const { root, worldDir } = await makeTempRoot();
    await writeFile(join(root, "private.wav"), tone(1));
    const mix: ChapterMix = { seconds: 1, voices: [{ key: "p0.0", at: 0, segments: [{ file: "../private.wav", from: 0, to: 1 }] }], beds: [], sounds: [], speech: [{ from: 0, to: 1 }] };
    await assert.rejects(mixSamples(worldDir, mix), /not in this world/);
  });

  it("runs on to a sound's own end, and never reads a sound after a window (codex on PR 1497)", async () => {
    const { worldDir } = await makeTempRoot();
    await mkdir(join(worldDir, "artifacts"), { recursive: true });
    await writeFile(join(worldDir, "artifacts", "voice.wav"), tone(1));
    await writeFile(join(worldDir, "artifacts", "door.wav"), tone(2, 0.2, 500));
    const voice = { key: "p0.0", at: 0, segments: [{ file: "artifacts/voice.wav", from: 0, to: 1 }] };
    // The plan says nothing of the door's length: it ends with the voice, at one second.
    const trailing: ChapterMix = { seconds: 1, voices: [voice], beds: [], sounds: [{ id: "s1", at: 0.5, file: "artifacts/door.wav", levelDb: -6 }], speech: [{ from: 0, to: 1 }] };
    const pcm = await mixSamples(worldDir, trailing);
    assert.ok(Math.abs(pcm.samples.length / MIX_RATE - 2.5) < 0.01, "the sound plays to its end");
    const rendered = await renderChapterMix(worldDir, LEDGER, "01-neap", trailing);
    assert.equal(rendered.seconds, 2.5);
    assert.equal((await renderChapterMix(worldDir, LEDGER, "01-neap", trailing)).seconds, 2.5, "and a kept render says so too");
    // A window over the voice alone: a later sound whose file is gone does not refuse it.
    const later: ChapterMix = { seconds: 10, voices: [voice], beds: [], sounds: [{ id: "s2", at: 8, file: "artifacts/gone.wav", levelDb: -6 }], speech: [{ from: 0, to: 1 }] };
    const window = await mixSamples(worldDir, later, { window: { from: 0, to: 1 } });
    assert.equal(window.samples.length, MIX_RATE);
  });

  it("names a window's render apart from the chapter's", async () => {
    const { worldDir } = await makeTempRoot();
    await mkdir(join(worldDir, "artifacts"), { recursive: true });
    await writeFile(join(worldDir, "artifacts", "voice.wav"), tone(2));
    const mix: ChapterMix = { seconds: 4, voices: [{ key: "p0.0", at: 0, segments: [{ file: "artifacts/voice.wav", from: 0, to: 2 }] }, { key: "p1.0", at: 2, segments: [{ file: "artifacts/voice.wav", from: 0, to: 2 }] }], beds: [], sounds: [], speech: [{ from: 0, to: 4 }] };
    const whole = await renderChapterMix(worldDir, LEDGER, "01-neap", mix);
    const window = await renderChapterMix(worldDir, LEDGER, "01-neap", mix, { window: { from: 1, to: 3 } });
    assert.notEqual(whole.file, window.file);
    assert.equal(window.from, 1);
    assert.equal(window.seconds, 2);
    assert.ok(whole.file.startsWith(".cache/audiobook-mix/"), "kept in the world's cache, never beside its records");
  });
});
