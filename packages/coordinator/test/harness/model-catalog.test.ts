import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ManifestModelSchema, type HarnessAdapter, type HarnessModelStatus, type ModelInfo } from "@arke-studio/contracts";
import { HarnessModelCatalog, selectHarnessModel } from "../../src/harness/model-catalog.js";
import { ReadModel } from "../../src/read-model.js";

const model: ModelInfo = { provider: "anthropic", id: "claude-example", aliases: ["sonnet"], inputTokenLimit: 128_000 };
const adapterWith = (listModels: () => Promise<ModelInfo[]>, ready = true) => ({
  id: "test", init: async () => {}, readiness: () => ({ ready, reason: "harness offline" }),
  capabilities: () => new Set(["events", "models"] as const), listModels,
  createSession: async () => ({ sessionId: "unused" }), sendMessage: async () => ({ sessionId: "unused", correlationId: "unused" }),
  dispatchAsync: async () => ({ sessionId: "unused", correlationId: "unused" }),
  streamEvents: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true as const }) }) }),
}) satisfies HarnessAdapter;

describe("the running harness model catalog", () => {
  it("shares in-flight discovery, caches valid empty catalogs, and refreshes on request", async () => {
    let calls = 0;
    let resolve!: (models: ModelInfo[]) => void;
    const states: HarnessModelStatus[] = [];
    const catalog = new HarnessModelCatalog(adapterWith(() => { calls++; return new Promise(r => { resolve = r; }); }), (_, status) => states.push(status));
    const a = catalog.get(); const b = catalog.get();
    assert.equal(calls, 1);
    resolve([]);
    assert.deepEqual(await a, []); assert.deepEqual(await b, []);
    assert.deepEqual(await catalog.get(), []); assert.equal(calls, 1);
    const refreshed = catalog.get(true); assert.equal(calls, 2); resolve([model]);
    assert.deepEqual(await refreshed, [model]);
    assert.deepEqual(states.map(state => state.status), ["loading", "ready", "loading", "ready"]);
  });

  it("expires cached data and does not call a retained catalog fresh after a failed refresh", async () => {
    let now = 100;
    let fail = false;
    const states: HarnessModelStatus[] = [];
    const catalog = new HarnessModelCatalog(adapterWith(async () => { if (fail) throw new Error("credentials expired"); return [model]; }), (_, status) => states.push(status), { ttlMs: 10, now: () => now });
    await catalog.get(); fail = true; now = 111;
    await assert.rejects(catalog.get(), /Model discovery failed/);
    assert.equal(states.at(-1)?.status, "error");
    fail = false;
    assert.deepEqual(await catalog.get(), [model]);
  });

  it("bounds a hanging discovery and permits retry", async () => {
    let hanging = true;
    const catalog = new HarnessModelCatalog(adapterWith(() => hanging ? new Promise(() => {}) : Promise.resolve([model])), () => {}, { timeoutMs: 10 });
    await assert.rejects(catalog.get(), /timed out/);
    hanging = false;
    assert.deepEqual(await catalog.get(), [model]);
  });

  it("refuses duplicate canonical identities in either order and keeps only the last verified catalog", async () => {
    let rows = [model];
    const published: Array<{ rows: ModelInfo[]; status: HarnessModelStatus }> = [];
    const catalog = new HarnessModelCatalog(adapterWith(async () => rows), (rows, status) => published.push({ rows, status }));
    await catalog.get();
    const text: ModelInfo = { ...model, inputModalities: ["text"] };
    const multimodal: ModelInfo = { ...model, inputModalities: ["text", "image"] };
    for (const ambiguous of [[text, multimodal], [multimodal, text], [model, { ...model }]]) {
      rows = ambiguous;
      await assert.rejects(catalog.get(true), /duplicate model identities/);
      assert.deepEqual(published.at(-1)?.rows, [model], "a failed refresh retains display names without admitting ambiguous metadata");
      assert.equal(published.at(-1)?.status.status, "error");
      await assert.rejects(catalog.get(), /duplicate model identities/, "the old catalog is not treated as verified after a failure");
    }
    assert.equal(published.filter(({ status }) => status.status === "ready").length, 1);
    rows = [model, { ...model, provider: "openai" }];
    assert.deepEqual(await catalog.get(), rows, "the same bare id from another provider is a distinct canonical model");
    assert.equal(published.at(-1)?.status.status, "ready");
  });

  it("refuses a cached choice when its process has died and keeps raw errors out of state", async () => {
    let ready = true;
    const states: HarnessModelStatus[] = [];
    const adapter = { ...adapterWith(async () => [model]), readiness: () => ({ ready }) };
    const catalog = new HarnessModelCatalog(adapter, (_, status) => states.push(status));
    await catalog.get(); ready = false;
    await assert.rejects(catalog.get(), /not running/);
    const failed = new HarnessModelCatalog(adapterWith(async () => { throw new Error("raw token secret-value"); }), (_, status) => states.push(status));
    await assert.rejects(failed.get(), /Model discovery failed/);
    assert.doesNotMatch(JSON.stringify(states), /secret-value/);
  });

  it("refreshes a cached catalog when the process revision changes without an observed readiness change", async () => {
    let revision = 1;
    let calls = 0;
    let rows = [model];
    const adapter = { ...adapterWith(async () => { calls++; return rows; }), lifecycleRevision: () => revision };
    const catalog = new HarnessModelCatalog(adapter, () => {});
    assert.deepEqual(await catalog.get(), [model]);
    rows = [{ ...model, id: "new-process-model" }];
    revision++;
    assert.deepEqual(await catalog.get(), rows);
    assert.equal(calls, 2, "a still-healthy replacement process cannot borrow the old process's catalog");
    assert.deepEqual(await catalog.get(), rows);
    assert.equal(calls, 2, "the replacement catalog is cached within its own lifecycle");
  });

  it("refuses discovery that completes after its process revision changed", async () => {
    let revision = 1;
    let resolve!: (rows: ModelInfo[]) => void;
    const adapter = { ...adapterWith(() => new Promise<ModelInfo[]>(done => { resolve = done; })), lifecycleRevision: () => revision };
    const states: HarnessModelStatus[] = [];
    const catalog = new HarnessModelCatalog(adapter, (_, status) => states.push(status));
    const stale = catalog.get();
    const rejected = assert.rejects(stale, /harness changed/);
    revision++;
    resolve([model]);
    await rejected;
    assert.equal(states.some(status => status.status === "ready"), false);
    const fresh = catalog.get();
    resolve([{ ...model, id: "new-process-model" }]);
    assert.equal((await fresh)[0]?.id, "new-process-model");
    assert.equal(states.at(-1)?.status, "ready");
  });

  it("refuses stale completion after invalidation without overwriting the new catalog", async () => {
    const resolvers: Array<(models: ModelInfo[]) => void> = [];
    const published: ModelInfo[][] = [];
    const catalog = new HarnessModelCatalog(adapterWith(() => new Promise(resolve => resolvers.push(resolve))), (rows, status) => { if (status.status === "ready") published.push(rows); });
    const stale = catalog.get();
    const rejected = assert.rejects(stale, /harness changed/);
    catalog.invalidate(); const current = catalog.get();
    resolvers[1]!([model]); await current;
    resolvers[0]!([]); await rejected;
    assert.deepEqual(published, [[model]]);
    assert.deepEqual(await catalog.get(), [model]);
  });

  it("publishes honest absent/offline and malformed-catalog failures", async () => {
    for (const adapter of [null, adapterWith(async () => [], false), adapterWith(async () => [{ id: "bad" } as ModelInfo])]) {
      const states: HarnessModelStatus[] = [];
      const catalog = new HarnessModelCatalog(adapter, (_, status) => states.push(status));
      await assert.rejects(catalog.get());
      assert.equal(states.at(-1)?.status, "error");
    }
  });
});

describe("model selection at dispatch", () => {
  it("accepts new providers and known cloud harness models without media API-key state", () => {
    const app = new ReadModel("test").getState().app;
    const cloud = ManifestModelSchema.parse({ id: "old-sonnet", providerModelId: "sonnet", provider: "anthropic", capability: "llm", displayName: "Old name", accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "unmetered" } });
    app.manifest = { manifestVersion: 1, generated: "2026-09-13", models: [cloud] };
    assert.deepEqual(selectHarnessModel("old-sonnet", [model], app), { modelId: "anthropic/claude-example", sessionModel: "anthropic/claude-example", inputTokenLimit: 128_000 });
    const unknown: ModelInfo = { provider: "private-provider", id: "team/model:tag" };
    assert.equal(selectHarnessModel("private-provider/team/model:tag", [unknown], app).sessionModel, "private-provider/team/model:tag");
    app.models.disabled = ["old-sonnet"];
    assert.match(selectHarnessModel("anthropic/claude-example", [model], app).reason!, /unavailable/);
  });

  it("allows text-only chat, refuses text-only Stage and preserves unknown image capability", () => {
    const app = new ReadModel("test").getState().app;
    const textOnly: ModelInfo = { ...model, inputModalities: ["text"] };
    assert.equal(selectHarnessModel("anthropic/sonnet", [textOnly], app).reason, undefined);
    assert.match(selectHarnessModel("anthropic/sonnet", [textOnly], app, true).reason!, /cannot read images/);
    assert.equal(selectHarnessModel("anthropic/sonnet", [model], app, true).reason, undefined);
    assert.equal(selectHarnessModel("anthropic/sonnet", [{ ...model, inputModalities: ["text", "image"] }], app, true).reason, undefined);
    assert.match(selectHarnessModel("anthropic/missing", [model], app).reason!, /unavailable through the running harness/);
  });

  it("refuses reported empty or image-only input capabilities for chat and Stage", () => {
    const app = new ReadModel("test").getState().app;
    for (const inputModalities of [[], ["image"]] satisfies ModelInfo["inputModalities"][]) {
      const unsupported = { ...model, inputModalities };
      for (const needsImages of [false, true]) {
        const selection = selectHarnessModel("anthropic/sonnet", [unsupported], app, needsImages);
        assert.match(selection.reason!, /cannot read text/);
        assert.equal(selection.sessionModel, undefined);
      }
    }
  });

  it("retains the measured local-runtime refusal while allowing a healthy local model", () => {
    const app = new ReadModel("test").getState().app;
    const entry = ManifestModelSchema.parse({ id: "local-model", provider: "ollama", capability: "llm", displayName: "Local", accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "unmetered" } });
    app.manifest = { manifestVersion: 1, generated: "2026-09-13", models: [entry] };
    app.providers = [{ id: "ollama", configured: true, validation: "invalid", probes: [], fault: null }];
    const local: ModelInfo = { id: "local-model", provider: "ollama" };
    assert.match(selectHarnessModel("ollama/local-model", [local], app).reason!, /unavailable/);
    app.providers[0]!.validation = "valid";
    assert.equal(selectHarnessModel("ollama/local-model", [local], app).sessionModel, "ollama/local-model");
  });
});
