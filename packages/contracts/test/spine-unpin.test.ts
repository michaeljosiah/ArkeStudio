import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AudioSpineCommandSchema,
  AudioSpineOperationRefused,
  applyAudioSpineCommand,
  type ProductionSpine,
} from "../src/index.js";

/**
 * Unpinning several shots at once (issue 3136). Removing a pinned scene's four shots took one
 * unpin card for each, chained, before the deletion: five approvals for one request.
 */
const AT = "2026-11-15T09:00:00.000Z";
const LATER = "2026-11-15T10:00:00.000Z";
const SHOTS = ["sh_01", "sh_02", "sh_03", "sh_04"];

function pinned(): ProductionSpine {
  return {
    schemaVersion: 1,
    revision: 5,
    trackArtifactId: "ar_01J8G0000000000000000000R1",
    markers: [],
    anchors: Object.fromEntries(SHOTS.map((shotId, index) => [shotId, { startSec: index * 4, endSec: index * 4 + 4, clipAudio: { mode: "mute" as const } }])),
    updatedAt: AT,
  };
}

describe("delete-anchors (issue 3136)", () => {
  it("unpins every shot it names as one revision, and leaves the rest pinned", () => {
    const next = applyAudioSpineCommand(pinned(), { kind: "delete-anchors", shotIds: ["sh_01", "sh_02", "sh_03"] }, LATER)!;
    assert.equal(next.revision, 6, "one revision, however many shots");
    assert.deepEqual(Object.keys(next.anchors), ["sh_04"]);
    assert.equal(next.updatedAt, LATER);
    assert.deepEqual(applyAudioSpineCommand(pinned(), { kind: "delete-anchors", shotIds: SHOTS }, LATER)!.anchors, {});
  });

  it("refuses the whole list when one shot on it is not pinned or is named twice", () => {
    const before = pinned();
    assert.throws(
      () => applyAudioSpineCommand(before, { kind: "delete-anchors", shotIds: ["sh_01", "sh_09"] }, LATER),
      (error) => error instanceof AudioSpineOperationRefused && error.reason === "shot sh_09 is not anchored",
    );
    assert.throws(
      () => applyAudioSpineCommand(before, { kind: "delete-anchors", shotIds: ["sh_01", "sh_02", "sh_01"] }, LATER),
      (error) => error instanceof AudioSpineOperationRefused && error.reason === "shot sh_01 is named twice",
    );
    assert.deepEqual(before, pinned(), "a refusal changes nothing");
  });

  it("takes a list of shot ids and nothing else", () => {
    assert.equal(AudioSpineCommandSchema.safeParse({ kind: "delete-anchors", shotIds: SHOTS }).success, true);
    assert.equal(AudioSpineCommandSchema.safeParse({ kind: "delete-anchors", shotIds: [] }).success, false, "an empty list unpins nothing");
    assert.equal(AudioSpineCommandSchema.safeParse({ kind: "delete-anchors", shotId: "sh_01" }).success, false);
    assert.equal(AudioSpineCommandSchema.safeParse({ kind: "delete-anchors", shotIds: SHOTS, sceneId: "sc_01" }).success, false);
  });
});
