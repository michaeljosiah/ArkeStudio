import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import {
  effectiveFraming,
  SceneSchema,
  ShotSchema,
  shotCoverage,
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
