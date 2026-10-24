import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentPromptFor, PICTURE_SHAPE_BASELINE, ROSTER } from "../src/index.js";

/**
 * A picture asked for with no shape named takes the shape its use calls for (SPEC-050 R-59). The
 * owner set the three on 2026-10-24, once Arke Player showed each where it belongs: the upright
 * poster, the phone held upright, and everything wide.
 */

const worldBuilder = ROSTER.find((a) => a.name === "world-builder")!;
const flat = (text: string) => text.replace(/\s+/g, " ");

describe("the picture shape baseline", () => {
  it("names a shape for each use", () => {
    const rule = flat(PICTURE_SHAPE_BASELINE);
    assert.match(rule, /A story's cover, upright: 2:3, 1024 × 1536/);
    assert.match(rule, /An audiobook's Tall picture of a moment: 9:16/);
    assert.match(rule, /Everything wide \(key art, a scene, a place, a wide shot, a story's wide cover\): 16:9/);
  });

  it("is a baseline: the person's shape and their work's shape both win", () => {
    const rule = flat(PICTURE_SHAPE_BASELINE);
    assert.match(rule, /When the person has not named a shape/);
    assert.match(rule, /A shape the person names always wins/);
    assert.match(rule, /a production's aspect, or the shapes an audiobook makes its pictures in/);
  });

  it("never asks a route for a shape it does not list", () => {
    // GPT Image 2's direct row lists 1:1, 3:2 and 2:3 and no 16:9, so a wide picture there is 3:2;
    // the ChatGPT route takes its size from the brief, so the brief has to say it.
    const rule = flat(PICTURE_SHAPE_BASELINE);
    assert.match(rule, /Ask a route only for a shape it lists/);
    assert.match(rule, /the nearest one it does, and say which in the reply/);
    assert.match(rule, /name the shape in the brief/);
  });

  it("reaches World Chat in the postscript, so a rewritten brief keeps it", () => {
    assert.ok(worldBuilder.postscript?.includes(PICTURE_SHAPE_BASELINE), "World Chat's postscript carries the baseline");
    assert.ok(!worldBuilder.brief.includes(PICTURE_SHAPE_BASELINE), "and not the brief a person may rewrite");
    assert.ok(worldBuilder.prompt.includes(PICTURE_SHAPE_BASELINE));
    const rewritten = agentPromptFor({ ...worldBuilder, brief: "Talk about the world in the person's own words." });
    assert.ok(rewritten.includes(PICTURE_SHAPE_BASELINE), "a Settings override replaces the brief alone");
  });
});
