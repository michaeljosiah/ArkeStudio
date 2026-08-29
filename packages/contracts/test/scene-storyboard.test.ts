import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import {
  chooseReferenceSteering,
  effectiveFraming,
  SceneSchema,
  ShotSchema,
  shotCoverage,
  type ManifestModel,
  type Scene,
  type Selections,
} from "../src/index.js";

/**
 * Turn 97's derivations: the structured camera inherits by absence, and coverage staleness is
 * a digest comparison — computed every time, stored nowhere, so no flag can disagree.
 */

const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

describe("the structured camera (turn 97, 14d)", () => {
  it("a shot's framing wins field by field; absence inherits the scene default", () => {
    const framing = effectiveFraming(
      { defaults: { size: "Medium", angle: "Eye level", lens: "50mm" } },
      { framing: { size: "Close-up" } },
    );
    assert.equal(framing.size, "Close-up", "presence is the override");
    assert.equal(framing.angle, "Eye level", "absence inherits");
    assert.equal(framing.lens, "50mm");
  });

  it("no defaults and no framing is an ordinary empty camera, not an error", () => {
    assert.deepEqual(effectiveFraming({}, {}), {});
  });

  it("a scene written before turn 97 parses unchanged — the widening is optional everywhere", () => {
    const scene = SceneSchema.parse({
      id: "sc_1",
      number: 1,
      slug: "old",
      title: "Old",
      status: "accepted",
      version: 1,
      shots: [{ id: "sh_1", number: 1, title: "One", description: "" }],
    });
    assert.equal(scene.synopsis, undefined);
    assert.equal(scene.defaults, undefined);
    assert.equal(scene.shots[0]!.framing, undefined);
  });

  it("the widened shot round-trips: intent, beats, framing, continuity, ambience", () => {
    const shot = ShotSchema.parse({
      id: "sh_2",
      number: 2,
      title: "Two",
      description: "@maren waits.",
      intent: "Held breath.",
      beats: [{ span: "0–2s", text: "Nothing moves" }],
      framing: { size: "Wide", grade: "salt haze" },
      continuity: { openOnPrevious: true, keepOut: "text, lens flare" },
      audio: { kind: "sfx", ambience: "harbour swell", effects: "rope creak" },
    });
    assert.equal(shot.intent, "Held breath.");
    assert.deepEqual(shot.beats, [{ span: "0–2s", text: "Nothing moves" }]);
    assert.equal(shot.framing?.size, "Wide");
    assert.equal(shot.continuity?.openOnPrevious, true);
    assert.equal(shot.audio?.ambience, "harbour swell");
  });
});

describe("coverage, derived (SPEC-023 R-13 · turn 97's Re-read chip)", () => {
  const blocks = new Map([
    ["blk_a", digest("She waits.")],
    ["blk_b", digest("The bell answers.")],
  ]);

  it("no covers recorded is unlinked — an ordinary shot, not a stale one", () => {
    assert.equal(shotCoverage({}, blocks), "unlinked");
    assert.equal(shotCoverage({ covers: [] }, blocks), "unlinked");
  });

  it("matching digests are fresh; a changed block derives changed", () => {
    const fresh = { covers: [{ blockId: "blk_a", textDigest: digest("She waits.") }] };
    assert.equal(shotCoverage(fresh, blocks), "fresh");
    const changed = { covers: [{ blockId: "blk_a", textDigest: digest("She waited.") }] };
    assert.equal(shotCoverage(changed, blocks), "changed");
  });

  it("a truncated stored digest still compares — prefix against the shorter of the two", () => {
    const short = digest("She waits.").slice(0, "sha256:".length + 12);
    assert.equal(shotCoverage({ covers: [{ blockId: "blk_a", textDigest: short }] }, blocks), "fresh");
  });

  it("a cited block that no longer exists derives uncovered, and outranks changed", () => {
    const gone = {
      covers: [
        { blockId: "blk_a", textDigest: digest("She waited.") },
        { blockId: "blk_gone", textDigest: digest("anything") },
      ],
    };
    assert.equal(shotCoverage(gone, blocks), "uncovered");
  });
});

describe("steering counts artifact-backed frames (SPEC-036)", () => {
  /*
   * SPEC-036 files every frame — drawn, chained, accepted — as an image artifact in
   * `startFrameArtifactId` and clears the take pointer in the same commit. A derivation that
   * reads only the take pointers reports "no frames" for a scene the dispatch would in fact
   * steer with every one of them.
   */
  const model = {
    displayName: "seedance-like",
    capability: "video",
    accepts: { referenceImages: 4 },
  } as unknown as ManifestModel;
  const scene = {
    id: "sc_01",
    number: 1,
    shots: [
      { id: "sh_1", number: 1, description: "one" },
      { id: "sh_2", number: 2, description: "two" },
    ],
  } as unknown as Scene;

  it("chooses keyframes when every shot is framed through the artifact slot", () => {
    const selections = {
      sh_1: { trimInSec: 0, startFrameArtifactId: "ar_01J8E0000000000000000000D1", startFrameTakeId: null },
      sh_2: { trimInSec: 0, startFrameArtifactId: "ar_01J8E0000000000000000000D2", startFrameTakeId: null },
    } as unknown as Selections;
    const steering = chooseReferenceSteering({ scene, selections, model });
    assert.equal(steering.mode, "keyframes", steering.statement);
  });

  it("the pinned artifact outranks the take pointers, matching what the dispatch sends", () => {
    const selections = {
      sh_1: {
        trimInSec: 0,
        startFrameArtifactId: "ar_01J8E0000000000000000000D3",
        startFrameTakeId: "tk_01J8E0000000000000000000D4",
      },
      sh_2: { trimInSec: 0, startFrameTakeId: "tk_01J8E0000000000000000000D5" },
    } as unknown as Selections;
    const steering = chooseReferenceSteering({ scene, selections, model });
    assert.equal(steering.mode, "keyframes");
    assert.ok(steering.mode === "keyframes");
    assert.equal(steering.frames[0]!.takeId, "ar_01J8E0000000000000000000D3");
    assert.equal(steering.frames[1]!.takeId, "tk_01J8E0000000000000000000D5");
  });
});
