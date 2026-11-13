import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROSTER, STAGE_DIRECTION_BRIEF, STAGE_DIRECTION_EXAMPLES, StageConstructionDraftSchema, stageDesignerBrief, stageSolveDraftWords } from "../src/index.js";

/** The stage-designer's reference (issue 1822). */

describe("the Stage direction brief (issue 1822)", () => {
  it("covers the craft a blockout needs, as sections", () => {
    for (const heading of ["Composition", "Coverage", "Camera moves", "Blocking", "Posing", "Building the set", "Writing the camera"]) {
      assert.match(STAGE_DIRECTION_BRIEF, new RegExp(`^## ${heading}$`, "m"), heading);
    }
    assert.doesNotMatch(STAGE_DIRECTION_BRIEF, /burgundy|ochre/, "no stale cast colours");
  });

  it("gives worked examples that are valid drafts once their worded keys are solved", () => {
    assert.ok(STAGE_DIRECTION_EXAMPLES.length >= 3);
    for (const example of STAGE_DIRECTION_EXAMPLES) {
      const keys = (example.draft as { staging: { keys: Array<{ t: number }> } }).staging.keys;
      const duration = keys.at(-1)!.t;
      const solved = stageSolveDraftWords(example.draft, duration, "16:9", "35 mm");
      const parsed = StageConstructionDraftSchema.safeParse(solved);
      assert.ok(parsed.success, `${example.shot}: ${parsed.success ? "" : parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
      assert.ok(parsed.data.staging.keys.every((key) => key.frame !== undefined), "the examples write the camera in words");
    }
  });

  it("is what the stage-designer reads", () => {
    const designer = ROSTER.find((agent) => agent.name === "stage-designer");
    assert.equal(designer?.brief, stageDesignerBrief());
    assert.match(designer?.brief ?? "", /## Worked examples/);
  });
});
