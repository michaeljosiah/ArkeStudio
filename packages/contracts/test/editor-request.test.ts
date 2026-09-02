import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MIX,
  EditorRequestSchema,
  ProductionTimelineSchema,
  WorldChatTurnResultSchema,
  applyTimelineCommands,
  describeEditorRequestDigest,
  editorRequestStaleness,
  editorRequestUndone,
  previewEditorRequest,
  undoTimelineHistory,
  type ProductionTimeline,
  type TimelineClip,
} from "../src/index.js";

/**
 * Arke's editor requests as pure contracts (SPEC-039 R-27, R-28, R-32..R-34, R-36; issue 684):
 * the typed field is the only way a turn carries one, a preview is the digest a card states and
 * the ghost a timeline draws, and staleness is judged the way the coordinator judges it.
 */

const REQUEST = "req_01J8G0000000000000000000R1";
const FINGERPRINT = `story-picture-v1:${"a".repeat(16)}`;

function clip(id: `cl_${string}`, startFrame: number, durationFrames: number, shotId: string, shotNumber: number): TimelineClip {
  return {
    id,
    startFrame,
    durationFrames,
    sourceInFrames: 0,
    source: { kind: "shot", shotId, sceneNumber: 1, shotNumber, label: shotId },
  };
}

const base: ProductionTimeline = ProductionTimelineSchema.parse({
  schemaVersion: 1,
  revision: 3,
  frameRate: 24,
  tracks: [
    {
      id: "tr_picture",
      kind: "picture",
      name: "Picture",
      order: 0,
      muted: false,
      clips: [clip("cl_sh-1", 0, 48, "sh_1", 1), clip("cl_sh-2", 48, 24, "sh_2", 2), clip("cl_sh-3", 72, 48, "sh_3", 3)],
    },
  ],
  history: { undo: [], redo: [] },
  mix: DEFAULT_MIX,
});

describe("editor requests (issue 684)", () => {
  it("a reply's prose carries no request; only the typed field does (A-7)", () => {
    const prose = WorldChatTurnResultSchema.parse({
      reply: "I moved the bell close-up to the front for you.",
      candidateOperations: [],
      groupOperations: [],
    });
    assert.deepEqual(prose.editorRequests, []);
    const typed = WorldChatTurnResultSchema.parse({
      reply: "Ready for you to accept.",
      candidateOperations: [],
      groupOperations: [],
      editorRequests: [{ summary: "Bring the bell close-up to the front", commands: [{ kind: "move-to-order", clipId: "cl_sh-3", index: 0 }] }],
    });
    assert.equal(typed.editorRequests.length, 1);
    assert.throws(() => WorldChatTurnResultSchema.parse({ ...typed, editorRequests: [{ summary: "", commands: [] }] }));
  });

  it("previews a request as a digest and a ghost, without touching the base", () => {
    const before = JSON.stringify(base);
    const preview = previewEditorRequest(base, [{ kind: "move-to-order", clipId: "cl_sh-3", index: 0 }]);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    assert.ok(preview.digest.moved.includes("sh_3"), "the moved clip is named");
    assert.equal(preview.digest.storyOrderChanges, true);
    assert.deepEqual(preview.digest.range, { startFrame: 0, endFrame: 120 });
    assert.equal(preview.timeline.revision, 4, "the ghost is the base plus one revision, in memory");
    assert.equal(JSON.stringify(base), before, "the base is untouched");
    const lines = describeEditorRequestDigest(preview.digest, 24);
    assert.ok(lines.some((line) => line.startsWith("Moves ")), lines.join(" | "));
    assert.ok(lines.includes("Range 0.0s – 5.0s"));
    assert.ok(lines.includes("Story order changes"));

    const removed = previewEditorRequest(base, [{ kind: "delete", clipId: "cl_sh-2" }]);
    assert.equal(removed.ok, true);
    if (removed.ok) assert.deepEqual(removed.digest.removed, ["sh_2"]);

    const trimmed = previewEditorRequest(base, [{ kind: "trim", clipId: "cl_sh-1", edge: "end", deltaFrames: -12 }]);
    assert.equal(trimmed.ok, true);
    if (trimmed.ok) {
      assert.ok(trimmed.digest.changed.includes("sh_1"));
      assert.equal(trimmed.digest.storyOrderChanges, false);
      assert.ok(describeEditorRequestDigest(trimmed.digest, 24).includes("Story order unchanged"));
    }
  });

  it("refuses a request that cannot apply, with the reason", () => {
    const preview = previewEditorRequest(base, [{ kind: "delete", clipId: "cl_nowhere" }]);
    assert.equal(preview.ok, false);
    if (!preview.ok) assert.match(preview.reason, /cl_nowhere/);
  });

  it("is stale when the base moved, and never rebased", () => {
    const pending = { status: "pending" as const, baseRevision: 3, sourceFingerprint: FINGERPRINT };
    assert.equal(editorRequestStaleness(pending, { status: "ready", timeline: base }, FINGERPRINT), null);
    assert.match(editorRequestStaleness(pending, { status: "ready", timeline: { ...base, revision: 4 } }, FINGERPRINT) ?? "", /revision 4/);
    const first = { ...pending, baseRevision: null };
    assert.equal(editorRequestStaleness(first, { status: "absent" }, FINGERPRINT), null);
    assert.match(editorRequestStaleness(first, { status: "absent" }, `story-picture-v1:${"b".repeat(16)}`) ?? "", /changed/);
    assert.match(editorRequestStaleness(first, { status: "ready", timeline: base }, FINGERPRINT) ?? "", /revision 3/);
    assert.match(editorRequestStaleness(pending, { status: "absent" }, FINGERPRINT) ?? "", /gone/);
    assert.equal(editorRequestStaleness({ ...pending, status: "accepted" }, { status: "ready", timeline: { ...base, revision: 9 } }, FINGERPRINT), null);
  });

  it("keeps an accepted status through Undo and says the action was undone (R-36)", () => {
    const accepted = applyTimelineCommands(base, [{ kind: "move-to-order", clipId: "cl_sh-3", index: 0 }], { requestId: REQUEST, label: "Bring it forward" });
    const record = EditorRequestSchema.parse({
      id: REQUEST,
      productionId: "bell-watch",
      conversationId: "cv_01J8G0000000000000000000C1",
      baseRevision: 3,
      sourceFingerprint: FINGERPRINT,
      commands: [{ kind: "move-to-order", clipId: "cl_sh-3", index: 0 }],
      summary: "Bring it forward",
      createdAt: "2026-09-02T10:00:00Z",
      status: "accepted",
      decidedAt: "2026-09-02T10:01:00Z",
      resultRevision: 4,
    });
    assert.equal(editorRequestUndone(record, { status: "ready", timeline: accepted }), false);
    const undone = undoTimelineHistory(accepted);
    // The mark is on the record, written by the coordinator with the undo; the redo stack is
    // transient and says nothing durable.
    assert.equal(editorRequestUndone(record, { status: "ready", timeline: undone }), false);
    assert.equal(editorRequestUndone({ ...record, undoneAt: "2026-09-02T10:02:00Z" }, { status: "ready", timeline: undone }), true);
    assert.equal(editorRequestUndone({ ...record, status: "rejected", undoneAt: "2026-09-02T10:02:00Z" }), false);
    assert.equal(record.status, "accepted", "the status is not rewritten");
  });
});
