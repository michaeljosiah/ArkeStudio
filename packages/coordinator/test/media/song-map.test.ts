import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSongMapSchema } from "@arke-studio/contracts";
import { estimatePeriod, onsetCurve, songBeats, trackBeats, voiceIntervals } from "../../src/media/song-map.js";

const RATE = 16000;
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/**
 * A beat the way a mix carries one: on each beat a kick, a decaying 60 Hz thump with the short
 * broadband click of the beater; on each off-beat a softer hi-hat. A tracker that counts plain FFT
 * bins hears mostly the hi-hats, which fill the bins above 1 kHz.
 */
function groove(seconds: number, bpm: number, firstBeat: number, seed = 1, hats = true) {
  const next = random(seed), samples = new Float32Array(Math.round(seconds * RATE)), period = 60 / bpm, beats: number[] = [];
  for (let beat = firstBeat; beat < seconds; beat += period) {
    beats.push(beat);
    const at = Math.round(beat * RATE);
    for (let i = 0; i < .15 * RATE && at + i < samples.length; i++) {
      samples[at + i]! += .8 * Math.exp(-i / (.04 * RATE)) * Math.sin(2 * Math.PI * 60 * i / RATE) + .4 * Math.exp(-i / (.003 * RATE)) * (next() * 2 - 1);
    }
    const off = Math.round((beat + period / 2) * RATE);
    for (let i = 0; hats && i < .03 * RATE && off + i < samples.length; i++) samples[off + i]! += .2 * Math.exp(-i / (.006 * RATE)) * (next() * 2 - 1);
  }
  for (let i = 0; i < samples.length; i++) samples[i]! += .01 * (next() * 2 - 1);
  return { samples, beats };
}

test("a steady 100 bpm groove: tempo 100, every tracked beat on a kick, not on the hi-hat between", async () => {
  const { samples, beats } = groove(40, 100, .3), found = await songBeats(samples);
  assert.ok(Math.abs(found.tempoBpm! - 100) < .5, String(found.tempoBpm));
  assert.ok(found.beatsSec.length >= beats.length - 3, `${found.beatsSec.length} of ${beats.length}`);
  for (const beat of found.beatsSec) {
    const nearest = beats.reduce((a, b) => Math.abs(b - beat) < Math.abs(a - beat) ? b : a);
    assert.ok(Math.abs(nearest - beat) < .03, `beat at ${beat} is ${Math.round((beat - nearest) * 1000)} ms from a kick`);
  }
});

test("a 128 bpm groove and a slow 72 bpm kick keep their own tempo; hats on every off-beat of the slow one read it at double", async () => {
  for (const bpm of [128, 72]) {
    const found = await songBeats(groove(40, bpm, .1, bpm, bpm !== 72).samples);
    assert.ok(Math.abs(found.tempoBpm! - bpm) < 1, `${bpm}: ${found.tempoBpm}`);
  }
  // The music then repeats every half-beat as well, and the 120 bpm prior hears 144: the tool's limitations say so.
  assert.ok(Math.abs((await songBeats(groove(40, 72, .1, 72).samples)).tempoBpm! - 144) < 2);
});

test("noise with no pulse gets no beats rather than a guessed grid", async () => {
  const next = random(9), samples = new Float32Array(20 * RATE).map(() => .2 * (next() * 2 - 1));
  const found = await songBeats(samples);
  assert.ok(found.tempoBpm === null || found.beatsSec.length < 10, JSON.stringify({ tempo: found.tempoBpm, beats: found.beatsSec.length }));
  assert.deepEqual(await trackBeats(new Float64Array(0), 60), []);
  assert.equal(estimatePeriod(await onsetCurve(new Float32Array(RATE))), null);
});

test("a vocal stem's phrases come back as intervals; a breath inside a phrase does not split it, a long rest does", () => {
  const samples = new Float32Array(20 * RATE), next = random(4);
  const sing = (from: number, to: number) => { for (let i = Math.round(from * RATE); i < to * RATE; i++) samples[i] = .3 * Math.sin(2 * Math.PI * 220 * i / RATE) * (.8 + .2 * next()); };
  sing(2, 4.2); sing(4.5, 7); sing(12, 15.5); sing(18, 18.1);
  for (let i = 0; i < samples.length; i++) samples[i]! += .0005 * (next() * 2 - 1);
  const { intervals, thresholdDbfs } = voiceIntervals(samples, RATE);
  assert.deepEqual(intervals, [{ startSec: 2, endSec: 7 }, { startSec: 12, endSec: 15.5 }]);
  assert.ok(thresholdDbfs > -50 && thresholdDbfs < -20, String(thresholdDbfs));
});

test("a long song is measured without holding the coordinator: a timer runs before the beats are done, and a stop stops it", async () => {
  const { samples } = groove(60, 100, .3), order: string[] = [];
  setTimeout(() => order.push("timer"), 0);
  await songBeats(samples);
  order.push("done");
  assert.deepEqual(order, ["timer", "done"]);
  const stop = new AbortController(); stop.abort();
  await assert.rejects(songBeats(samples, stop.signal));
});

test("a 15-minute stem with a phrase every second keeps every phrase, inside the map's limit", () => {
  const rate = 4000, samples = new Float32Array(900 * rate);
  for (let s = 0; s < 900; s++) for (let i = 0; i < .4 * rate; i++) samples[s * rate + i] = .3 * Math.sin(2 * Math.PI * 220 * i / rate);
  const { intervals } = voiceIntervals(samples, rate);
  assert.equal(intervals.length, 900); assert.equal(intervals[899]!.startSec, 899);
  const map = { streamIndex: 0, startSec: 0, endSec: 900, tempoBpm: null, beats: [], sections: [{ startSec: 0, endSec: 900, loudnessDbfs: -20, vocalFraction: .4 }],
    vocal: { source: { kind: "artifact", id: "ar_stem" }, sourceHash: `sha256:${"b".repeat(64)}`, streamIndex: 0, thresholdDbfs: -40, intervals } };
  assert.equal(AgentSongMapSchema.safeParse(map).success, true);
});

test("the song map schema holds beats, sections and the voice to the measured window", () => {
  const map = { streamIndex: 0, startSec: 10, endSec: 70, tempoBpm: 100, beats: [10.2, 10.8],
    sections: [{ startSec: 10, endSec: 40, loudnessDbfs: -20, vocalFraction: .5 }, { startSec: 40, endSec: 70, loudnessDbfs: -18, vocalFraction: 0 }],
    vocal: { source: { kind: "artifact", id: "ar_stem" }, sourceHash: `sha256:${"b".repeat(64)}`, streamIndex: 0, thresholdDbfs: -40, intervals: [{ startSec: 12, endSec: 25 }] } };
  assert.equal(AgentSongMapSchema.safeParse(map).success, true);
  assert.equal(AgentSongMapSchema.safeParse({ ...map, beats: [10.8, 10.2] }).success, false);
  assert.equal(AgentSongMapSchema.safeParse({ ...map, beats: [], tempoBpm: 100 }).success, false);
  assert.equal(AgentSongMapSchema.safeParse({ ...map, sections: [{ ...map.sections[0]!, endSec: 39 }, map.sections[1]!] }).success, false);
  assert.equal(AgentSongMapSchema.safeParse({ ...map, vocal: null }).success, false);
  assert.equal(AgentSongMapSchema.safeParse({ ...map, endSec: 1000 }).success, false);
});
