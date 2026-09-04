import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProductionTimeline } from "@arke-studio/contracts";
import { worldChatContextExists, worldChatSubjectExists } from "../../src/world-chat/context-validation.js";
import { fixtureBundle } from "../index-db/helpers.js";

describe("World Chat context validation", () => {
  it("resolves production, episode and scene identities instead of trusting their shape", async () => {
    const bundle = await fixtureBundle();
    assert.equal(worldChatContextExists(bundle, { kind: "production", productionId: "saltlight" }), true);
    assert.equal(worldChatContextExists(bundle, { kind: "production", productionId: "missing" }), false);
    assert.equal(worldChatContextExists(bundle, { kind: "scene", productionId: "saltlight", sceneId: "sc_04" }), true);
    assert.equal(worldChatContextExists(bundle, { kind: "scene", productionId: "saltlight", sceneId: "sc_999" }), false);
  });

  it("accepts only a track or clip that exists in the context production's current timeline", async () => {
    const bundle = await fixtureBundle();
    const production = bundle.productions.find((entry) => entry.meta.id === "saltlight")!;
    const timeline: ProductionTimeline = {
      schemaVersion: 1,
      revision: 1,
      frameRate: 24,
      history: { undo: [], redo: [] },
      mix: { speechFirst: true, duckingDb: -9, lookAheadMs: 80, releaseMs: 400, limiterCeilingDb: -1 },
      library: [],
      tracks: [{
        id: "tr_picture",
        kind: "picture",
        name: "Picture",
        order: 0,
        muted: false,
        clips: [{
          id: "cl_selected",
          startFrame: 0,
          durationFrames: 24,
          sourceInFrames: 0,
          source: { kind: "shot", shotId: "sh_001", sceneNumber: 1, shotNumber: 1, label: "Shot" },
        }],
      }],
    };
    production.timeline = { status: "ready", timeline };
    const context = { kind: "production" as const, productionId: "saltlight" };

    assert.equal(worldChatSubjectExists(bundle, context, { kind: "timeline-track", trackId: "tr_picture" }), true);
    assert.equal(worldChatSubjectExists(bundle, context, { kind: "timeline-clip", clipId: "cl_selected" }), true);
    assert.equal(worldChatSubjectExists(bundle, context, { kind: "timeline-clip", clipId: "cl_missing" }), false);
    assert.equal(worldChatSubjectExists(bundle, { kind: "world" }, { kind: "timeline-track", trackId: "tr_picture" }), false);
  });
});
