import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CreateSessionInput, HarnessAdapter, SessionConfigInput } from "@arke-studio/contracts";
import { withModelValidation } from "../../src/harness/model-validation.js";

function captureAdapter() {
  const preparations = new Map<string, SessionConfigInput>();
  const created: Array<{ input: CreateSessionInput; config: SessionConfigInput | undefined }> = [];
  const adapter: HarnessAdapter = {
    id: "test", init: async () => {}, readiness: () => ({ ready: true }), capabilities: () => new Set(["events"]),
    prepareSession: input => { if (input.preparationId) preparations.set(input.preparationId, structuredClone(input)); },
    abandonSessionPreparation: id => { preparations.delete(id); },
    createSession: async input => {
      const config = input.preparationId ? preparations.get(input.preparationId) : undefined;
      if (input.preparationId && !config) throw new Error("adapter preparation missing");
      if (input.preparationId) preparations.delete(input.preparationId);
      created.push({ input, config }); return { sessionId: `session-${created.length}` };
    },
    sendMessage: async input => ({ sessionId: input.sessionId, correlationId: "test" }),
    dispatchAsync: async input => ({ sessionId: input.sessionId, correlationId: "test" }),
    streamEvents: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) }),
  };
  return { adapter, preparations, created };
}

describe("model validation for every roster session", () => {
  it("validates the captured explicit model before the agent override and flags Stage image requirements", async () => {
    const capture = captureAdapter(); const validated: Array<[string, boolean]> = [];
    const adapter = withModelValidation(capture.adapter, async (reference, images) => { validated.push([reference, images]); return {}; });
    const agents = { "stage-designer": { model: "anthropic/agent", brief: "Captured brief." } };
    adapter.prepareSession!({ preparationId: "first", model: "anthropic/turn", agents });
    agents["stage-designer"].model = "anthropic/changed";
    await adapter.createSession({ purpose: "authoring", agent: "stage-designer", preparationId: "first" });
    assert.deepEqual(validated, [["anthropic/turn", true]]);
    assert.equal(capture.created[0]?.config?.agents?.["stage-designer"]?.model, "anthropic/agent");
    adapter.prepareSession!({ preparationId: "helper", agents: { "sheet-editor": { model: "anthropic/helper" } } });
    await adapter.createSession({ purpose: "authoring", preparationId: "helper" });
    assert.deepEqual(validated.at(-1), ["anthropic/helper", false]);
  });

  it("keeps default sessions usable when there is no override to discover", async () => {
    const capture = captureAdapter();
    const adapter = withModelValidation(capture.adapter, async () => { throw new Error("must not discover"); });
    adapter.prepareSession!({ preparationId: "default", agents: {} });
    await adapter.createSession({ purpose: "authoring", agent: "canon-qa", preparationId: "default" });
    await adapter.createSession({ purpose: "authoring" });
    assert.equal(capture.created.length, 2);
  });

  it("retires rejected underlying preparations and refuses a second create instead of bypassing admission", async () => {
    const capture = captureAdapter();
    const adapter = withModelValidation(capture.adapter, async () => ({ reason: "Chosen model unavailable." }));
    adapter.prepareSession!({ preparationId: "rejected", model: "missing/model" });
    const input: CreateSessionInput = { purpose: "authoring", preparationId: "rejected" };
    await assert.rejects(adapter.createSession(input), /Chosen model unavailable/);
    assert.equal(capture.preparations.size, 0);
    await assert.rejects(adapter.createSession(input), /already consumed/);
    assert.equal(capture.created.length, 0);
  });

  it("claims tokens before awaiting discovery and rejects duplicate preparation", async () => {
    const capture = captureAdapter();
    let ready!: (value: { reason?: string }) => void;
    const adapter = withModelValidation(capture.adapter, () => new Promise(resolve => { ready = resolve; }));
    adapter.prepareSession!({ preparationId: "single", model: "anthropic/first" });
    assert.throws(() => adapter.prepareSession!({ preparationId: "single", model: "anthropic/second" }), /already in use/);
    const input: CreateSessionInput = { purpose: "authoring", preparationId: "single" };
    const first = adapter.createSession(input);
    await assert.rejects(adapter.createSession(input), /already consumed/);
    assert.equal(capture.preparations.has("single"), true, "a rejected duplicate cannot abandon the first caller's preparation");
    ready({}); await first;
    assert.equal(capture.created[0]?.config?.model, "anthropic/first");
  });

  it("honors cancellation after catalog resolution and cleans up the captured settings", async () => {
    const capture = captureAdapter(); const abort = new AbortController();
    const adapter = withModelValidation(capture.adapter, async () => { abort.abort(); return {}; });
    adapter.prepareSession!({ preparationId: "cancel", model: "anthropic/first" });
    await assert.rejects(adapter.createSession({ purpose: "authoring", preparationId: "cancel", signal: abort.signal }), /abort/i);
    assert.equal(capture.preparations.size, 0);
    assert.equal(capture.created.length, 0);
  });
});
