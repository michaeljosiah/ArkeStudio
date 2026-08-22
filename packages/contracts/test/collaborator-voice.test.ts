import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROSTER, worldChatResultShapeGuide } from "../src/index.js";

/**
 * Arke talks like a collaborator (2026-08-22).
 *
 * Driven from scratch on a real idea: the studio built a world, a cast and four good open
 * threads — and said one line in the chat. "Draft saved. Answer the aunt question and I'll build
 * the middle act out from it." All the thinking went to the panel, because the brief said
 * "reply as a person would" once and then spent forty lines on the record, so the record is what
 * the model optimised. The reply needed its own weight and its own rules.
 */

const worldBuilder = ROSTER.find((a) => a.name === "world-builder")!;

describe("the reply is the collaboration, not a receipt", () => {
  it("the brief asks for reaction, opinion and one real question", () => {
    const brief = worldBuilder.brief;
    assert.match(brief, /React to the idea before you file it/);
    assert.match(brief, /say which you would take, and why/, "a collaborator has opinions");
    assert.match(brief, /Offer what they did not ask for/);
    assert.match(brief, /End on one real question/);
    assert.match(brief, /Name what you changed your mind about/);
  });

  it("bare acknowledgements are named and refused", () => {
    const brief = worldBuilder.brief;
    assert.match(brief, /never reply with only an acknowledgement/);
    for (const tell of ["noted", "draft saved", "I've recorded that"]) {
      assert.ok(brief.includes(tell), `the brief names "${tell}" as the thing not to do`);
    }
  });

  it("and length still follows the turn, so this is not licence to pad", () => {
    assert.match(worldBuilder.brief, /Length follows the turn/);
    assert.match(worldBuilder.brief, /Never pad/);
  });

  it("the reply still never narrates the interface (turn 69)", () => {
    const brief = worldBuilder.brief;
    // The brief is hard-wrapped, so every phrase is matched across whatever newline fell in it.
    const flat = brief.replace(/\s+/g, " ");
    assert.match(flat, /never describes the screens or narrates the application/);
    assert.match(flat, /Talk about the story; the interface explains itself/);
    assert.match(flat, /no references to the operations/i, "and never points at the panel");
  });

  it("the worked example demonstrates the voice, because the example is the real instruction", () => {
    // An acknowledgement here teaches filing-and-saying-nothing however well the prose above
    // reads, so the example is asserted on directly rather than trusted.
    const guide = worldChatResultShapeGuide().replace(/\s+/g, " ");
    assert.match(guide, /I would take the second/, "it recommends, rather than listing options");
    assert.match(guide, /Who taught her the count\?/, "and ends on one real question");
    assert.doesNotMatch(guide, /"reply": "Noted/, "the example never opens by filing the request");
  });
});
