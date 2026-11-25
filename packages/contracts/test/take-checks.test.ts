import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentTakeChecks, takeChecksCount, takeIsCheckable, TakeChecksRecordSchema, type TakeChecksRecord } from "../src/index.js";

/** A take's checks (design turn 287): measured once, read only while they are of the take's media. */
const record: TakeChecksRecord = {
  schemaVersion: 1, kind: "after-take", ts: "2026-11-25T12:00:00.000Z", takeId: "tk_01M8CHECK00000000000000001", shotId: "sh_12",
  sourceHash: "sha256:0123456789abcdef",
  items: [{ id: "words", result: "pass", says: "as written" }, { id: "cuts-inside", result: "fix", says: "at 3.0 s", endAtSec: 2.9 },
    { id: "camera", result: "fix", says: "still · asked handheld" }],
  skipped: [{ id: "lip-sync", reason: "no-voice-sent" }],
};

describe("a take's checks", () => {
  it("holds an item measured or skipped, once", () => {
    assert.ok(TakeChecksRecordSchema.safeParse(record).success);
    assert.equal(TakeChecksRecordSchema.safeParse({ ...record, skipped: [{ id: "words", reason: "no-line" }] }).success, false);
  });

  it("is the take's only while it is of the media the take has", () => {
    assert.equal(currentTakeChecks({ [record.takeId]: record }, { id: record.takeId, mediaHash: record.sourceHash }), record);
    assert.equal(currentTakeChecks({ [record.takeId]: record }, { id: record.takeId, mediaHash: "sha256:fedcba9876543210" }), null);
    assert.equal(currentTakeChecks(undefined, { id: record.takeId, mediaHash: record.sourceHash }), null);
  });

  it("counts what passed, and the hard items to fix: a cut inside is, the camera is advice", () => {
    assert.deepEqual(takeChecksCount(record), { passed: 1, of: 3, hardToFix: 1 });
  });

  it("measures a clip of one shot with media of its own, and nothing else", () => {
    const clip = { kind: "clip" as const, media: "clip.mp4", mediaHash: "sha256:0123456789abcdef", coversShots: ["sh_12"], segment: undefined, panel: undefined };
    assert.equal(takeIsCheckable(clip), true);
    assert.equal(takeIsCheckable({ ...clip, kind: "frame" }), false);
    assert.equal(takeIsCheckable({ ...clip, coversShots: ["sh_12", "sh_13"] }), false);
    assert.equal(takeIsCheckable({ ...clip, mediaHash: undefined }), false);
  });
});
