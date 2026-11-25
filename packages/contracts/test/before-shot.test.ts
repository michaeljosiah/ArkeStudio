import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beforeShotChecks, beforeShotCount, recordedLineSec, type BeforeShotInput, type Shot } from "../src/index.js";

/*
 * A shot read before it is made (design turns 287 and 288b), each item the fault Gold on Gold's
 * shots went to the model with.
 */

const script = { blocks: [
  { id: "blk_goat", kind: "action" as const, text: "THE CLUB. TUNDE does an offended goat." },
  { id: "blk_boot", kind: "dialogue" as const, speaker: "ade", text: "The goat was in the boot, Tunde." },
] };
const shot = (over: Partial<Shot> = {}): Shot => ({ id: "sh_13", number: 13, title: "In the boot", durationSec: 4,
  description: "@ade turns back to @tunde, his glass on its napkin.", audio: { kind: "dialogue", speaker: "ade", line: "The goat was in the boot, Tunde." }, ...over });
const input = (over: Partial<BeforeShotInput> = {}): BeforeShotInput => ({
  scene: { script, defaults: { lighting: "purple from above, the bar's glow" } }, shot: shot(),
  look: { camera: { kind: "handheld", strength: "gentle" }, light: { key: "low" } },
  clipsFrom: "frames", hasFrame: true,
  characters: [{ id: "ade", name: "Adeyemi \"Ade\" Akinola" }, { id: "tunde", name: "Tunde" }, { id: "ife", name: "Ife" }],
  board: null, ...over,
});
const item = (checks: ReturnType<typeof beforeShotChecks>, id: string) => checks.find((check) => check.id === id);

describe("a shot read before it is made", () => {
  it("passes a shot written as the craft asks", () => {
    const checks = beforeShotChecks(input());
    assert.deepEqual(checks.map((check) => [check.id, check.result, check.says]), [
      ["line", "pass", "word for word"], ["named", "pass", "Ade, Tunde"], ["camera", "pass", "handheld"],
      ["light", "pass", "purple from above, the bar's glow"], ["beats", "pass", "1.3 s spare"], ["frame", "pass", "set"],
    ]);
    assert.deepEqual(beforeShotCount(checks), { passed: 6, of: 6, hardToFix: 0 });
  });

  it("holds a line that is not the script's word for word, or is another person's", () => {
    assert.deepEqual(item(beforeShotChecks(input({ shot: shot({ audio: { kind: "dialogue", speaker: "ade", line: "The goat was in the car, Tunde." } }) })), "line"),
      { id: "line", result: "fix", says: "not in the script" });
    assert.deepEqual(item(beforeShotChecks(input({ shot: shot({ audio: { kind: "dialogue", speaker: "tunde", line: "The goat was in the boot, Tunde!" } }) })), "line"),
      { id: "line", result: "fix", says: "another's line" }, "the same words, case and stops aside, but not this speaker's");
  });

  it("holds someone seen but not cited, and words about a body's build", () => {
    assert.deepEqual(item(beforeShotChecks(input({ shot: shot({ description: "@ade turns back to @tunde. Behind them Ife crosses the floor." }) })), "named"),
      { id: "named", result: "fix", says: "Ife not cited" });
    assert.deepEqual(item(beforeShotChecks(input({ shot: shot({ description: "@ade, slim and tall, turns back to @tunde." }) })), "named"),
      { id: "named", result: "fix", says: "body words: slim" });
  });

  it("does not find a describing name in every 'The', nor a title in a name (0.5.139)", () => {
    const characters = [...input().characters, { id: "the-dancer", name: "The Dancer" }, { id: "the-lady-in-white", name: "The Lady in White" },
      { id: "mrs-ojo", name: "Mrs Ojo" }, { id: "young-ayoka", name: "Young Ayoka" }];
    const plain = shot({ description: "@ade turns back to @tunde. The room is loud. Young men laugh at the bar." });
    assert.deepEqual(item(beforeShotChecks(input({ characters, shot: plain })), "named"), { id: "named", result: "pass", says: "Ade, Tunde" });
    const seen = shot({ description: "@ade turns back to @tunde. Behind them the dancer spins, and Mrs Ojo watches." });
    assert.deepEqual(item(beforeShotChecks(input({ characters, shot: seen })), "named"), { id: "named", result: "fix", says: "The Dancer, Ojo not cited" });
  });

  it("holds camera words that fight the film's look: locked off in a handheld film", () => {
    const checks = beforeShotChecks(input({ shot: shot({ camera: "MCU, the camera is locked off and does not move" }) }));
    assert.deepEqual(item(checks, "camera"), { id: "camera", result: "fix", says: "says locked off" });
    assert.deepEqual(beforeShotCount(checks).hardToFix, 1);
    assert.deepEqual(item(beforeShotChecks(input({ look: { camera: { kind: "locked" } }, shot: shot({ camera: "handheld, drifting" }) })), "camera"),
      { id: "camera", result: "fix", says: "says handheld" });
  });

  it("asks for the light to be named and a beat either side of the line, as advice", () => {
    const checks = beforeShotChecks(input({ scene: { script }, look: { camera: { kind: "handheld" } }, shot: shot({ durationSec: 3 }) }));
    assert.deepEqual(item(checks, "light"), { id: "light", result: "fix", says: "none named" });
    assert.deepEqual(item(checks, "beats"), { id: "beats", result: "fix", says: "0.3 s spare" }, "seven words take 2.7 s of 3");
    assert.deepEqual(item(beforeShotChecks(input({ shot: shot({ durationSec: 2.5 }) })), "beats"), { id: "beats", result: "fix", says: "the line overruns" });
    assert.equal(beforeShotCount(checks).hardToFix, 0, "neither holds the press");
  });

  it("times the line by its recording once there is one (0.5.141)", () => {
    // Gold on Gold: estimated, shot 17's line fitted its 6 s and shot 16's 3 s was short; recorded, the other way round.
    const bar = "Ah, the bar. Yes. The bar is very fine tonight. The bar's leg is long.";
    const seventeen = shot({ id: "sh_379", durationSec: 6, audio: { kind: "dialogue", speaker: "tunde", line: bar } });
    assert.deepEqual(item(beforeShotChecks(input({ shot: seventeen })), "beats"), { id: "beats", result: "fix", says: "0.2 s spare" });
    assert.deepEqual(item(beforeShotChecks(input({ shot: seventeen, lineSec: 7.6 })), "beats"), { id: "beats", result: "fix", says: "recorded line runs 7.6 s" });
    assert.deepEqual(item(beforeShotChecks(input({ shot: shot({ durationSec: 3 }), lineSec: 1.84 })), "beats"),
      { id: "beats", result: "pass", says: "1.2 s spare, recorded" });
  });

  it("finds the newest finished recording of the shot's own words", () => {
    const line = shot().audio!.line!;
    const voice = (id: string, completedAt: string | undefined, prompt = line, coversShots = ["sh_13"]) =>
      ({ id, kind: "voice", coversShots, prompt, media: "speech.wav", ...(completedAt ? { completedAt } : {}) });
    const production = {
      takes: [voice("tk_old", "2026-11-24T10:00:00.000Z"), voice("tk_new", "2026-11-25T10:00:00.000Z"),
        voice("tk_running", undefined), voice("tk_reworded", "2026-11-25T11:00:00.000Z", "The goat was in the car, Tunde."),
        voice("tk_other", "2026-11-25T12:00:00.000Z", line, ["sh_14"]), { ...voice("tk_clip", "2026-11-25T13:00:00.000Z"), kind: "clip" }],
      takeMediaInfo: { tk_old: { mediaInfo: { durationSec: 3.1 } }, tk_new: { mediaInfo: { durationSec: 2.2 } }, tk_reworded: { mediaInfo: { durationSec: 9 } },
        tk_other: { mediaInfo: { durationSec: 9 } }, tk_clip: { mediaInfo: { durationSec: 9 } } },
    };
    assert.equal(recordedLineSec(production, shot()), 2.2, "the newest of its own, words matched case and stops aside");
    assert.equal(recordedLineSec(production, shot({ audio: { kind: "dialogue", speaker: "ade", line: "THE GOAT was in the boot, Tunde!" } })), 2.2);
    assert.equal(recordedLineSec({ ...production, takeMediaInfo: {} }, shot()), undefined, "unmeasured, so estimated");
    assert.equal(recordedLineSec(production, shot({ audio: { kind: "dialogue", speaker: "ade", line: "Something else entirely." } })), undefined);
  });

  it("needs a first frame only where clips are made from frames", () => {
    assert.deepEqual(item(beforeShotChecks(input({ hasFrame: false })), "frame"), { id: "frame", result: "fix", says: "none" });
    assert.equal(item(beforeShotChecks(input({ clipsFrom: "references", hasFrame: false })), "frame"), undefined);
  });

  it("says when the shot's board holds others, so it can be made with them", () => {
    assert.deepEqual(item(beforeShotChecks(input({ board: { numbers: [12, 13, 14], seconds: 9.5 } })), "board"),
      { id: "board", result: "fix", says: "with 12–14 · 9.5 s" });
    assert.equal(item(beforeShotChecks(input()), "board"), undefined, "alone in its board, nothing to say");
  });
});
