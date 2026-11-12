import assert from "node:assert/strict";
import { it } from "node:test";
import type { PrivateSessionWriter } from "@arke-studio/contracts";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "./helpers/stub-server-v2.js";

it("captures one host writer for private creation/retirement and never uses it for ordinary sessions", async () => {
  const stub = new StubOpenCodeV2(); await stub.start();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD });
  const observed: string[] = [], bound: string[] = []; let current = true;
  const writer: PrivateSessionWriter = { identity: "a".repeat(64), current: () => current, busy: () => false, seal() {}, close: async () => true,
    bindDirectory(directory, agent) { assert.equal(this, writer); assert.equal(directory, "/private/writer"); assert.equal(agent, "studio-assistant"); bound.push(directory); return true; },
    bindSession(sessionId) { assert.equal(this, writer); bound.push(sessionId); return true; },
    async fetch(input, init) { assert.equal(this, writer); observed.push(new URL(String(input)).pathname); return fetch(input, init); } };
  try {
    await adapter.init(); const preparationId = "writer-preparation";
    adapter.prepareSession({ preparationId, agent: "studio-assistant", model: "ollama/test" });
    const ref = await adapter.createSession({ purpose: "ask", agent: "studio-assistant", cwd: "/private/writer", preparationId, visibility: "private",
      privateRequest: { model: "ollama/test", system: "private fixture system", prompt: "private fixture prompt", outputTokenLimit: 4096 }, privateWriter: writer });
    assert.deepEqual(bound, ["/private/writer", ref.sessionId]); assert(observed.includes("/api/session"));
    const before = observed.length; current = false; assert.equal(await ref.privateRetire!(new AbortController().signal), false); assert.equal(observed.length, before);
    current = true; writer.fetch = async () => { throw Error("MUTATED_WRITER_MUST_NOT_REPLACE_ORIGINAL"); };
    assert.equal(await ref.privateRetire!(new AbortController().signal), true);
    assert(observed.includes(`/api/session/${ref.sessionId}`)); assert(!stub.sessionStates.has(ref.sessionId));
    const retired = observed.length;
    const ordinary = await adapter.createSession({ purpose: "authoring", agent: "world-builder" }); assert(stub.sessionStates.has(ordinary.sessionId)); assert.equal(observed.length, retired);
  } finally { await adapter.dispose(); await stub.stop(); }
});

it("refuses a writer capability on an ordinary or unsealed session before making a request", async () => {
  const stub = new StubOpenCodeV2(); await stub.start();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD }); let binds = 0;
  const writer: PrivateSessionWriter = { identity: "a".repeat(64), current: () => true, busy: () => false, seal() {}, close: async () => true,
    bindDirectory: () => { binds++; return true; }, bindSession: () => true, fetch: async () => { throw Error("MUST_NOT_FETCH"); } };
  try {
    const before = stub.requests.length;
    await assert.rejects(adapter.createSession({ purpose: "authoring", agent: "world-builder", privateWriter: writer }), /could not be bound/);
    await assert.rejects(adapter.createSession({ purpose: "ask", agent: "studio-assistant", visibility: "private", privateWriter: writer }), /could not be bound/);
    assert.equal(binds, 0); assert.equal(stub.requests.length, before);
  } finally { await adapter.dispose(); await stub.stop(); }
});
