import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AudiobookPictureSchema,
  audiobookMotionDurations,
  audiobookMotionModel,
  audiobookMotionPrice,
  audiobookMotionTime,
  captionWordParts,
  highlightedCaptionAss,
  validateAcousticWords,
  videoSegments,
  DEFAULT_VIDEO_OPTIONS,
  type AcousticWords,
  type ManifestModel,
} from "../src/index.js";

const model: ManifestModel = {
  id: "motion",
  displayName: "Motion",
  provider: "comfyui",
  capability: "video",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 30, durations: { "20": "20" } },
  pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
  modes: { "first-frame": { locked: [], durations: { "4": "4", "8": "8" }, maxDurationSec: 8 } },
};
const heard: AcousticWords = {
  text: "The lamp moved.",
  seconds: 3,
  engine: { id: "whisper.cpp/dtw-word-boundaries-v1", version: "1", model: "base-en" },
  words: [
    { text: "The", startSec: 0.2, endSec: 0.45, probability: 0.9 },
    { text: "lamp", startSec: 0.6, endSec: 1, probability: 0.95 },
    { text: "moved.", startSec: 1.8, endSec: 2.2, probability: 0.98 },
  ],
};

describe("approved turn 208 motion and acoustic captions", () => {
  it("offers only first-frame route durations and prices that same duration", () => {
    assert.equal(audiobookMotionModel(model), true);
    assert.deepEqual(audiobookMotionDurations(model), [4, 8]);
    assert.equal(audiobookMotionPrice(model, { kind: "video", durationSec: 8 }), 800000);
    assert.equal(audiobookMotionModel({ ...model, modes: undefined }), false);
  });
  it("reads old still records and retains their original file beside a clip", () => {
    const still = {
      file: "world-art.png",
      source: "world",
      at: "2026-10-10T12:00:00.000Z",
      textHash: "sha256:a",
    };
    assert.deepEqual(AudiobookPictureSchema.parse(still), still);
    const parsed = AudiobookPictureSchema.parse({
      ...still,
      motion: {
        artifactId: "ar_01J00000000000000000000001",
        file: "artifacts/clip.mp4",
        seconds: 5,
        width: 864,
        height: 480,
        sourceHash: `sha256:${"a".repeat(64)}`,
        sourceAt: still.at,
        behavior: "repeat",
        active: true,
      },
    });
    assert.equal(parsed.file, still.file);
    assert.equal(audiobookMotionTime(5, 16.2, "repeat"), 16.2 % 5);
    assert.ok(audiobookMotionTime(5, 16.2, "hold") < 5);
    assert.ok(audiobookMotionTime(5, 16.2, "hold") > 4.98);
  });
  it("requires complete confident ordered acoustic words; text similarity cannot invent missing timing", () => {
    assert.equal(validateAcousticWords("The lamp moved.", heard).ok, true);
    assert.equal(
      validateAcousticWords("The lamp moved.", {
        ...heard,
        engine: { ...heard.engine, id: "whisper-token-timestamps" },
      }).ok,
      false,
    );
    assert.equal(validateAcousticWords("The lamp glowed.", heard).ok, false);
    assert.equal(validateAcousticWords("The lamp moved again.", heard).ok, false);
    assert.equal(
      validateAcousticWords("The lamp moved.", {
        ...heard,
        words: heard.words.map((w, i) => (i === 1 ? { ...w, probability: 0.2 } : w)),
      }).ok,
      false,
    );
    assert.equal(
      validateAcousticWords("The lamp moved.", {
        ...heard,
        words: heard.words.map((w, i) => (i === 1 ? { ...w, startSec: 0.3 } : w)),
      }).ok,
      false,
    );
    const punctuation = validateAcousticWords("The lamp — moved.", heard);
    assert.ok(punctuation.ok);
    assert.equal(punctuation.words[1]?.text, "lamp —");
  });
  it("highlights exactly one word, clears pauses, and serializes that same cue for rendering", () => {
    const cue = { text: "The lamp\nmoved.", startSec: 0, endSec: 3, words: heard.words };
    assert.deepEqual(
      captionWordParts(cue, 0.8)
        .filter((p) => p.active)
        .map((p) => p.text),
      ["lamp"],
    );
    assert.equal(
      captionWordParts(cue, 1.2).some((p) => p.active),
      false,
    );
    assert.deepEqual(
      captionWordParts(cue, 2)
        .filter((p) => p.active)
        .map((p) => p.text),
      ["moved."],
    );
    const ass = highlightedCaptionAss([cue], DEFAULT_VIDEO_OPTIONS);
    assert.match(ass, /0:00:00\.60,0:00:01\.00/);
    assert.match(ass, /\\3c&H0063DFFF&\\1c&H00171717&\}lamp/);
    assert.doesNotMatch(ass, /\\[kK]/);
    assert.throws(
      () => highlightedCaptionAss([{ ...cue, words: undefined }], DEFAULT_VIDEO_OPTIONS),
      /measured word timing/,
    );
  });
  it("keeps a clip's original chapter clock when the opening card covers its first seconds", () => {
    const motion = {
      artifactId: "ar_01J00000000000000000000001",
      file: "artifacts/c.mp4",
      seconds: 5,
      width: 864,
      height: 480,
      sourceHash: `sha256:${"a".repeat(64)}`,
      sourceAt: "2026-10-10T12:00:00.000Z",
      behavior: "repeat" as const,
      active: true,
    };
    const segments = videoSegments(
      {
        title: "A title",
        seconds: 20,
        blocks: [],
        pictures: [
          { key: "title", number: 1, file: "world-art.png", at: 0, seconds: 20, short: false, motion },
        ],
      },
      null,
      true,
    );
    assert.equal(segments[0]?.motion, undefined);
    assert.equal(segments[1]?.from, 3);
    assert.equal(segments[1]?.motionAt, 0);
    assert.equal(segments[1]?.file, "world-art.png");
  });
});
