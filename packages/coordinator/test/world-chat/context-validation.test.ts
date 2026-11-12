import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProductionTimeline, WorldChatSubject } from "@arke-studio/contracts";
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
    const effectRequest: WorldChatSubject = { kind: "effect-arrangement", scope: { kind: "effects-only",
      target: { kind: "visual-clip", clipId: "cl_selected" }, range: { startFrame: 0, endFrame: 24 },
      audio: { kind: "off" }, direction: "Soft atmosphere", palette: [{ id: "dust", version: 1 }] } };
    assert.equal(worldChatSubjectExists(bundle, context, effectRequest), true);
    assert.equal(worldChatSubjectExists(bundle, context, { ...effectRequest, scope: { ...effectRequest.scope,
      range: { startFrame: 0, endFrame: 25 } } }), false, "effects cannot extend picture delivery");
    assert.equal(worldChatSubjectExists(bundle, context, { ...effectRequest, scope: { ...effectRequest.scope,
      target: { kind: "visual-clip", clipId: "cl_missing" } } }), false);
    assert.equal(worldChatSubjectExists(bundle, context, { ...effectRequest, scope: { ...effectRequest.scope,
      audio: { kind: "source", input: { kind: "audio-track", trackId: "tr_picture" } } } }), false);
    assert.equal(worldChatSubjectExists(bundle, { kind: "scene", productionId: "saltlight", sceneId: "sc_04" }, effectRequest), false);
  });

  it("resolves scene, shot, board, edge, and take subjects within the conversation production", async () => {
    const bundle = await fixtureBundle();
    const context = { kind: "scene" as const, productionId: "saltlight", sceneId: "sc_04" };

    assert.equal(worldChatSubjectExists(bundle, context, { kind: "scene", sceneId: "sc_04" }), true);
    assert.equal(worldChatSubjectExists(bundle, context, { kind: "shot", sceneId: "sc_04", shotId: "sh_12" }), true);
    assert.equal(worldChatSubjectExists(bundle, context, { kind: "board", sceneId: "sc_04", memberShotIds: ["sh_12", "sh_13"] }), true);
    assert.equal(worldChatSubjectExists(bundle, context, { kind: "edge", sceneId: "sc_04", fromShotId: "sh_12", toShotId: "sh_13" }), true);
    assert.equal(worldChatSubjectExists(bundle, context, { kind: "edge", sceneId: "sc_04", fromShotId: null, toShotId: null }), false);
    assert.equal(worldChatSubjectExists(bundle, context, { kind: "shot", sceneId: "sc_04", shotId: "sh_missing" }), false);
    assert.equal(worldChatSubjectExists(bundle, context, { kind: "scene", sceneId: "sc_02" }), false);
    assert.equal(
      worldChatSubjectExists(bundle, context, { kind: "take", takeId: "tk_01J8F0000000000000000000B2" }),
      true,
    );
    assert.equal(
      worldChatSubjectExists(bundle, { kind: "world" }, { kind: "take", takeId: "tk_01J8F0000000000000000000B2" }),
      false,
    );
  });
});
