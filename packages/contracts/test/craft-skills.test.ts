import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRAFT_SKILLS, CRAFT_SKILLS_LINE, craftSkill } from "../src/index.js";

/** Craft skills Arke reads by task in a chat thread (design turn 286). */

describe("craft skills", () => {
  it("are named once each, by an id that cannot be a path", () => {
    const ids = CRAFT_SKILLS.map((skill) => skill.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const skill of CRAFT_SKILLS) {
      assert.match(skill.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
      assert.equal(skill.bodyPath, `${skill.id}.md`);
      assert.ok(Number.isInteger(skill.version) && skill.version >= 1);
    }
  });

  it("the line every video thread carries names each skill, when to read it, and the read", () => {
    assert.match(CRAFT_SKILLS_LINE, /read_skill/);
    for (const skill of CRAFT_SKILLS) assert.ok(CRAFT_SKILLS_LINE.includes(`${skill.id} (read it ${skill.when})`), skill.id);
  });

  it("looks a skill up by id and nothing else", () => {
    assert.equal(craftSkill("continuity-across-cuts")?.title, "Continuity across cuts");
    assert.equal(craftSkill("continuity-across-cuts.md"), null);
    assert.equal(craftSkill(""), null);
  });
});
