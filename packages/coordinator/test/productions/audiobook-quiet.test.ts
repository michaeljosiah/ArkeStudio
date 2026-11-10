import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { audiobookTextHash, DEFAULT_NARRATOR, MEASURED_WORD_TIMING_ENGINE, type AudiobookDirectionInput } from "@arke-studio/contracts";
import { encodePcm16Wav } from "@arke-studio/voice";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { audioHash } from "../../src/audio/qc.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { directionEntry, planAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
import { readAudiobookQuiet } from "../../src/productions/audiobook-quiet.js";
import { directionPlan } from "../../src/voice/direction.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const RATE = 24_000;
const book = "the-ledger-of-nights", chapter = "neap", file = "01-neap";

/** Syllables of a voiced reading or a breathy one (see quiet-stretches.test.ts), at a level in dBFS. */
function reading(parts: ReadonlyArray<{ seconds: number; kind: "voiced" | "breathy"; db: number }>): Float32Array {
  const out = new Float32Array(Math.round(parts.reduce((sum, part) => sum + part.seconds, 0) * RATE));
  let state = 11, at = 0;
  for (const part of parts) {
    const amplitude = 10 ** (part.db / 20) * Math.SQRT2;
    for (let i = 0; i < Math.round(part.seconds * RATE); i++, at++) {
      const t = at / RATE;
      let sample = 0;
      if (part.kind === "voiced") for (let k = 1; k <= 8; k++) sample += Math.sin(2 * Math.PI * 130 * k * t) / k;
      else { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; sample = (state / 1_073_741_824 - 1) * 1.2; }
      out[at] = amplitude * Math.max(0, Math.sin(Math.PI * 4 * t)) ** 0.5 * sample * 0.6;
    }
  }
  return out;
}

async function fixture() {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root); await provider.loadWorld(WORLD_ID);
  const store = provider.openStore!()!;
  const plan = await planAudiobook(store, book, chapter, { narrator: DEFAULT_NARRATOR });
  const blocks = plan.blocks.map((entry) => entry.block).filter((block) => block.key !== "title");
  assert.ok(blocks.length >= 4, "the fixture chapter has blocks enough to read");
  const take = async (index: number, audio: Float32Array) => {
    const source = join(root, `take-${index}.wav`); await writeFile(source, encodePcm16Wav(audio, RATE));
    const seconds = audio.length / RATE;
    const filed = await fileArtifact(store, { sourcePath: source, mediaProbe: { durationSec: async () => seconds, info: async () => ({ durationSec: seconds, hasAudio: true }) } });
    if (filed.outcome !== "filed") throw new Error("fixture filing failed");
    return { artifactId: filed.artifact.id, textHash: audiobookTextHash(blocks[index]!.text), reader: DEFAULT_NARRATOR, format: "wav" as const,
      characters: blocks[index]!.text.length, parts: 1, estimatedMicroUsd: 0, costMicroUsd: 0, madeAt: store.now(), bytes: await readFile(source) };
  };
  // An ordinary block; one whose whisper runs on past the marker set on its opening words; one
  // asked to whisper throughout that was read aloud; and one with no reading at all.
  const ordinary = await take(0, reading([{ seconds: 20, kind: "voiced", db: -15 }]));
  const ranOn = await take(1, reading([{ seconds: 8, kind: "voiced", db: -15 }, { seconds: 8, kind: "breathy", db: -28 }, { seconds: 8, kind: "voiced", db: -15 }]));
  const aloud = await take(2, reading([{ seconds: 10, kind: "voiced", db: -15 }]));
  const marked = blocks[1]!.text.split(/\s+/).slice(0, 3).join(" ");
  const directions: Record<string, AudiobookDirectionInput> = {
    [blocks[1]!.key]: { speed: 1, cues: [{ kind: "delivery", delivery: "whispered", span: { from: 0, to: marked.length, text: marked } }] },
    [blocks[2]!.key]: { delivery: "whispered", speed: 1, cues: [] },
  };
  await updateAudiobook(store, book, plan.chapter, (current) => ({ ...current,
    takes: { ...current.takes, ...Object.fromEntries([ordinary, ranOn, aloud].map(({ bytes: _bytes, ...entry }, index) => [blocks[index]!.key, entry])) },
    direction: { ...current.direction, ...Object.fromEntries(Object.entries(directions).map(([key, input]) => {
      const text = blocks.find((block) => block.key === key)!.text;
      return [key, directionEntry(text, directionPlan(text, input), store.now())];
    })) } }));
  return { provider, store, plan, blocks, ranOn, marked };
}

// A whisper set on a block's first words and read on past them, measured from the take (SPEC-047
// R-196): the quiet stretch is listed with the words read in it beside the marker's own, a block
// asked to whisper but read aloud is listed with none, and an ordinary block is left out.
it("lists where a chapter's reading goes quiet beside what its direction asked", async () => {
  const f = await fixture();
  try {
    const read = await readAudiobookQuiet(f.store, book, file);
    assert.equal(read.chapterId, chapter);
    assert.equal(read.measured, 3);
    assert.ok(read.usualDb !== null && read.usualDb > -22 && read.usualDb < -12, String(read.usualDb));
    assert.deepEqual(read.blocks.map((block) => block.key), [f.blocks[1]!.key, f.blocks[2]!.key]);
    assert.ok(read.unmeasured.some((entry) => entry.key === f.blocks[3]!.key && entry.reason === "no current reading"));
    const ranOn = read.blocks[0]!;
    assert.deepEqual(ranOn.direction?.markers, [{ delivery: "whispered", at: [0, f.marked.length], words: f.marked }]);
    assert.equal(ranOn.quiet.length, 1);
    const [stretch] = ranOn.quiet;
    assert.ok(Math.abs(stretch!.seconds[0] - 8) <= 1.5 && Math.abs(stretch!.seconds[1] - 16) <= 1.5, JSON.stringify(stretch));
    assert.ok(stretch!.underUsualDb >= 5);
    assert.equal(stretch!.estimated, true);
    assert.ok(stretch!.words.length > 0 && ranOn.text.replace(/\s+/g, " ").includes(stretch!.words), stretch!.words);
    const aloud = read.blocks[1]!;
    assert.equal(aloud.direction?.delivery, "whispered");
    assert.deepEqual(aloud.quiet, []);
  } finally { await f.provider.close(); }
});

it("names the words a stretch holds from the take's own word timing when it was measured on these bytes", async () => {
  const f = await fixture();
  try {
    const key = f.blocks[1]!.key, text = f.blocks[1]!.text;
    const words = [{ text: "before", startSec: 2, endSec: 2.5, probability: 0.9 }, { text: "hushed", startSec: 10, endSec: 10.6, probability: 0.9 },
      { text: "still", startSec: 13, endSec: 13.4, probability: 0.9 }, { text: "after", startSec: 21, endSec: 21.5, probability: 0.9 }];
    await updateAudiobook(f.store, book, f.plan.chapter, (current) => ({ ...current, wordTiming: { [key]: { artifactId: f.ranOn.artifactId,
      audioHash: audioHash(f.ranOn.bytes), textHash: audiobookTextHash(text), engine: { id: MEASURED_WORD_TIMING_ENGINE, version: "1", model: "fixture" },
      seconds: 24, words, at: f.store.now() } } }));
    const read = await readAudiobookQuiet(f.store, book, file);
    const [stretch] = read.blocks.find((block) => block.key === key)!.quiet;
    assert.equal(stretch!.estimated, false);
    assert.equal(stretch!.words, "hushed still");
  } finally { await f.provider.close(); }
});
