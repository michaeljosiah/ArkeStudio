import assert from "node:assert/strict";
import { it } from "node:test";
import { ProductionCardPreviewSchema, timelineReviewMarks } from "../src/production-card-preview.js";
import { ConversationExportStateSchema } from "../src/arke-actions.js";
import { ProductionTimelineSchema, applyTimelineCommands } from "../src/timeline.js";
import { newId } from "../src/ids.js";

it("marks inserted, removed and changed frozen clips without reading live selections", () => {
  const before = ProductionTimelineSchema.parse({ schemaVersion: 1, revision: 0, frameRate: 24, history: { undo: [], redo: [] },
    tracks: [{ id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [
      { id: "cl_old", startFrame: 0, durationFrames: 24, source: { kind: "shot", shotId: "sh_1", sceneNumber: 1, shotNumber: 1, label: "First" } },
      { id: "cl_changed", startFrame: 24, durationFrames: 24, source: { kind: "shot", shotId: "sh_2", sceneNumber: 1, shotNumber: 2, label: "Second" } },
    ] }] });
  const after = applyTimelineCommands(before, [{ kind: "delete", clipId: "cl_old" }, { kind: "place", trackId: "tr_picture", clip: { ...before.tracks[0]!.clips[0]!, id: "cl_new" } }]);
  const preview = { kind: "timeline" as const, before, after, beforeSelections: {}, afterSelections: { sh_2: { acceptedTakeId: newId("tk"), trimInSec: 0 } }, range: { startFrame: 0, endFrame: 48 } };
  assert.equal(ProductionCardPreviewSchema.safeParse(preview).success, true);
  const marks = timelineReviewMarks(preview);
  assert.equal(marks.before.get("cl_old"), "removed"); assert.equal(marks.after.get("cl_new"), "inserted");
  assert.equal(marks.before.get("cl_changed"), "changed"); assert.equal(marks.after.get("cl_changed"), "changed");
});
it("retains legacy scene/production variants and keeps export projection addresses confined", () => {
  assert.equal(ProductionCardPreviewSchema.safeParse({ kind: "production", title: "Film", medium: "video", productionKind: "film", aspect: "16:9", frameRate: 24, series: null, season: null, episodes: 0, style: null, model: null }).success, true);
  assert.equal(ConversationExportStateSchema.safeParse({ status: "done", percent: 100, output: "exports/review.mp4" }).success, true);
  for (const output of ["C:/private.mp4", "exports/../private.mp4", "https://example.com/a.mp4", "artifacts/a.mp4"]) {
    assert.equal(ConversationExportStateSchema.safeParse({ status: "done", percent: 100, output }).success, false);
  }
});
