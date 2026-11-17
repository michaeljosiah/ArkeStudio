import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEffectPcmAnalyzer } from "../src/editor-effect-audio-features.js";
import { EFFECT_ANALYSIS_PROFILE } from "../src/editor-effect-analysis.js";
import { SONG_SECTION_PROFILE, SongSectionsSchema, findSongSections, proposedSectionLabel } from "../src/song-sections.js";

/**
 * Where a song changes (issue 3099). The songs here are made in the test: a kick on every beat at
 * a fixed tempo over a held tone, louder or quieter by stretch, so the changes are where the test
 * put them and nothing recorded has to ride in the repository.
 */
const RATE = EFFECT_ANALYSIS_PROFILE.sampleRate;
const FPS = SONG_SECTION_PROFILE.frameRate;

interface Stretch { seconds: number; kick: number; tone: number }

/** Stereo PCM of the stretches end to end, with a kick every beat when `bpm` is given. */
function song(stretches: readonly Stretch[], bpm: number | null): Float32Array {
  const total = stretches.reduce((sum, stretch) => sum + stretch.seconds, 0);
  const samples = new Float32Array(total * RATE * 2);
  const beat = bpm === null ? 0 : Math.round(RATE * 60 / bpm);
  let start = 0;
  for (const stretch of stretches) {
    const end = start + stretch.seconds * RATE;
    for (let sample = start; sample < end; sample++) {
      const sinceBeat = beat === 0 ? 0 : (sample % beat) / RATE;
      const kick = beat === 0 ? 0 : stretch.kick * Math.sin(2 * Math.PI * 60 * sinceBeat) * Math.exp(-sinceBeat / 0.08);
      const value = kick + stretch.tone * Math.sin(2 * Math.PI * 440 * sample / RATE);
      samples[sample * 2] = value; samples[sample * 2 + 1] = value;
    }
    start = end;
  }
  return samples;
}

/** The effects analysis of it, as the coordinator makes it: decoded PCM pushed in chunks. */
function analysed(pcm: Float32Array) {
  const frames = pcm.length / 2 / (RATE / FPS);
  const analyzer = createEffectPcmAnalyzer({ frameRate: FPS, startFrame: 0, endFrame: frames });
  for (let offset = 0; offset < pcm.length; offset += 65536) analyzer.push(pcm.subarray(offset, Math.min(pcm.length, offset + 65536)));
  return analyzer.finish();
}

const LOUD = { kick: 0.6, tone: 0.2 }, QUIET = { kick: 0.08, tone: 0.03 };
const near = (found: number, wanted: number, withinSec: number) => Math.abs(found - wanted) <= withinSec;

describe("where a song changes (issue 3099)", () => {
  it("finds the tempo and the places a song gets louder or quieter, on a beat", () => {
    const found = findSongSections(analysed(song([
      { seconds: 16, ...QUIET }, { seconds: 24, ...LOUD }, { seconds: 16, ...QUIET }, { seconds: 24, ...LOUD },
    ], 120)), FPS);
    assert.equal(found.tempoBpm, 120);
    assert.equal(found.startsSec.length, 4, `sections at ${found.startsSec.join(", ")}`);
    assert.equal(found.startsSec[0], 0, "a song starts with its first section");
    for (const [index, wanted] of [16, 40, 56].entries()) {
      assert.ok(near(found.startsSec[index + 1]!, wanted, 1), `a section near ${wanted}s, found ${found.startsSec[index + 1]}`);
    }
    // At 120 a beat is half a second, and the song starts on one.
    for (const start of found.startsSec) assert.ok(Math.abs(start * 2 - Math.round(start * 2)) < 0.07, `${start}s is on a beat`);
  });

  it("is the same answer every time", () => {
    const data = analysed(song([{ seconds: 20, ...QUIET }, { seconds: 20, ...LOUD }], 100));
    assert.deepEqual(findSongSections(data, FPS), findSongSections(data, FPS));
  });

  it("finds one section in a song that never changes", () => {
    const found = findSongSections(analysed(song([{ seconds: 60, ...LOUD }], 120)), FPS);
    assert.deepEqual(found, { tempoBpm: 120, startsSec: [0] });
  });

  it("takes a short break as one boundary, where the music comes back", () => {
    const found = findSongSections(analysed(song([
      { seconds: 30, ...LOUD }, { seconds: 2, kick: 0, tone: 0.02 }, { seconds: 30, ...LOUD },
    ], 120)), FPS);
    assert.equal(found.startsSec.length, 2, `sections at ${found.startsSec.join(", ")}`);
    assert.ok(near(found.startsSec[1]!, 32, 1), `the section starts where the band returns, found ${found.startsSec[1]}`);
  });

  it("keeps one of two changes closer than a section can be", () => {
    const found = findSongSections(analysed(song([
      { seconds: 20, ...QUIET }, { seconds: 4, kick: 0.3, tone: 0.1 }, { seconds: 26, ...LOUD },
    ], 120)), FPS);
    const inner = found.startsSec.slice(1);
    assert.equal(inner.length, 1, `sections at ${found.startsSec.join(", ")}`);
    for (let index = 1; index < found.startsSec.length; index++) {
      assert.ok(found.startsSec[index]! - found.startsSec[index - 1]! >= SONG_SECTION_PROFILE.minSectionSec);
    }
  });

  it("measures a song with no pulse in half-seconds and reports no tempo", () => {
    const found = findSongSections(analysed(song([{ seconds: 20, kick: 0, tone: 0.05 }, { seconds: 20, kick: 0, tone: 0.4 }], null)), FPS);
    assert.equal(found.tempoBpm, null);
    assert.equal(found.startsSec.length, 2, `sections at ${found.startsSec.join(", ")}`);
    assert.ok(near(found.startsSec[1]!, 20, 1));
  });

  it("says nothing of silence, or of a sound too short to have sections", () => {
    assert.deepEqual(findSongSections(analysed(new Float32Array(30 * RATE * 2)), FPS), { tempoBpm: null, startsSec: [0] });
    assert.deepEqual(findSongSections(analysed(song([{ seconds: 5, ...QUIET }, { seconds: 5, ...LOUD }], 120)), FPS), { tempoBpm: null, startsSec: [0] });
  });

  it("holds a long, restless song to its cap of sections", () => {
    // Thirty minutes, the analysis profile's whole length, as levels: no PCM is needed to count.
    const frames = EFFECT_ANALYSIS_PROFILE.maxFrames;
    const energy: number[] = [], bass: number[] = [];
    for (let frame = 0; frame < frames; frame++) {
      const loud = Math.floor(frame / (FPS * 20)) % 2 === 0;
      const onBeat = frame % 15 < 3;
      energy.push((loud ? 0.5 : 0.05) * (onBeat ? 1 : 0.4));
      bass.push((loud ? 0.4 : 0.03) * (onBeat ? 1 : 0.2));
    }
    const found = findSongSections({ features: { startFrame: 0, endFrame: frames, beat: energy.map(() => 0), bass, energy }, silent: false }, FPS);
    assert.equal(found.startsSec.length, SONG_SECTION_PROFILE.maxSections);
    assert.equal(found.tempoBpm, 120);
    assert.deepEqual(found.startsSec, [...found.startsSec].sort((a, b) => a - b));
  });

  it("names a proposed section by its place and nothing else", () => {
    assert.equal(proposedSectionLabel(0), "Section 1");
    assert.equal(proposedSectionLabel(7), "Section 8");
  });

  it("carries what was measured strictly", () => {
    const song = { trackArtifactId: "ar_01J8G0000000000000000000R1", durationSec: 227.64, tempoBpm: 100, startsSec: [0, 22.9] };
    assert.deepEqual(SongSectionsSchema.parse(song), song);
    assert.equal(SongSectionsSchema.safeParse({ ...song, startsSec: [] }).success, false, "a song has at least one section");
    assert.equal(SongSectionsSchema.safeParse({ ...song, sections: ["Verse"] }).success, false, "no names ride with it");
    assert.equal(SongSectionsSchema.parse({ ...song, tempoBpm: null }).tempoBpm, null);
  });
});
