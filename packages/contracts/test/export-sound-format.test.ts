import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCanonicalAudioGraph, DEFAULT_MIX, MIX_FORMAT, type ExportPlan, type RenderAudioItem } from "../src/index.js";

/**
 * A film's sound is mixed at one format whatever its sounds are (SPEC-038 R-51).
 *
 * FFmpeg's mixer takes its sample rate and channel count from its first input. A film whose first
 * sound was a voice take, 24 kHz in one channel, was mixed whole at that: the music under it lost
 * everything above 12 kHz and its stereo, and the file said so only to someone who probed it.
 * These hold the graph's text; coordinator `test/media/export-sound-format-native.test.ts` runs it.
 */

type Mix = Pick<ExportPlan, "audio" | "mix" | "speech" | "totalSec">;
const sound = (name: string, startSec: number, extra: Partial<RenderAudioItem> = {}): RenderAudioItem =>
  ({ path: `artifacts/${name}.wav`, clipId: `cl_${name}`, startSec, endSec: startSec + 2, gainDb: 0, role: "dialogue", sourceInSec: 0, ...extra });
const graphOf = (plan: Mix) => buildCanonicalAudioGraph(plan, plan.audio.map(clip => clip.path));
const chains = (plan: Mix) => graphOf(plan).filters.filter(filter => /^\[\d+:a\]/.test(filter));

test("the film's format is 48 kHz in two channels", () => {
  assert.equal(MIX_FORMAT, "aresample=48000,pan=stereo|FL=FL+FC|FR=FR+FC");
});

test("every sound is brought to the film's format at the head of its chain, one sound or many", () => {
  const one: Mix = { audio: [sound("line", 0)], totalSec: 4, mix: { ...DEFAULT_MIX }, speech: [] };
  assert.deepEqual(chains(one).map(chain => chain.startsWith(`[0:a]${MIX_FORMAT},apad=`)), [true], "a film with one sound is still that format");
  const many: Mix = { audio: [sound("line", 0), sound("bed", 0, { role: "music" }), sound("door", 1, { role: "ambience" })], totalSec: 4, mix: { ...DEFAULT_MIX }, speech: [{ startSec: 0, endSec: 2 }] };
  const each = chains(many);
  assert.equal(each.length, 3);
  each.forEach((chain, index) => assert.ok(chain.startsWith(`[${index}:a]${MIX_FORMAT},apad=`), chain));
  // After the mixer is too late: by then the mix has been made at the first input's format.
  const rest = graphOf(many).filters.filter(filter => !/^\[\d+:a\]/.test(filter)).join(";");
  assert.equal(/aformat|aresample|pan=/.test(rest), false, "the format is set before the mix and nowhere after it");
});

test("the format step leaves a fade the last stage of its chain", () => {
  // A stage after the fade that regrouped its samples ended a film early (see the fade's note in cut.ts).
  const faded = sound("bed", 0, { role: "music", fadeIn: { startSec: 0, durationSec: 1 } });
  const [chain] = chains({ audio: [faded], totalSec: 4, mix: { ...DEFAULT_MIX }, speech: [] });
  assert.ok(chain !== undefined && chain.startsWith(`[0:a]${MIX_FORMAT},`), chain);
  assert.match(chain!, /,asetnsamples=n=64:p=0,volume=eval=frame:volume='[^']+'\[ac0\]$/, "nothing follows the fade");
});
