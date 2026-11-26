import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_TRANSCRIPT_LIMITS } from "@arke-studio/contracts";
import { voiceIntervals } from "../../src/media/song-map.js";
import { SPEECH_STRETCH_PROFILE, voicedStretches } from "../../src/media/speech-stretches.js";

const RATE = 16000;
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A room: noise at `dbfs` RMS for `seconds`. Film sound is never quieter than its room. */
function room(seconds: number, dbfs = -45, seed = 7) {
  const next = random(seed), peak = 10 ** (dbfs / 20) * Math.sqrt(3);
  return new Float32Array(Math.round(seconds * RATE)).map(() => peak * (next() * 2 - 1));
}
/** A line over whatever is there: a 220 Hz tone at about `dbfs`, wavering a little as a voice does. */
function speak(samples: Float32Array, from: number, to: number, dbfs = -20, seed = 3) {
  const next = random(seed), peak = 10 ** (dbfs / 20) * Math.SQRT2 / .9;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) samples[i]! += peak * Math.sin(2 * Math.PI * 220 * i / RATE) * (.8 + .2 * next());
  return samples;
}
const apart = (stretches: Array<{ startSec: number; endSec: number }>) => stretches.every((stretch, i) => stretch.endSec > stretch.startSec && (i === 0 || stretch.startSec >= stretches[i - 1]!.endSec));

test("two lines over room tone at -45 dBFS come apart at the 3 s pause between them, where the song map's voice finder hears one run", () => {
  const samples = speak(speak(room(10), 1, 3), 6, 8);
  assert.deepEqual(voiceIntervals(samples, RATE).intervals, [{ startSec: 0, endSec: 10 }], "30 dB under the loud level is under the room");
  const { stretches, thresholdDbfs } = voicedStretches(samples, RATE);
  assert.deepEqual(stretches, [{ startSec: .7, endSec: 3.3 }, { startSec: 5.7, endSec: 8.3 }], "each line, with 0.3 s either side");
  assert.ok(thresholdDbfs! > -37 && thresholdDbfs! < -33, `10 dB over the room: ${thresholdDbfs}`);
});

test("one 0.4 s word in ten seconds of room is found; a click is not a word, and a breath inside a line does not split it", () => {
  assert.deepEqual(voicedStretches(speak(room(10), 5, 5.4), RATE).stretches, [{ startSec: 4.7, endSec: 5.7 }]);
  // The click is under 0.2 s, so nothing stands over the room and the interval is read whole, as it always was.
  assert.deepEqual(voicedStretches(speak(room(10), 5, 5.1), RATE).stretches, [{ startSec: 0, endSec: 10 }]);
  assert.deepEqual(voicedStretches(speak(speak(room(10), 2, 3), 3.8, 5), RATE).stretches, [{ startSec: 1.7, endSec: 5.3 }], "0.8 s of quiet is inside the line");
});

test("silence and a faint hiss give nothing to read; a room alone and a steady tone give the whole interval", () => {
  assert.deepEqual(voicedStretches(new Float32Array(5 * RATE), RATE), { stretches: [], thresholdDbfs: SPEECH_STRETCH_PROFILE.floorDbfs });
  assert.deepEqual(voicedStretches(room(5, -70), RATE).stretches, []);
  assert.deepEqual(voicedStretches(room(5), RATE).stretches, [{ startSec: 0, endSec: 5 }], "audible, with nothing over its own quiet");
  const tone = Float32Array.from({ length: Math.round(7.33 * RATE) }, (_, i) => .1 * Math.sin(2 * Math.PI * 440 * i / RATE));
  assert.deepEqual(voicedStretches(tone, RATE).stretches, [{ startSec: 0, endSec: tone.length / RATE }]);
  assert.deepEqual(voicedStretches(new Float32Array(0), RATE), { stretches: [], thresholdDbfs: null });
  assert.deepEqual(voicedStretches(new Float32Array(400).fill(.1), RATE), { stretches: [{ startSec: 0, endSec: .025 }], thresholdDbfs: null }, "too short to judge is read whole");
});

test("a line that runs to the interval's end keeps the samples past its last whole step", () => {
  const samples = speak(room(4.02), 3, 4.02);
  assert.deepEqual(voicedStretches(samples, RATE).stretches, [{ startSec: 2.7, endSec: samples.length / RATE }]);
  assert.deepEqual(voicedStretches(speak(room(4), 0, 1), RATE).stretches, [{ startSec: 0, endSec: 1.3 }], "and one from its start begins there");
});

test("a 40 s run is cut into pieces of at most 24 s, at its quietest moment near the middle", () => {
  // One voice from 10 s to 50 s, dropping for one step at 30 s without falling to the room.
  const samples = speak(speak(speak(room(60), 10, 30), 30, 30.05, -30), 30.05, 50);
  assert.deepEqual(voicedStretches(samples, RATE).stretches, [{ startSec: 9.7, endSec: 30 }, { startSec: 30, endSec: 50.3 }]);
});

test("talk that leaves under a tenth of the interval quiet is read from end to end, in pieces short enough to read", () => {
  // The quiet level is then a level of the voice itself, and nothing stands 10 dB over it.
  const dense = speak(speak(speak(room(44), 2, 21), 21, 21.05, -30), 21.05, 42);
  assert.deepEqual(voicedStretches(dense, RATE).stretches, [{ startSec: 0, endSec: 21 }, { startSec: 21, endSec: 44 }]);
  const flat = voicedStretches(speak(room(60), 1, 59), RATE).stretches;
  assert.ok(flat.length >= 3 && flat.every(stretch => stretch.endSec - stretch.startSec <= SPEECH_STRETCH_PROFILE.maxSec + 1e-9), JSON.stringify(flat));
  assert.ok(apart(flat)); assert.equal(flat[0]!.startSec, 0); assert.equal(flat[flat.length - 1]!.endSec, 60);
  for (let i = 1; i < flat.length; i++) assert.equal(flat[i]!.startSec, flat[i - 1]!.endSec, "pieces of one run meet where it was cut");
});

test("paddings never overlap, and more lines than a read may hold are joined across their shortest pauses", () => {
  // Two lines exactly a second apart are two stretches, each with its pad, and the quiet between them is left out.
  assert.deepEqual(voicedStretches(speak(speak(room(8), 1, 2), 3, 4), RATE).stretches, [{ startSec: .7, endSec: 2.3 }, { startSec: 2.7, endSec: 4.3 }]);
  // Twenty words, one every 1.5 s; the pause after the tenth is the long one.
  const samples = room(40), words = Array.from({ length: 20 }, (_, i) => 1 + i * 1.5 + (i >= 10 ? 4 : 0));
  for (const at of words) speak(samples, at, at + .3);
  const { stretches } = voicedStretches(samples, RATE);
  assert.equal(stretches.length, AGENT_TRANSCRIPT_LIMITS.stretches); assert.ok(apart(stretches), JSON.stringify(stretches));
  for (const at of words) assert.ok(stretches.some(stretch => stretch.startSec <= at && stretch.endSec >= at + .3), `the word at ${at} s is inside a stretch`);
  assert.ok(!stretches.some(stretch => stretch.startSec < 15.5 && stretch.endSec > 19.5), "the long pause is still left out");
});
