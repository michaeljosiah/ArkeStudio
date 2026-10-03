import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ChapterAudiobookSchema,
  GOOGLE_FREE_LIMIT,
  soloTurns,
  SPLIT_DID_NOT_MATCH,
  type AudiobookReader,
  type Job,
  type ManifestModel,
  type SpeechTurn,
  type VoiceCandidate,
} from "@arke-studio/contracts";
import { geminiSpeechModel } from "@arke-studio/providers";
import { integratedLoudness, normaliseSpeech, readSpeechWav, trimSpeech, writeSpeechWav, type SpeechPcm } from "../../src/audio/speech-wav.js";
import { judgeSplit, splitRequest } from "../../src/productions/audiobook-split.js";
import { keepSplitTake, prepareChapter, readBreaks, runAudiobookChapter, type AudiobookRunEvent } from "../../src/productions/audiobook-run.js";
import { directionEntry, planAudiobook, writeAudiobookBookRaised, writeBlockDirection } from "../../src/productions/audiobook.js";
import { directionPlan } from "../../src/voice/direction.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { speechStretches, timeWords, type TimedWord } from "../../src/voice/word-times.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Grouped reads (design turn 185): a chapter's blocks sent a few requests at a time and split
 * back into takes on this machine — cut at the pauses, checked against the words, gained to one
 * loudness, priced and counted as requests.
 */
const RATE = 24_000;
const tone = (seconds: number, amplitude: number) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amplitude * Math.sin((2 * Math.PI * 1000 * i) / RATE));
const silence = (seconds: number) => new Float32Array(Math.round(seconds * RATE));
const join_ = (...parts: Float32Array[]): SpeechPcm => {
  const samples = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    samples.set(part, at);
    at += part.length;
  }
  return { rate: RATE, samples };
};

describe("one loudness (design turn 185)", () => {
  it("measures a tone as BS.1770 does and brings it to −18 LUFS under the peak ceiling", () => {
    // A 1 kHz sine at amplitude 0.1 is −20 dBFS peak, −23.01 LUFS.
    const quiet = join_(tone(3, 0.1));
    assert.ok(Math.abs(integratedLoudness(quiet)! + 23.01) < 0.3);
    const normal = normaliseSpeech(quiet);
    assert.ok(Math.abs(integratedLoudness(normal.pcm)! + 18) < 0.3);
    assert.ok(normal.loudness.gainDb > 4.5 && normal.loudness.gainDb < 5.5);
    // A loud tone is held under the ceiling rather than pushed to the target.
    const loud = normaliseSpeech(join_(tone(3, 0.95)));
    assert.ok(loud.loudness.peakDbfs! <= -1.4);
    assert.deepEqual(normaliseSpeech(join_(silence(1))).loudness, { integratedLufs: null, gainDb: 0, peakDbfs: null });
  });

  it("trims a take read alone to a grouped take's pause, and round-trips a WAV", () => {
    const padded = join_(silence(2), tone(1, 0.3), silence(2));
    const trimmed = trimSpeech(padded);
    assert.ok(Math.abs(trimmed.samples.length / RATE - 1.5) < 0.05);
    const again = readSpeechWav(writeSpeechWav(trimmed));
    assert.equal(again.rate, RATE);
    assert.equal(again.samples.length, trimmed.samples.length);
  });
});

describe("word times and the split (design turn 185)", () => {
  it("finds each stretch between pauses and spreads its words across it", async () => {
    const pcm = join_(silence(0.3), tone(1, 0.3), silence(0.5), tone(0.8, 0.3), silence(0.5), tone(1.2, 0.3), silence(0.3));
    assert.equal(speechStretches(pcm).length, 3);
    const heard = ["First block here.", "A line.", "The last block, longer."];
    let call = 0;
    const timed = await timeWords(writeSpeechWav(pcm), async () => heard[call++]!);
    assert.equal(timed.words.length, 9);
    assert.ok(Math.abs(timed.seconds - 4.6) < 0.01);
    assert.ok(timed.words[3]!.start >= 1.79 && timed.words[3]!.start <= 1.81, "the second stretch begins after the pause");
  });

  it("cuts each block at the middle of the pause between its last word and the next block's first", () => {
    const words: TimedWord[] = [
      { text: "Tunde", start: 0.2, end: 0.6 }, { text: "laughed.", start: 0.6, end: 1.0 },
      { text: "“It", start: 1.6, end: 1.8 }, { text: "is", start: 1.8, end: 1.9 }, { text: "not", start: 1.9, end: 2.1 }, { text: "possible,”", start: 2.1, end: 2.6 },
      { text: "Ade", start: 3.0, end: 3.3 }, { text: "said.", start: 3.3, end: 3.6 },
    ];
    const blocks = [{ key: "p0.0", text: "Tunde laughed." }, { key: "p1.0", text: "“It is not possible,”" }, { key: "p1.1", text: "Ade said." }];
    const cuts = splitRequest(blocks, words, 4, () => `sha256:${"a".repeat(64)}`);
    assert.deepEqual(cuts.map((cut) => [cut.start, cut.end]), [[0, 1.3], [1.3, 2.8], [2.8, 4]]);
    assert.ok(cuts.every((cut) => cut.matched));
    assert.equal(cuts[1]!.heard, "“It is not possible,”");
  });

  it("flags a cut with a word left out, and passes a short mishearing of a name", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    assert.equal(judgeSplit("a sound behind his left shoulder, close", "a sound behind his shoulder close", hash).matched, false);
    assert.equal(judgeSplit("Olorun mi. Did you hear yourself?", "Oloroon me, did you hear yourself", hash).matched, true);
    assert.equal(judgeSplit("It is not possible.", "it's not possible", hash).matched, true, "a contraction is the same words written as whisper writes them");
  });
});

// ---- the run ----------------------------------------------------------------------------------

const LEDGER = "the-ledger-of-nights";
const GROUPABLE: ManifestModel = (() => {
  const row = geminiSpeechModel("flash");
  return { ...row, cadence: { ...row.cadence!, groupable: true } };
})();
const READER: AudiobookReader = { provider: "google", model: GROUPABLE.id, voiceId: "Kore", label: "Kore" };
const KORE: VoiceCandidate = { provider: "google", model: GROUPABLE.id, voiceId: "Kore", label: "Kore", attributes: [], local: false, canClone: false };

async function world(): Promise<{ store: WorldStore; close: () => Promise<void>; worldDir: string }> {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => "2026-10-03T09:00:00.000Z" });
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore!()!;
  return { store, worldDir, close: () => provider.close() };
}

interface RunHarness {
  events: AudiobookRunEvent[];
  sent: EnqueueInput[];
  run: (extra?: { confirmationToken?: string; only?: string[] }) => Promise<void>;
}

async function harness(store: WorldStore, opts: { heardFor?: (text: string) => string; fail?: string; actual?: number } = {}): Promise<RunHarness> {
  const plan = await planAudiobook(store, LEDGER, "neap", { narrator: READER });
  const textOf = new Map(plan.blocks.map((planned) => [planned.block.key, planned.block.text.replace(/\s+/g, " ").trim()]));
  const events: AudiobookRunEvent[] = [];
  const sent: EnqueueInput[] = [];
  const jobs = new Map<string, Job>();
  // What the transcriber hears next: each stretch of the latest request is a block's words.
  let heard: string[] = [];
  const run = (extra: { confirmationToken?: string; only?: string[] } = {}) =>
    runAudiobookChapter({
      store,
      worldId: WORLD_ID,
      productionId: LEDGER,
      chapterId: "neap",
      models: [GROUPABLE],
      narrator: READER,
      catalogue: [KORE],
      signal: new AbortController().signal,
      ...(extra.confirmationToken !== undefined ? { confirmationToken: extra.confirmationToken } : {}),
      ...(extra.only !== undefined ? { only: extra.only } : {}),
      requireUploadConfirmation: () => false,
      localSpeech: async () => { throw new Error("cloud only"); },
      synthesizeLocal: async () => { throw new Error("cloud only"); },
      enqueue: async (inputs) => {
        const input = inputs[0]!;
        sent.push(input);
        const keys = (input.params["blocks"] as string[] | undefined) ?? [String(input.params["block"])];
        // A second of speech a block, half a second of pause between.
        const pcm = join_(...keys.flatMap((key, index) => [...(index > 0 ? [silence(0.5)] : [silence(0.2)]), tone(1, 0.2)]), silence(0.2));
        const file = `${input.landing!.dir}/${input.landing!.name}`;
        await mkdir(join(store.dir, dirname(file)), { recursive: true });
        await writeFile(join(store.dir, file), writeSpeechWav(pcm));
        heard = keys.map((key) => (opts.heardFor ?? ((text: string) => text))(textOf.get(key)!));
        const id = `jb_01J8G00000000000000000000${sent.length}`;
        jobs.set(id, (opts.fail !== undefined
          ? { id, status: "failed", error: opts.fail, estimatedMicroUsd: input.estimatedMicroUsd, landedFiles: [] }
          : { id, status: "succeeded", landedFiles: [file], estimatedMicroUsd: input.estimatedMicroUsd }) as unknown as Job);
        return { jobIds: [id] };
      },
      waitForJob: async (id) => jobs.get(id)!,
      cancelJob: async () => {},
      findJobs: () => [],
      actualCost: async () => opts.actual ?? 1_000,
      wordTimes: (wav) => {
        let call = 0;
        return timeWords(wav, async () => heard[call++] ?? "");
      },
      emit: (event) => events.push(event),
      now: () => "2026-10-03T09:00:00.000Z",
    });
  return { events, sent, run };
}

const recordOf = async (worldDir: string) => ChapterAudiobookSchema.parse(JSON.parse(await readFile(join(worldDir, "productions", LEDGER, ".audiobook", "chapters", "01-neap.json"), "utf8")));
const priced = (events: AudiobookRunEvent[]) => events.find((event): event is Extract<AudiobookRunEvent, { type: "priced" }> => event.type === "priced");
const finished = (events: AudiobookRunEvent[]) => events.find((event): event is Extract<AudiobookRunEvent, { type: "finished" }> => event.type === "finished");

describe("a chapter read grouped (design turn 185)", () => {
  it("prices the chapter as requests, reads it as one request of turns, and files every block's cut as its take", async () => {
    const { store, worldDir, close } = await world();
    try {
      const h = await harness(store, { actual: 1_001 });
      await h.run();
      const card = priced(h.events);
      assert.ok(card, "a priced reader asks first");
      const prepared = await prepareChapter(store, LEDGER, "neap", { narrator: READER, models: [GROUPABLE], catalogue: [KORE], transcriber: true }, () => "2026-10-03T09:00:00.000Z");
      assert.equal(prepared.kind, "ready");
      if (prepared.kind !== "ready") return;
      const blocks = prepared.prepared.toMake.length;
      assert.equal(card.requests, 1, "the whole chapter fits one request");
      assert.equal(card.perParagraph, blocks);
      assert.equal(h.sent.length, 0, "nothing sent before the answer");
      await h.run({ confirmationToken: card.confirmationToken });
      assert.equal(h.sent.length, 1, "one request for every block");
      const turns = h.sent[0]!.params["turns"] as SpeechTurn[];
      assert.equal(h.sent[0]!.params["text"], turns.map((turn) => turn.text).join(" "));
      assert.equal(finished(h.events)?.outcome, "read", finished(h.events)?.reason);
      const started = h.events.filter((event) => event.type === "started").at(-1) as Extract<AudiobookRunEvent, { type: "started" }>;
      assert.equal(started.requests, 1);
      assert.equal(started.groups?.[0]?.length, blocks);
      const record = await recordOf(worldDir);
      const takes = Object.values(record.takes);
      assert.equal(takes.length, blocks);
      assert.equal(Object.keys(record.flags).length, 0);
      assert.ok(takes.every((take) => take.grouped?.request === "jb_01J8G000000000000000000001" && take.grouped.blocks.length === blocks && take.loudness !== undefined));
      assert.equal(takes.reduce((sum, take) => sum + (take.costMicroUsd ?? 0), 0), 1_001, "the request's actual, shared by characters");
      assert.equal(takes.reduce((sum, take) => sum + take.estimatedMicroUsd, 0), h.sent[0]!.estimatedMicroUsd);
      // Each block's direction is its own: a take made grouped is current, never stale for how it was read.
      const plan = await planAudiobook(store, LEDGER, "neap", { narrator: READER });
      assert.deepEqual(plan.blocks.map((planned) => planned.state), plan.blocks.map(() => "made"), JSON.stringify([...plan.present, store.getBundle().artifacts.map((a) => a.id)]));
      // Cuts follow one another through the request with nothing between them.
      const ordered = takes.map((take) => take.grouped!).sort((a, b) => a.offsetSec - b.offsetSec);
      for (let i = 1; i < ordered.length; i++) assert.ok(Math.abs(ordered[i]!.offsetSec - (ordered[i - 1]!.offsetSec + ordered[i - 1]!.durationSec)) < 0.002);
    } finally {
      await close();
    }
  });

  it("flags a cut that did not match with what was heard, and the author's Keep makes it the take", async () => {
    const { store, worldDir, close } = await world();
    try {
      const h = await harness(store, { heardFor: (text) => (text.startsWith("Maren reads that twice") ? text.replace(" twice", "") : text) });
      await h.run();
      await h.run({ confirmationToken: priced(h.events)!.confirmationToken });
      const record = await recordOf(worldDir);
      const flagged = Object.entries(record.flags);
      assert.equal(flagged.length, 1);
      const [key, flag] = flagged[0]!;
      assert.ok(flag.reason.startsWith(SPLIT_DID_NOT_MATCH));
      assert.ok(flag.split?.heard.startsWith("Maren reads that. Then"));
      assert.equal(record.takes[key], undefined, "kept only if the author keeps it");
      await store.reload();
      const kept = await keepSplitTake(store, LEDGER, "neap", key, READER, () => "2026-10-03T09:05:00.000Z");
      assert.equal(kept.takes[key]?.artifactId, flag.split!.artifactId);
      assert.equal(kept.flags[key], undefined);
    } finally {
      await close();
    }
  });

  it("stops at a refusal for the day with the request's blocks unread, to be grouped again next press", async () => {
    const { store, worldDir, close } = await world();
    try {
      const h = await harness(store, { fail: `${GOOGLE_FREE_LIMIT} (HTTP 429 free daily quota · 10 a day)` });
      await h.run();
      await h.run({ confirmationToken: priced(h.events)!.confirmationToken });
      const end = finished(h.events);
      assert.equal(end?.outcome, "failed");
      assert.match(end?.reason ?? "", /free limit/);
      const record = await recordOf(worldDir).catch(() => null);
      assert.equal(Object.keys(record?.flags ?? {}).length, 0, "no block is flagged");
      assert.equal(Object.keys(record?.takes ?? {}).length, 0);
    } finally {
      await close();
    }
  });

  it("reads a single block again with its neighbours in one request, keeping only the middle cut", async () => {
    const { store, worldDir, close } = await world();
    try {
      const plan = await planAudiobook(store, LEDGER, "neap", { narrator: READER });
      const middle = plan.blocks[2]!.block.key;
      const h = await harness(store);
      await h.run({ only: [middle] });
      const card = priced(h.events)!;
      assert.equal(card.requests, 1);
      await h.run({ only: [middle], confirmationToken: card.confirmationToken });
      assert.deepEqual(h.sent[0]!.params["blocks"], [plan.blocks[1]!.block.key, middle, plan.blocks[3]!.block.key]);
      const record = await recordOf(worldDir);
      assert.deepEqual(Object.keys(record.takes), [middle]);
      assert.equal(record.takes[middle]?.costMicroUsd, 1_000, "the request is the kept block's");
    } finally {
      await close();
    }
  });

  it("sends each block's turn with exactly the style a solo read sends, the notes once and its own direction after", async () => {
    const { store, close } = await world();
    try {
      await writeAudiobookBookRaised(store, LEDGER, { schemaVersion: 1, reading: "narrator", note: "Coastal English, unhurried.", chapterNotes: { neap: "Night at the rail desk." } });
      const plan = await planAudiobook(store, LEDGER, "neap", { narrator: READER });
      const directed = plan.blocks[2]!.block;
      await writeBlockDirection(store, LEDGER, plan.chapter, plan.blocks.map((planned) => planned.block), directed.key, directionEntry(directed.text, directionPlan(directed.text, { delivery: "whispered", speed: 1, cues: [] }), "2026-10-03T09:00:00.000Z"));
      const prepared = await prepareChapter(store, LEDGER, "neap", { narrator: READER, models: [GROUPABLE], catalogue: [KORE], transcriber: true }, () => "2026-10-03T09:00:00.000Z");
      assert.equal(prepared.kind, "ready");
      if (prepared.kind !== "ready") return;
      for (const block of prepared.prepared.speaking) {
        const solo = soloTurns(block.turns);
        assert.deepEqual(solo.map((turn) => turn.text), block.parts, "the words a solo read sends");
        assert.deepEqual(solo.map((turn) => turn.instructions), block.parts.map((_, index) => block.direction?.perPart[index]?.instructions ?? block.direction?.instructions), "and its whole style");
        assert.equal(block.turns.shared, "Coastal English, unhurried. Night at the rail desk.");
      }
      const group = prepared.prepared.groups[0]!;
      assert.equal(group.turns[0]!.instructions, "Coastal English, unhurried. Night at the rail desk.", "the notes on the first turn");
      assert.ok(group.turns.slice(1).every((turn) => !turn.instructions?.includes("Coastal English")), "and never again");
      assert.ok(group.turns.some((turn) => turn.instructions === geminiSpeechModel("flash").cadence!.deliveryMappings["whispered"]!.instruction), "the directed block carries its own delivery alone");
    } finally {
      await close();
    }
  });

  it("closes requests at a scene break or the end of a narration paragraph only", async () => {
    const { store, close } = await world();
    try {
      const plan = await planAudiobook(store, LEDGER, "neap", { narrator: READER });
      const breaks = readBreaks(plan);
      assert.equal(breaks.get("title"), "scene");
      assert.equal(breaks.get(plan.blocks.at(-1)!.block.key), "scene");
      assert.ok(plan.blocks.slice(1, -1).every((planned) => breaks.get(planned.block.key) === "paragraph"), "the fixture's paragraphs are narration alone");
    } finally {
      await close();
    }
  });
});

