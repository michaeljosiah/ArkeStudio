import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { craftSkill, FILM_DIRECTION_CRAFT, ShotSchema } from "../src/index.js";

/** How Arke chooses a film's shots and keeps them continuous (issues 3273, 3278). */

describe("the film direction craft", () => {
  it("asks for the coverage a director gives a conversation", () => {
    for (const rule of [
      /shows where everyone is/,
      /a shot of both/,
      /over each speaker's shoulder/,
      /the listener's face/,
      /insert/,
      /One speaker's line to a shot/,
      /same camera words/,
      /never cut to fit a total/,
    ]) assert.match(FILM_DIRECTION_CRAFT, rule);
  });

  it("moves the camera and leaves room to split a cut (the owner's notes, 2026-11-25)", () => {
    // About fifty clips of the film were made "locked off" and never breathed; no line crossed a cut.
    assert.match(FILM_DIRECTION_CRAFT, /the camera is handheld and breathes; never write it locked off/);
    assert.match(FILM_DIRECTION_CRAFT, /a beat before and after its line, so a line can run over the listener's face/);
  });

  it("keeps the script's words and never invites a new line", () => {
    assert.match(FILM_DIRECTION_CRAFT, /The words are the script's, exactly: never add, change or drop a line/);
  });

  it("asks for continuity of action, state and props across cuts", () => {
    for (const rule of [/already moving/, /ends before it settles/, /the state the shot before it ended in/, /Name the props/]) {
      assert.match(FILM_DIRECTION_CRAFT, rule);
    }
  });

  it("names only shot fields that exist, with the values they take", () => {
    // The craft tells Arke which field to set; a field the schema does not have would refuse the
    // whole card, so the names are checked against the schema rather than trusted.
    const continuity = ShotSchema.shape.continuity.unwrap();
    assert.ok("openOnPrevious" in continuity.shape);
    assert.ok("clipsFrom" in continuity.shape);
    assert.ok(continuity.shape.clipsFrom.unwrap().options.includes("references"));
    assert.match(FILM_DIRECTION_CRAFT, /continuity\.openOnPrevious/);
    assert.match(FILM_DIRECTION_CRAFT, /continuity\.clipsFrom references/);
  });

  it("keeps bodies and faces to the pictures, and every person seen named", () => {
    assert.match(FILM_DIRECTION_CRAFT, /never what their body or face is like/);
    assert.match(FILM_DIRECTION_CRAFT, /Every person who is seen is @mentioned/);
  });

  it("says when to look at the pictures and how strictly to judge them (design turn 286)", () => {
    // Tested on the film: right in the words, it said every shot opened where the last stopped,
    // and it had not looked; when it looked, it called a changed pose movement.
    assert.match(FILM_DIRECTION_CRAFT, /Words that match prove nothing about the pictures/);
    // Tested again on 0.5.127: planning shot 11 beside shot 10's take, it read neither the skill
    // nor the take, and asked which wrist the bangles were on; reviewing ten shots, it looked only
    // at the middle of each. So: a shot BESIDE one with a take, the read by name, the cut's frames.
    assert.match(FILM_DIRECTION_CRAFT, /Before you plan, review or change a shot beside one that has a take, or review a cut/);
    assert.match(FILM_DIRECTION_CRAFT, /first call read_skill for continuity-across-cuts/);
    assert.match(FILM_DIRECTION_CRAFT, /sample_video at the frames either side of each cut; a contact sheet's middle frames show no cut/);
    assert.match(FILM_DIRECTION_CRAFT, /never ask what a take already shows/);
    // 0.5.128: in a long thread it repeated a wrong earlier finding instead of looking again.
    assert.match(FILM_DIRECTION_CRAFT, /look again each time, never from an earlier turn/);
    assert.match(FILM_DIRECTION_CRAFT, /never explain it away as movement/);
    assert.match(FILM_DIRECTION_CRAFT, /Fix it or change the camera, on a card/);
    assert.ok(craftSkill("continuity-across-cuts"), "the skill it names is shipped");
  });

  it("stays short enough to ride in every video production's thread", () => {
    // 2,600 until 2026-11-25, when it stood at 2,599: the camera and split-cut rules must reach a shot when it is
    // first written, before any skill is read, so they ride here (about 230 characters).
    assert.ok(FILM_DIRECTION_CRAFT.length < 2900, `${FILM_DIRECTION_CRAFT.length} characters`);
  });
});
