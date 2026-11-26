import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentTakeChecks, takeCheckSource, takeChecksCount, takeChecksUnchecked, takeIsCheckable, TakeChecksRecordSchema, type Take, type TakeChecksRecord } from "../src/index.js";

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

  const clip = { id: record.takeId, kind: "clip", media: "clip.mp4", mediaHash: record.sourceHash, coversShots: ["sh_12"] } as unknown as Take;
  const pass = { id: "tk_01M8PASS000000000000000001", kind: "clip", media: "pass.mp4", mediaHash: "sha256:aaaaaaaaaaaaaaaa", coversShots: ["sh_12", "sh_13"] } as unknown as Take;
  const segment = { id: "tk_01M8SEGMENT00000000000001", kind: "clip", coversShots: ["sh_13"], segment: { passTakeId: pass.id, inSec: 4, outSec: 7.5 } } as unknown as Take;

  it("is the take's only while it is of the media the take has", () => {
    assert.equal(currentTakeChecks({ takes: [clip], takeChecks: { [record.takeId]: record } }, clip), record);
    assert.equal(currentTakeChecks({ takes: [clip], takeChecks: { [record.takeId]: record } }, { ...clip, mediaHash: "sha256:fedcba9876543210" }), null);
    assert.equal(currentTakeChecks({ takes: [clip] }, clip), null);
  });

  it("counts what passed, and the hard items to fix: a cut inside is, the camera is advice", () => {
    assert.deepEqual(takeChecksCount(record), { passed: 1, of: 3, hardToFix: 1, unchecked: 0 });
  });

  it("counts an item the host could not measure as owed and not passed, never as nothing (2026-11-26)", () => {
    // A take whose words could not be read used to show "2 of 2" in green: the list left the words out.
    const unread: TakeChecksRecord = { ...record, items: [{ id: "cuts-inside", result: "pass", says: "none" }, { id: "camera", result: "pass", says: "handheld · 7 px" }],
      skipped: [{ id: "unwritten-voice", reason: "unavailable" }, { id: "words", reason: "unavailable" }, { id: "lip-sync", reason: "no-voice-sent" }, { id: "light", reason: "no-neighbour" }] };
    assert.deepEqual(takeChecksCount(unread), { passed: 2, of: 4, hardToFix: 0, unchecked: 2 });
    assert.deepEqual(takeChecksUnchecked(unread), ["words", "unwritten-voice"], "in the list's order; what the take has nothing for is not owed");
    assert.deepEqual(takeChecksUnchecked(record), []);
  });

  it("measures a clip of one shot, its own or its range of a pass, and nothing else", () => {
    assert.equal(takeIsCheckable([clip], clip), true);
    assert.equal(takeIsCheckable([clip], { ...clip, kind: "frame" }), false);
    assert.equal(takeIsCheckable([pass], pass), false, "a pass covers several shots");
    assert.equal(takeIsCheckable([clip], { ...clip, mediaHash: undefined }), false);
    // Gold on Gold's chosen takes were all segments of passes (0.5.135).
    assert.deepEqual(takeCheckSource([pass, segment], segment), { mediaTakeId: pass.id, media: "pass.mp4", hash: "sha256:aaaaaaaaaaaaaaaa", startSec: 4, endSec: 7.5 });
    assert.equal(takeIsCheckable([segment], segment), false, "a segment whose pass is not there is not measured");
    const checks = { ...record, takeId: segment.id, sourceHash: "sha256:aaaaaaaaaaaaaaaa" };
    assert.equal(currentTakeChecks({ takes: [pass, segment], takeChecks: { [segment.id]: checks } }, segment), checks, "fenced on the pass's clip");
  });
});
