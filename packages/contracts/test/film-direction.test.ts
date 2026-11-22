import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FILM_DIRECTION_CRAFT, ShotSchema } from "../src/index.js";

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

  it("stays short enough to ride in every video production's thread", () => {
    assert.ok(FILM_DIRECTION_CRAFT.length < 2600, `${FILM_DIRECTION_CRAFT.length} characters`);
  });
});
