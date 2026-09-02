import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MIX,
  ProductionTimelineSchema,
  TimelineOperationRefused,
  applyTimelineCommands,
  undoTimelineHistory,
  type ProductionTimeline,
} from "../src/index.js";

/**
 * A history entry records one kind per track id (round three of PR 696). A batch that removed a
 * Music track and re-added the id as a Picture track would replay its undo onto the wrong kind,
 * so the id is refused inside the batch; the same kind may come and go freely.
 */
const base: ProductionTimeline = ProductionTimelineSchema.parse({
  schemaVersion: 1,
  revision: 0,
  frameRate: 24,
  tracks: [{ id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [] }],
  history: { undo: [], redo: [] },
  mix: DEFAULT_MIX,
});

describe("a track id keeps its kind inside one batch", () => {
  it("refuses a removal and re-addition under another kind", () => {
    const withMusic = applyTimelineCommands(base, [{ kind: "add-track", trackId: "tr_bed", trackKind: "music", name: "Bed" }]);
    assert.throws(
      () =>
        applyTimelineCommands(withMusic, [
          { kind: "remove-track", trackId: "tr_bed" },
          { kind: "add-track", trackId: "tr_bed", trackKind: "picture", name: "Bed" },
        ]),
      (error: unknown) => error instanceof TimelineOperationRefused && /cannot return as picture/.test(error.reason),
    );
    assert.throws(
      () =>
        applyTimelineCommands(withMusic, [
          { kind: "remove-track", trackId: "tr_bed" },
          { kind: "add-subtitle-track", trackId: "tr_bed", name: "Bed", language: "en" },
        ]),
      (error: unknown) => error instanceof TimelineOperationRefused && /cannot return as subtitle/.test(error.reason),
    );
  });

  it("lets the same kind come back, and undoes that exactly", () => {
    const withMusic = applyTimelineCommands(base, [{ kind: "add-track", trackId: "tr_bed", trackKind: "music", name: "Bed" }]);
    const renamed = applyTimelineCommands(withMusic, [
      { kind: "remove-track", trackId: "tr_bed" },
      { kind: "add-track", trackId: "tr_bed", trackKind: "music", name: "Bed again", order: 5 },
    ]);
    const bed = renamed.tracks.find((track) => track.id === "tr_bed")!;
    assert.equal(bed.name, "Bed again");
    assert.equal(bed.order, 5);
    const undone = undoTimelineHistory(renamed);
    const restored = undone.tracks.find((track) => track.id === "tr_bed")!;
    assert.equal(restored.kind, "music");
    assert.equal(restored.name, "Bed");
    assert.equal(restored.order, 1);
    ProductionTimelineSchema.parse(undone);
  });
});
