import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quietStretches, readingLevel, readingProfile } from "../../src/audio/quiet-stretches.js";

const RATE = 24_000;

/** A pseudo-random generator, so a failure replays. */
function noise(seed: number) {
  let state = seed;
  return () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 1_073_741_824 - 1; };
}

/**
 * Speech-shaped sound: syllables four times a second with a breath between, either voiced (a
 * 130 Hz pitch and its harmonics, as a narrator's vowels are) or breathy (noise, as a whisper
 * is), at a level in dBFS.
 */
function reading(parts: ReadonlyArray<{ seconds: number; kind: "voiced" | "breathy"; db: number }>): Float32Array {
  const out = new Float32Array(Math.round(parts.reduce((sum, part) => sum + part.seconds, 0) * RATE));
  const random = noise(7);
  let at = 0;
  for (const part of parts) {
    const amplitude = 10 ** (part.db / 20) * Math.SQRT2;
    for (let i = 0; i < Math.round(part.seconds * RATE); i++, at++) {
      const t = at / RATE;
      const syllable = Math.max(0, Math.sin(Math.PI * 4 * t)) ** 0.5;
      let sample = 0;
      if (part.kind === "voiced") for (let k = 1; k <= 8; k++) sample += Math.sin(2 * Math.PI * 130 * k * t) / k;
      else sample = random() * 1.2;
      out[at] = amplitude * syllable * sample * 0.6;
    }
  }
  return out;
}

describe("where a reading goes quiet and breathy (SPEC-047 R-196)", () => {
  it("finds nothing in an ordinary reading", async () => {
    const profile = await readingProfile(reading([{ seconds: 20, kind: "voiced", db: -15 }]), RATE);
    assert.ok(profile.windows.length >= 38);
    assert.deepEqual(quietStretches(profile, readingLevel([profile])!), []);
  });

  it("finds a whisper inside a reading, and where it starts and stops", async () => {
    const profile = await readingProfile(reading([{ seconds: 10, kind: "voiced", db: -15 }, { seconds: 8, kind: "breathy", db: -28 }, { seconds: 10, kind: "voiced", db: -15 }]), RATE);
    const stretches = quietStretches(profile, readingLevel([profile])!);
    assert.equal(stretches.length, 1);
    const [stretch] = stretches;
    assert.ok(Math.abs(stretch!.fromSec - 10) <= 1.5 && Math.abs(stretch!.toSec - 18) <= 1.5, JSON.stringify(stretch));
    assert.ok(stretch!.voiced < 0.45);
  });

  it("judges a take against its chapter's level, so a block whispered throughout is found", async () => {
    const ordinary = await readingProfile(reading([{ seconds: 30, kind: "voiced", db: -15 }]), RATE);
    const whispered = await readingProfile(reading([{ seconds: 12, kind: "breathy", db: -28 }]), RATE);
    const level = readingLevel([ordinary, whispered])!;
    const [stretch, ...rest] = quietStretches(whispered, level);
    assert.equal(rest.length, 0);
    assert.ok(stretch!.fromSec <= 1 && stretch!.toSec >= 11, JSON.stringify(stretch));
  });

  it("takes neither a quiet voiced line, nor a loud breathy one, nor a short hush for a whisper", async () => {
    const quietLine = await readingProfile(reading([{ seconds: 10, kind: "voiced", db: -15 }, { seconds: 8, kind: "voiced", db: -28 }, { seconds: 10, kind: "voiced", db: -15 }]), RATE);
    assert.deepEqual(quietStretches(quietLine, readingLevel([quietLine])!), []);
    // The noise is white to 12 kHz and the measure hears only the speech band under 4 kHz, so
    // it is written louder to stand at the reading's level there.
    const loudBreath = await readingProfile(reading([{ seconds: 10, kind: "voiced", db: -15 }, { seconds: 8, kind: "breathy", db: -8 }, { seconds: 10, kind: "voiced", db: -15 }]), RATE);
    assert.deepEqual(quietStretches(loudBreath, readingLevel([loudBreath])!), []);
    const brief = await readingProfile(reading([{ seconds: 10, kind: "voiced", db: -15 }, { seconds: 1.5, kind: "breathy", db: -28 }, { seconds: 10, kind: "voiced", db: -15 }]), RATE);
    assert.deepEqual(quietStretches(brief, readingLevel([brief])!), []);
  });

  it("has no level to judge by without speech", async () => {
    const silence = await readingProfile(new Float32Array(RATE * 5), RATE);
    assert.equal(readingLevel([silence]), null);
    assert.ok(silence.windows.every((window) => window.levelDb === null));
  });
});
