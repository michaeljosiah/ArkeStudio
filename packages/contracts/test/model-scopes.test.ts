import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorldMetaSchema, scopedModelId } from "../src/index.js";
import { applyProductionSetupUpdate } from "../src/production-setup.js";
import { draft } from "./production-setup.test.js";

/**
 * Two scopes, one parent (design turn 153). A world and a production each keep an optional model
 * per capability; an absent entry follows Settings rather than holding a copy of it.
 */
describe("a scope's own model", () => {
  it("answers with the scope's choice first and Settings' default after, saying which", () => {
    assert.deepEqual(scopedModelId({ image: "chosen" }, { image: "routed" }, "image"), { id: "chosen", source: "scope" });
    assert.deepEqual(scopedModelId({ video: "chosen" }, { image: "routed" }, "image"), { id: "routed", source: "default" });
    assert.deepEqual(scopedModelId(undefined, {}, "image"), { id: undefined, source: "default" });
  });

  it("is an optional field of world.json, so a world that never chose reads exactly as before", () => {
    const meta = {
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", slug: "the-undersong", schemaVersion: 1, name: "The Undersong",
      canonRevision: 0, nextCanonId: 1, created: "2026-09-24T09:00:00.000Z", updated: "2026-09-24T09:00:00.000Z",
    };
    assert.equal(WorldMetaSchema.parse(meta).models, undefined);
    assert.deepEqual(WorldMetaSchema.parse({ ...meta, models: { image: "chosen" } }).models, { image: "chosen" });
    assert.throws(() => WorldMetaSchema.parse({ ...meta, models: { sculpture: "chosen" } }), "only capabilities are keys");
  });

  it("keeps the setup card's models on the draft, and removes the key when the last is cleared", () => {
    const chosen = applyProductionSetupUpdate(draft(), { expectedRevision: 1, fields: { models: { video: "kling-3" } } });
    assert.deepEqual(chosen.models, { video: "kling-3" });
    const kept = applyProductionSetupUpdate(chosen, { expectedRevision: 2, fields: { title: "A new title" } });
    assert.deepEqual(kept.models, { video: "kling-3" }, "an unrelated edit leaves the choice alone");
    const cleared = applyProductionSetupUpdate(kept, { expectedRevision: 3, fields: { models: {} } });
    assert.equal(cleared.models, undefined);
    // Written as JSON, where an undefined field is no field — the same way `series` and
    // `defaults` clear on this draft.
    assert.equal("models" in JSON.parse(JSON.stringify(cleared)), false);
  });
});
