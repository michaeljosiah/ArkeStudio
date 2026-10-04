import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelWorldChatActionSchema, ProductionChatTurnResultSchema, WorldChatTurnResultSchema,
  WORLD_CHAT_SHAPE_EXAMPLES, turnActionDependencyIndexes, turnActionGroups } from "../src/index.js";

describe("turn-local action sequencing (SPEC-051 R-14/R-17)", () => {
  it("accepts ref and after on every model action kind", () => {
    for (const action of Object.values(WORLD_CHAT_SHAPE_EXAMPLES.worldActions)) {
      assert.equal(ModelWorldChatActionSchema.safeParse({ ...action, ref: "first", after: [] }).success, true, action.kind);
    }
  });
  it("maps only earlier refs in the current turn and rejects malformed dependency graphs", () => {
    assert.deepEqual(turnActionDependencyIndexes([{ ref: "first" }, { ref: "second", after: ["first"] }, { after: ["first", "second"] }]), [[], [0], [0, 1]]);
    assert.throws(() => turnActionDependencyIndexes([{ ref: "same" }, { ref: "same" }]), /repeated/);
    assert.throws(() => turnActionDependencyIndexes([{ after: ["previous_turn"] }]), /not in this turn/);
    assert.throws(() => turnActionDependencyIndexes([{ after: ["later"] }, { ref: "later" }]), /earlier action/);
    assert.throws(() => turnActionDependencyIndexes([{ ref: "a", after: ["b"] }, { ref: "b", after: ["a"] }]), /cycle/);
    assert.throws(() => turnActionDependencyIndexes([{ ref: "a" }, { after: ["a", "a"] }]), /repeats/);
  });
  it("allows 24 actions and six editor requests only in the production transport schema", () => {
    const action = WORLD_CHAT_SHAPE_EXAMPLES.worldActions["production-scene-command"];
    const request = { summary: "Bring the bell close-up forward", commands: [{ kind: "move-to-order", clipId: "cl_sh-3", index: 0 }] };
    const result = { reply: "Ready to review.", candidateOperations: [], groupOperations: [],
      actions: Array.from({ length: 24 }, () => action), editorRequests: Array.from({ length: 6 }, () => request) };
    assert.equal(ProductionChatTurnResultSchema.safeParse(result).success, true);
    assert.equal(WorldChatTurnResultSchema.safeParse(result).success, false);
    assert.equal(ProductionChatTurnResultSchema.safeParse({ ...result, actions: [...result.actions, action] }).success, false);
    assert.equal(ProductionChatTurnResultSchema.safeParse({ ...result, editorRequests: [...result.editorRequests, request] }).success, false);
  });
  it("enforces the aggregate scene cap and retains explicit dependency boundaries", () => {
    const action = { kind: "production-scene-command", productionId: "saltlight", sceneId: "sc_04", ref: "first",
      commands: Array.from({ length: 24 }, () => ({ kind: "edit-scene", title: "The bell" })) };
    const next = { kind: action.kind, productionId: action.productionId, sceneId: action.sceneId, command: { kind: "edit-scene", title: "The tide" } };
    assert.throws(() => turnActionGroups([action, next]), /at most 24 commands/);
    assert.deepEqual(turnActionGroups([action, { ...next, after: ["first"] }]), [{ members: [0], dependencies: [] }, { members: [1], dependencies: [0] }]);
  });
});
