import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SceneSchema, ShotSchema, beatPictureShotId, beatPlayback, deriveRehearsalLines, sceneBeats } from "../src/index.js";

/**
 * A visual novel's scene as beats (turn 172): the walk that the scene page, the player and the
 * table read all read, so a beat's line id and the audio prepared for it cannot disagree.
 */
const cover = (id: string) => ({ blockId: id, textDigest: "sha256:12345678" });

const scene = SceneSchema.parse({
  id: "sc_vn", number: 2, slug: "drowned-quarter", title: "The drowned quarter", status: "draft", version: 3,
  script: {
    blocks: [
      { id: "blk_wash", kind: "action", text: "They hung the washing out the morning the water came." },
      { id: "blk_window", kind: "dialogue", speaker: "maren", text: "Somebody lit a window down there." },
      { id: "blk_reply", kind: "dialogue", speaker: "bray", text: "Then it isn't somebody." },
    ],
  },
  shots: [
    { id: "sh_1", number: 1, title: "Quarter", description: "The quarter", covers: [cover("blk_wash")] },
    // Two blocks on one shot are two beats on one picture.
    { id: "sh_2", number: 2, title: "Rail", description: "Maren at the rail", covers: [cover("blk_reply"), cover("blk_window")] },
    { id: "sh_3", number: 3, title: "Held", description: "", covers: [cover("blk_window")], beat: { samePicture: true, advance: "hold", holdSec: 6 } },
    { id: "sh_4", number: 4, title: "Tower", description: "The tower" },
    { id: "sh_5", number: 5, title: "Legacy", description: "", audio: { kind: "vo", line: "The lighthouse turned once." } },
  ],
});

describe("a scene read as beats", () => {
  it("walks shots in order and covered blocks in script order, reading a block once", () => {
    const beats = sceneBeats(scene);
    assert.deepEqual(
      beats.map((b) => [b.shot.id, b.kind, b.speaker ?? null, b.text]),
      [
        ["sh_1", "narration", null, "They hung the washing out the morning the water came."],
        ["sh_2", "dialogue", "maren", "Somebody lit a window down there."],
        ["sh_2", "dialogue", "bray", "Then it isn't somebody."],
        // blk_window was read by sh_2, so sh_3 is its picture alone.
        ["sh_3", "picture", null, ""],
        ["sh_4", "picture", null, ""],
        ["sh_5", "narration", null, "The lighthouse turned once."],
      ],
    );
  });

  it("names each line by the table read's id, so prepared audio is found by it", () => {
    const beats = sceneBeats(scene);
    const lines = deriveRehearsalLines(scene, [{ id: "maren", type: "character" }, { id: "bray", type: "character" }], { narration: true });
    assert.deepEqual(
      lines.map((l) => [l.id, l.narration ?? false]),
      beats.filter((b) => b.lineId !== undefined).map((b) => [b.lineId, b.kind === "narration"]),
    );
    assert.ok(lines.every((l) => l.reason === undefined), "narration is read by the narrator, not refused for having no speaker");
  });

  it("without narration the table read is the characters' alone, as before", () => {
    const lines = deriveRehearsalLines(scene, [{ id: "maren", type: "character" }, { id: "bray", type: "character" }]);
    assert.ok(lines.every((l) => l.narration === undefined));
    assert.deepEqual(lines.filter((l) => l.reason === undefined).map((l) => l.text), ["Somebody lit a window down there.", "Then it isn't somebody."]);
  });

  it("a beat that keeps the picture before shows the nearest earlier shot with its own", () => {
    const shots = [{ id: "a" }, { id: "b", beat: { samePicture: true } }, { id: "c", beat: { samePicture: true } }, { id: "d" }];
    assert.equal(beatPictureShotId(shots, "c"), "a");
    assert.equal(beatPictureShotId(shots, "d"), "d");
    assert.equal(beatPictureShotId([{ id: "a", beat: { samePicture: true } }], "a"), "a", "the first shot has nothing before it to keep");
  });

  it("plays on the defaults until a beat says otherwise", () => {
    assert.deepEqual(beatPlayback({}), { advance: "tap", holdSec: 4, motion: "push" });
    assert.deepEqual(beatPlayback({ beat: { advance: "hold", holdSec: 6, motion: "none" } }), { advance: "hold", holdSec: 6, motion: "none" });
  });

  it("the beat fields are optional and strict", () => {
    const base = { id: "sh_x", number: 1, title: "X", description: "" };
    assert.ok(ShotSchema.safeParse(base).success, "an old shot still parses");
    assert.ok(ShotSchema.safeParse({ ...base, beat: { advance: "voice", motion: "drift" } }).success);
    assert.ok(!ShotSchema.safeParse({ ...base, beat: { advance: "later" } }).success);
    assert.ok(!ShotSchema.safeParse({ ...base, beat: { speed: 2 } }).success);
  });
});
