import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STAGE_POSES,
  STAGE_POSE_LABELS,
  stageBasePose,
  stageContactAt,
  stageFastTurns,
  stageLookAt,
  stageMarkAt,
  stagingPromptClause,
  StagePerformanceKeySchema,
  type ResolvedShotStaging,
} from "../src/index.js";

/** Poses, contacts and turns (issue 1821, design turn 228d). */

// Ade sits facing +Z; Ife walks up behind him and leans on his left shoulder, looking at him.
const lobby = (): ResolvedShotStaging => ({
  version: 1, keys: [],
  cast: [{ sheetId: "ade", x: 1.3, z: 0, pose: "sit" }, { sheetId: "ife", x: 3.5, z: -2.5 }],
  sets: [{ name: "counter", x: 0, z: -4, w: 3, h: 1.05, d: .7 }],
  performances: [{ sheetId: "ife", keys: [
    { t: 0, x: 3.5, z: -2.5, facing: 0 },
    { t: 2.6, x: 1.35, z: -.6, facing: 0 },
    { t: 3.2, x: 1.35, z: -.6, facing: 0, pose: "lean-on", hand: { side: "left", on: "ade", part: "left shoulder" }, look: "ade" },
  ] }],
});
const names: Record<string, string> = { ade: "Ade", ife: "Ife" };

describe("poses, contacts and turns (issue 1821)", () => {
  it("labels every pose and falls back to a capsule posture in Greybox", () => {
    for (const pose of STAGE_POSES) assert.ok(STAGE_POSE_LABELS[pose]);
    assert.equal(stageBasePose("crouch"), "sit");
    assert.equal(stageBasePose("fall"), "lie");
    assert.equal(stageBasePose("lean-on"), "stand");
    assert.equal(StagePerformanceKeySchema.safeParse({ t: 0, x: 0, z: 0, pose: "dance" }).success, false);
  });

  it("holds a mark's pose, hand and look from its time on", () => {
    const staging = lobby();
    assert.equal(stageMarkAt(staging, "ife", 3)?.pose, undefined, "before the mark, the walk");
    assert.equal(stageMarkAt(staging, "ife", 3.5)?.pose, "lean-on");
    assert.equal(stageContactAt(staging, "ife", 3, 4), null);
  });

  it("puts a hand on the subject's left shoulder by its facing, and on a set's top nearest the reach", () => {
    const staging = lobby();
    const contact = stageContactAt(staging, "ife", 3.5, 4)!;
    assert.equal(contact.side, "left");
    // Ade faces +Z, so his left is +X; seated, his shoulder is lower than a standing one.
    assert.ok(contact.point[0] > 1.3, "on his left");
    assert.ok(contact.point[1] > .9 && contact.point[1] < 1.2, "at a seated shoulder's height");
    assert.ok(stageLookAt(staging, "ife", 3.5, 4)![1] > contact.point[1], "she looks at his head");
    const wiping: ResolvedShotStaging = { ...staging, performances: [{ sheetId: "ife", keys: [{ t: 0, x: 4, z: -3.2, pose: "wipe", hand: { side: "right", on: "counter" } }] }] };
    const top = stageContactAt(wiping, "ife", 1, 4)!;
    assert.equal(top.point[1], 1.05, "on the counter's top");
    assert.equal(top.point[0], 1.5, "at its near end");
  });

  it("finds a turn faster than a person turns, and leaves an ordinary one alone", () => {
    const spin: ResolvedShotStaging = { ...lobby(), performances: [{ sheetId: "ife", keys: [{ t: 2, x: 0, z: 0, facing: 0 }, { t: 2.5, x: 0, z: 0, facing: 200 }, { t: 4, x: 0, z: 0, facing: 230 }] }] };
    const turns = stageFastTurns(spin);
    assert.equal(turns.length, 1);
    assert.equal(Math.round(turns[0]!.degrees), 160, "the short way round");
    assert.ok(turns[0]!.rate > 180);
    assert.match(stagingPromptClause(spin, (id) => names[id] ?? id, 4), /Turning warning — Ife · 160° in 0\.5s/);
  });

  it("says the pose and its target in the prompt", () => {
    const clause = stagingPromptClause(lobby(), (id) => names[id] ?? id, 4);
    assert.match(clause, /^3\.2–4\.0 s · Ife leans on Ade\.$/m);
  });
});
