import assert from "node:assert/strict";
import { it } from "node:test";
import type { ModelInfo } from "@arke-studio/contracts";
import { preflightChapterReview } from "../../src/productions/chapter-review-preflight.js";
import { ReadModel } from "../../src/read-model.js";

const source = { images: [], record: null };
const models: ModelInfo[] = [
  { id: "writer", provider: "test", isDefault: true, inputModalities: ["text"] },
  { id: "vision", provider: "test", inputModalities: ["text", "image"] },
];
const deps = () => ({ models: async () => models, app: () => new ReadModel("test").getState().app,
  sessionInput: () => ({}), override: (_agent: string): string | undefined => undefined, cloudAllowed: async () => true });
it("awaits startup discovery, then uses the production choice without calling a model", async () => {
  let resolve!: (value: ModelInfo[]) => void, settled = false;
  const pending = preflightChapterReview(source, ["script"], { ...deps(), productionModel: "test/vision", models: () => new Promise(r => { resolve = r; }) });
  void pending.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
  resolve(models); const result = await pending;
  assert.equal(result.ready, true); assert.deepEqual(result.models, [{ specialist: "script", model: "test/vision", source: "production" }]);
});
it("refuses an unavailable specialist without falling back to the valid production/default", async () => {
  const result = await preflightChapterReview(source, ["script"], { ...deps(), productionModel: "test/vision", override: () => "test/missing" });
  assert.equal(result.ready, false); assert.equal(result.models[0]?.model, "test/missing"); assert.match(result.models[0]!.reason!, /unavailable/);
});
it("checks picture capability and its consolidation role, and reports empty coverage", async () => {
  const empty = await preflightChapterReview(source, ["visual"], deps());
  assert.equal(empty.ready, true); assert.equal(empty.pictures, 0); assert.deepEqual(empty.models, []);
  const result = await preflightChapterReview({ ...source, images: [{ block: "one", file: "one.png", hash: "hash" }] }, ["visual"], deps());
  assert.equal(result.ready, false); assert.deepEqual(result.models.map(route => route.specialist), ["script", "visual"]);
  assert.match(result.models[1]!.reason!, /cannot read images/);
});
it("keeps unknown discovery and cloud-policy refusals explicit; narration needs no model", async () => {
  const broken = { ...deps(), models: async (): Promise<ModelInfo[]> => { throw new Error("private discovery detail"); } };
  assert.equal((await preflightChapterReview(source, ["narration"], broken)).ready, true);
  const failed = await preflightChapterReview(source, ["script"], broken);
  assert.match(failed.models[0]!.reason!, /could not be verified/); assert.doesNotMatch(failed.models[0]!.reason!, /private discovery/);
  const visual = await preflightChapterReview({ ...source, images: [{ block: "one", file: "one.png", hash: "hash" }] }, ["visual"],
    { ...deps(), override: () => "test/vision", cloudAllowed: async () => false });
  assert.equal(visual.ready, false); assert.match(visual.models[1]!.reason!, /Cloud image inspection/);
});
