import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { skillFor, skillLabel, SKILLS } from "../src/skills.js";
import { skillForAgent } from "../src/agent-session.js";

/**
 * Which document a model is handed (2026-08-23).
 *
 * Skills are keyed by family because two routes of one model answer the same conventions. Two
 * *versions* of a model need not: Seedance 2.5 takes thirty seconds where 2.0 stops at fifteen,
 * and thirty seconds is a sequence with movements where fifteen is a shot or two. A document that
 * hedged across both would fit neither, so a skill may narrow to the models it names — and the
 * family's own must still answer for everything it does not.
 */
describe("choosing a skill", () => {
  it("hands a narrowed model its own document, not the family's", () => {
    const family = skillFor("scene-drafting", "seedance");
    const narrowed = skillFor("scene-drafting", "seedance", "seedance-2.5");
    assert.ok(family && narrowed, "both resolve");
    assert.notEqual(narrowed.id, family.id, "2.5 is not handed the family document");
    assert.match(narrowed.body, /thirty seconds/, "and its own says what is different about it");
  });

  it("falls back to the family for a model with nothing of its own", () => {
    const family = skillFor("scene-drafting", "seedance");
    for (const id of ["seedance-2.0", "seedance-2.0-fast", "some-future-route"]) {
      assert.equal(
        skillFor("scene-drafting", "seedance", id)?.id,
        family?.id,
        `${id} still gets advice`,
      );
    }
  });

  it("answers the same as before when no model is named", () => {
    // Every existing caller passes two arguments. Adding a third must not move them.
    assert.equal(skillFor("scene-drafting", "seedance")?.id, "seedance-scene-drafting");
    assert.equal(skillFor("storyboard", "seedance")?.id, "seedance-storyboard");
  });

  it("never borrows another family's advice", () => {
    assert.equal(skillFor("scene-drafting", "veo"), null);
    assert.equal(skillFor("scene-drafting", "veo", "veo-3.1"), null);
    assert.equal(skillFor("scene-drafting", undefined), null);
  });

  it("keeps every narrowed skill inside a family that has a general one", () => {
    // A narrowed document that is the family's only document is a family whose other models
    // silently lose their advice — the fallback above would answer null for them.
    for (const skill of SKILLS.filter((s) => s.models !== undefined)) {
      assert.ok(
        SKILLS.some((s) => s.purpose === skill.purpose && s.family === skill.family && s.models === undefined),
        `${skill.id} narrows a family that also has a general ${skill.purpose} document`,
      );
    }
  });

  it("gives each document a distinct label, so a proposal records which one shaped it", () => {
    const labels = SKILLS.map(skillLabel);
    assert.equal(new Set(labels).size, labels.length, `distinct: ${labels.join(", ")}`);
  });
});

/**
 * The guidance only describes fields that actually reach the model.
 *
 * Until 2026-08-23 `framing` and `continuity.keepOut` were authored, versioned, shown in the UI
 * and dropped before the prompt was built. Advice about a field with no effect is the worst kind:
 * it reads as a promise and produces nothing.
 */
describe("what the seedance document teaches", () => {
  const body = skillFor("scene-drafting", "seedance")!.body;

  it("teaches the framing fields the prompt now carries", () => {
    assert.match(body, /\*\*Framing\.\*\*/);
    for (const field of ["size", "angle", "lens", "focus", "movement", "pace", "lighting"]) {
      assert.ok(body.includes(field), `${field} is named`);
    }
  });

  it("teaches a keep-out as a negative rather than as description", () => {
    assert.match(body, /keep out/i);
    // The reason is the point: a thing named in the description is a thing you handed the model.
    assert.match(body, /wristwatch/);
  });

  it("still refuses per-second phases inside one shot", () => {
    // Turn 97: `beats[].span` is a label, not a machine timeline, and a shot is one setup.
    assert.match(body, /In the first 3 seconds/);
    assert.match(skillFor("scene-drafting", "seedance", "seedance-2.5")!.body, /not permission to write/);
  });
});

/**
 * Findings from the first review round (codex, 2026-08-23), each a way the new narrowing could
 * have been true on paper and false in the app.
 */
describe("a narrowed skill, end to end", () => {
  it("is what the session actually injects, not just what the record claims", () => {
    // The coordinator resolved and recorded the 2.5 document while the session, handed only the
    // family, injected the general one — so a 2.5 scene was drafted under 2.0's guidance and its
    // proposal said otherwise. A record naming a document the drafting never saw is worse than none.
    assert.equal(skillForAgent("scene-writer", "seedance", "seedance-2.5")?.id, "seedance-2.5-scene-drafting");
    assert.equal(skillForAgent("scene-writer", "seedance", "seedance-2.0")?.id, "seedance-scene-drafting");
    assert.equal(skillForAgent("scene-writer", "seedance")?.id, "seedance-scene-drafting");
    // An agent that answers rather than authors still takes none, whatever the model.
    assert.equal(skillForAgent("world-builder", "seedance", "seedance-2.5"), null);
  });

  it("does not tell an author to write a reference index it cannot know", () => {
    // References are chosen, budgeted and numbered at dispatch, per shot. An author writing
    // @Image2 into scene prose is guessing at a slot that does not exist yet.
    const body = skillFor("scene-drafting", "seedance", "seedance-2.5")!.body;
    assert.match(body, /never\s+write @Image1/i, "the instruction is a prohibition, not an invitation");
    assert.match(body, /not knowable when you\s+are writing/i, "and it says why");
  });
});
