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
import { dropRunawayTail, integratedLoudness, normaliseSpeech, readSpeechWav, trimSpeech, writeSpeechWav, type SpeechPcm } from "../../src/audio/speech-wav.js";
import { judgeSplit, LONG_TAIL, splitAudio, splitLexicon, splitRequest } from "../../src/productions/audiobook-split.js";
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

/**
 * What whisper heard of chapter 01 of Na Love or Juju, read grouped on 2026-10-03 (Gemini Flash
 * TTS, Ife's designed voice, `deltas`): 38 of 169 blocks flagged, nearly all a name, Yoruba or
 * Pidgin heard as English. Each pair is the written block and the words heard in its cut.
 */
const NA_LOVE: Array<[string, string]> = [
  ["Tunde was telling the goat story again.", "Sunday was telling the good story again."],
  ["“Ade, I am telling you. The goat looked at me like this —”", "Addy. I am telling you. The goats looked at me like this."],
  ["Tunde said, when the goat had finally been delivered to its owner in Ilesha.", "tunede said. when the good had finally been delivered to its owner in Elesha."],
  [
    "Ade had been in the car the first time it happened, on the Ibadan expressway in 2004, and he had heard it told since at two weddings, one naming ceremony and Tunde's fortieth, and every time the goat grew larger and the customs officer more corrupt and Tunde's cousin from Ilesha more heroic. Tonight the goat had learned to open doors.",
    "I did, I'd been in the car the first time it happened. on the Battle Express Wing 2004. and he had had it told since at two weddings. One name is Sarimune and two days 40 f. and every time they go to grow larger. and the customs office are more corrupt. and soon this causing for me, less sha, more heroic. tonight. The ghost had learnt to open doors.",
  ],
  ["“Ah, the bar. Yes. The bar is very fine tonight. The bar's leg is long.”", "Ah. Bye! Yes. The bye is very fine tonight. The last leg is long."],
  ["“I'm just admiring the bar with you, Ade. Is it a crime?”", "I'm just admiring the bow with you, ID. Is it a crime?"],
  ["Ade picked up his glass, put it down again without drinking from it, and looked.", "A day pick-top is glass. put it down again without drinking from it. and looked."],
  ["Tunde stared at him. Then he put a hand flat on the table and laughed until he coughed.", "to this dead atom. then he put a hand flat on the table and laughed until he coughed."],
  [
    "“Olorun mi. Did you hear yourself? 'She is very beautiful.' Like a weather report. Adeyemi Akinola, abeg, go and greet her before I die of shame on your behalf.”",
    "Ooh, Laura, me. Did you hear yourself? She is very beautiful. like a weather report. a te yemi aki no la, a big goangrita. before I die of shame on your behalf.",
  ],
  ["He did not know what to do with that, so he laughed. She watched him laugh. It seemed to interest her more than anything he had said.", "He did not know. What to do. with that. He laughed. She watched him laugh. It seemed to interest her more than... anything. He had said."],
  ["Tunde settled into his seat with immense satisfaction and closed his eyes.", "Two days settled into his seat with immense satisfaction and close to his eyes."],
  ["He dropped Tunde at his gate in Lekki Phase One. Tunde leaned back in through the passenger window before he went.", "He dropped Twinde at his gate. in Lucky Phase 1. Tunde leaned back in through the passenger window before he went."],
  [
    "Ade drove back alone. On the bridge the lights went blue, violet, blue, and the lagoon on either side was so dark it might not have been there at all. The phone lay face up in the cupholder. Then Ikoyi: the quiet streets, the high walls, the gates shut for the night.",
    "Adejov Bakalon. On the bridge the lights went blue. violate blue. and the lagoon on either side was so dark it might not have been there at all. the phone leave face up in the cup holder. (speaking in foreign language) the quiet streets. the high walls. the gates shot for the night.",
  ],
  ["“Ehen,”", "Uh-huh."],
  ["said Tunde.", "Saitundi."],
];
const NAMES = splitLexicon(["Adeyemi \"Ade\" Akinola", "Tunde", "Ife", "Ade's House, Ikoyi"], ["They drove to Ilesha and on to Lekki Phase One, past Ozumba Mbadiwe."]);

describe("names and words not in English (2026-10-03)", () => {
  const hash = `sha256:${"a".repeat(64)}`;

  it("passes a cut whose words whisper misheard as English, as it heard chapter 01", () => {
    const flagged = NA_LOVE.filter(([written, heard]) => !judgeSplit(written, heard, hash, { lexicon: NAMES }).matched);
    assert.deepEqual(flagged, [], "every pair is its block, misheard");
  });

  it("sets aside whisper's notes, and a sound's “uh-huh” where the direction makes one", () => {
    assert.equal(judgeSplit("He laughed until he coughed.", "*laughs* He laughed until he coughed.", hash).matched, true);
    assert.equal(judgeSplit("“No.”", "Haha. Uh-huh. Hmm. Ah. No.", hash).matched, false);
    assert.equal(judgeSplit("“No.”", "Haha. Uh-huh. Hmm. Ah. No.", hash, { sounds: true }).matched, true);
  });

  it("still flags a cut in the wrong place: its last sentence or its first missing, or the block beside's words in it", () => {
    const stared = "Tunde stared at him. Then he put a hand flat on the table and laughed until he coughed.";
    assert.equal(judgeSplit(stared, "to this dead atom. then he put a hand flat on the table.", hash, { lexicon: NAMES }).matched, false, "its last words are missing");
    assert.equal(judgeSplit("He sat. Her friends had found somewhere else to look.", "her friends had found somewhere else to look.", hash, { lexicon: NAMES }).matched, false, "its first sentence is missing");
    const sit = "“Sit, if you are going to stand there.”";
    const heardSit = "Sit. if you are going to stand there. He's sad.";
    assert.equal(judgeSplit(sit, heardSit, hash, { lexicon: NAMES }).matched, true, "alone, a hallucinated tail is cheap");
    assert.equal(judgeSplit(sit, heardSit, hash, { lexicon: NAMES, after: "He sat. Her friends had found somewhere else to look." }).matched, false, "it is the next block's opening words");
    const kneels = "“E don finally happen. I will tell your mother myself. I want to see her face. I want to be there when she kneels down.”";
    const heardKneels = "it don't finally happen. I will tell your mother myself, I want to see her face. I want to be there when she kneels down. at a draw.";
    assert.equal(judgeSplit(kneels, heardKneels, hash, { lexicon: NAMES, after: "Ade drove. Ozumba Mbadiwe was nearly empty at this hour." }).matched, false);
    assert.equal(judgeSplit("“Goodnight, palm tree.”", "Good night, Tundi. Goodnight, palm tree.", hash, { lexicon: NAMES, before: "“Goodnight, Tunde.”" }).matched, false, "it opens with the block before");
    // A misheard first word that only reads like the block before is the block's own.
    assert.equal(judgeSplit(NA_LOVE[0]![0], NA_LOVE[0]![1], hash, { lexicon: NAMES, before: "Chapter 1 · Sunday" }).matched, true);
  });

  /** Words spoken in stretches, 0.06 s a letter, with 0.4 s of pause between stretches. */
  const speak = (...stretches: string[]): { words: TimedWord[]; seconds: number } => {
    const words: TimedWord[] = [];
    let at = 0.2;
    for (const stretch of stretches) {
      for (const text of stretch.split(" ")) {
        words.push({ text, start: at, end: at + 0.06 * text.length });
        at += 0.06 * text.length;
      }
      at += 0.4;
    }
    return { words, seconds: at };
  };

  it("gives a block whose every word was misheard its own cut, rather than none", () => {
    // The 2026-10-03 read cut “Ehen,” and said Tunde. to nothing, and "What?" heard all three.
    const blocks = [{ key: "p17.0", text: "Ade could not help it." }, { key: "p18.0", text: "“Ehen,”" }, { key: "p18.1", text: "said Tunde." }, { key: "p19.0", text: "“What?”" }];
    const heard = speak("Ade could not help it.", "Uh-huh.", "Saitundi.", "What?");
    const cuts = splitRequest(blocks, heard.words, heard.seconds, () => hash, undefined, NAMES);
    assert.deepEqual(cuts.map((cut) => cut.heard), ["Ade could not help it.", "Uh-huh.", "Saitundi.", "What?"]);
    assert.ok(cuts.every((cut) => cut.matched && cut.end > cut.start), JSON.stringify(cuts.map((cut) => [cut.key, cut.start, cut.end, cut.matched])));
  });

  it("keeps a word heard as two, and a misheard name, on its own side of a boundary", () => {
    const night = [{ key: "p80.0", text: "Then she looked at him." }, { key: "p81.0", text: "“Goodnight, Ade.”" }, { key: "p82.0", text: "“Goodnight.”" }];
    const heardNight = speak("then she looked at him.", "Good night, Adi.", "Good night.");
    const nightCuts = splitRequest(night, heardNight.words, heardNight.seconds, () => hash, undefined, NAMES);
    assert.deepEqual(nightCuts.map((cut) => cut.heard), ["then she looked at him.", "Good night, Adi.", "Good night."]);
    assert.ok(nightCuts.every((cut) => cut.matched));
    const sat = [{ key: "p43.1", text: "“Sit, if you are going to stand there.”" }, { key: "p44.0", text: "He sat. Her friends had found somewhere else to look." }];
    const heardSat = speak("Sit. if you are going to stand there.", "He's sad.", "her friends had found somewhere else to look.");
    const satCuts = splitRequest(sat, heardSat.words, heardSat.seconds, () => hash, undefined, NAMES);
    assert.deepEqual(satCuts.map((cut) => cut.heard), ["Sit. if you are going to stand there.", "He's sad. her friends had found somewhere else to look."]);
    assert.ok(satCuts.every((cut) => cut.matched));
  });

  it("builds the lexicon from the world's names and the chapter's capitalised words", () => {
    assert.ok(["ade", "adeyemi", "akinola", "tunde", "ife", "ikoyi", "ilesha", "lekki", "ozumba", "mbadiwe"].every((token) => NAMES.has(token)), [...NAMES].join(" "));
    assert.ok(!NAMES.has("they") && !NAMES.has("i") && !NAMES.has("the"));
  });
});

/** A runaway nonverbal tail as the turn 185 probe's merged request had one: 0.1 s blips every 0.7 s. */
const blips = (seconds: number) => join_(...Array.from({ length: Math.round(seconds / 0.7) }, () => [tone(0.1, 0.3), silence(0.6)]).flat()).samples;

/** A transcriber that hears the next block's words in a stretch of speech, and nothing in a run of blips. */
const hearsSpeech = (texts: string[]) => {
  let next = 0;
  return async (bytes: Uint8Array) => {
    const piece = readSpeechWav(bytes);
    let squares = 0;
    for (const sample of piece.samples) squares += sample * sample;
    return Math.sqrt(squares / piece.samples.length) > 0.12 ? texts[next++] ?? "" : "";
  };
};

describe("a request that runs on past its words (design turn 185 follow-up)", () => {
  const hash = () => `sha256:${"a".repeat(64)}`;
  const blocks = [{ key: "p0.0", text: "First block here." }, { key: "p1.0", text: "A line." }, { key: "p1.1", text: "The last block, longer." }];

  it("ends the last block's cut in the pause after its words, and drops the tail", async () => {
    // Speech ends at 4.9 s; then 26 s of blips.
    const pcm = join_(silence(0.3), tone(1, 0.3), silence(0.5), tone(1.2, 0.3), silence(0.5), tone(1.4, 0.3), silence(0.6), blips(26));
    const stretches = speechStretches(pcm);
    assert.ok(Math.abs(stretches[2]!.end - 4.9) < 0.02, `the last words' stretch ends with them, not at ${stretches[2]!.end}`);
    const timed = await timeWords(writeSpeechWav(pcm), hearsSpeech(blocks.map((block) => block.text)));
    const cuts = splitRequest(blocks, timed.words, timed.seconds, hash, splitAudio(pcm));
    assert.ok(cuts.every((cut) => cut.matched), JSON.stringify(cuts.map((cut) => cut.heard)));
    const last = cuts.at(-1)!;
    assert.ok(last.end >= 4.9 && last.end <= 4.9 + 0.8, `the last cut ends at ${last.end}`);
    assert.ok(cuts.every((cut) => cut.longTail), "the request ran long, said on every cut");
    // Without the audio the cut runs to the end, as before.
    assert.equal(splitRequest(blocks, timed.words, timed.seconds, hash).at(-1)!.end, timed.seconds);
  });

  it("holds at most 0.8 s of the quiet after the last words", () => {
    const pcm = join_(silence(0.3), tone(1, 0.3), silence(0.5), tone(1.2, 0.3), silence(0.5), tone(1.4, 0.3), silence(4));
    const words: TimedWord[] = [
      { text: "First", start: 0.3, end: 0.6 }, { text: "block", start: 0.6, end: 0.9 }, { text: "here.", start: 0.9, end: 1.3 },
      { text: "A", start: 1.8, end: 2.2 }, { text: "line.", start: 2.2, end: 3.0 },
      { text: "The", start: 3.5, end: 3.8 }, { text: "last", start: 3.8, end: 4.1 }, { text: "block,", start: 4.1, end: 4.5 }, { text: "longer.", start: 4.5, end: 4.9 },
    ];
    const cuts = splitRequest(blocks, words, 8.9, hash, splitAudio(pcm));
    assert.ok(Math.abs(cuts.at(-1)!.end - 5.7) < 0.02, `ends at ${cuts.at(-1)!.end}`);
    assert.ok(cuts.every((cut) => cut.matched && cut.longTail === undefined));
  });

  it("keeps a last word heard as something else inside the cut", () => {
    const pcm = join_(silence(0.3), tone(1, 0.3), silence(0.5), tone(1.2, 0.3), silence(0.5), tone(0.9, 0.3), silence(0.3), tone(0.4, 0.3), silence(2));
    const words: TimedWord[] = [
      { text: "First", start: 0.3, end: 0.6 }, { text: "block", start: 0.6, end: 0.9 }, { text: "here.", start: 0.9, end: 1.3 },
      { text: "A", start: 1.8, end: 2.2 }, { text: "line.", start: 2.2, end: 3.0 },
      { text: "The", start: 3.5, end: 3.8 }, { text: "last", start: 3.8, end: 4.1 }, { text: "block,", start: 4.1, end: 4.4 }, { text: "lunger.", start: 4.7, end: 5.1 },
    ];
    const last = splitRequest(blocks, words, 7.1, hash, splitAudio(pcm)).at(-1)!;
    assert.ok(last.end > 5.1, `the misheard last word stays: ends at ${last.end}`);
    assert.equal(last.heard, "The last block, lunger.");
  });

  it("holds the block a long stretch inside the request belongs to", async () => {
    // The blips lie between the first block and the second, and what is kept still runs long.
    const pcm = join_(silence(0.3), tone(1, 0.3), silence(0.6), blips(26), tone(1.2, 0.3), silence(0.5), tone(1.4, 0.3), silence(0.3));
    const timed = await timeWords(writeSpeechWav(pcm), hearsSpeech(blocks.map((block) => block.text)));
    const cuts = splitRequest(blocks, timed.words, timed.seconds, hash, splitAudio(pcm));
    assert.ok(cuts.every((cut) => cut.longTail));
    const held = cuts.filter((cut) => !cut.matched).map((cut) => cut.key);
    assert.equal(held.length, 1, JSON.stringify(cuts.map((cut) => [cut.key, cut.start, cut.end, cut.matched])));
    assert.ok(["p0.0", "p1.0"].includes(held[0]!));
  });

  it("drops a runaway tail from a take read alone, and leaves a last short word or a breath", () => {
    const tailed = join_(silence(0.2), tone(2, 0.3), silence(0.6), blips(10));
    assert.ok(Math.abs(dropRunawayTail(tailed).samples.length / RATE - 2.5) < 0.02);
    assert.ok(Math.abs(trimSpeech(tailed).samples.length / RATE - 2.45) < 0.02);
    const words = join_(tone(2, 0.3), silence(0.4), tone(0.3, 0.3), silence(0.4), tone(0.3, 0.3), silence(0.4), tone(0.3, 0.3), silence(0.5));
    assert.equal(dropRunawayTail(words), words);
    const breath = join_(tone(2, 0.3), silence(0.6), tone(0.1, 0.3), silence(0.3));
    assert.equal(dropRunawayTail(breath), breath);
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

async function harness(store: WorldStore, opts: { heardFor?: (text: string) => string; fail?: string; actual?: number; tail?: number } = {}): Promise<RunHarness> {
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
        const pcm = join_(...keys.flatMap((key, index) => [...(index > 0 ? [silence(0.5)] : [silence(0.2)]), tone(1, 0.2)]), silence(0.2), ...(opts.tail !== undefined ? [silence(0.4), blips(opts.tail)] : []));
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

  it("files the last block's take without a runaway tail, and says the request ran long", async () => {
    const { store, worldDir, close } = await world();
    try {
      // The chapter's words should take about two minutes; the request runs four minutes on.
      const h = await harness(store, { tail: 240 });
      await h.run();
      await h.run({ confirmationToken: priced(h.events)!.confirmationToken });
      assert.equal(finished(h.events)?.outcome, "read", finished(h.events)?.reason);
      const record = await recordOf(worldDir);
      assert.equal(Object.keys(record.flags).length, 0, "the extra was at the end: nothing held");
      const last = Object.values(record.takes).map((take) => take.grouped!).sort((a, b) => b.offsetSec - a.offsetSec)[0]!;
      // Half the pause before it, its second of speech, and the middle of the 0.6 s after.
      assert.ok(last.durationSec > 1.2 && last.durationSec < 1.6, `the last take runs ${last.durationSec} s`);
      const made = h.events.filter((event): event is Extract<AudiobookRunEvent, { type: "progress" }> => event.type === "progress");
      assert.ok(made.length > 0 && made.every((event) => event.outcome === "made" && event.reason === LONG_TAIL));
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

