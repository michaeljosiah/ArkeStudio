import assert from "node:assert/strict";
import { it } from "node:test";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "./helpers/stub-server-v2.js";
import { until } from "./wait.js";

it("records bounded, content-free MCP evidence per writing dispatch without replaying prompts", async () => {
  const stub = new StubOpenCodeV2(); await stub.start();
  const traces: Record<string, unknown>[] = [];
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD, onTrace: row => traces.push(row) });
  try {
    const { sessionId } = await adapter.createSession({ purpose: "world-chat", cwd: "C:/scratch/world-tools", agent: "world-builder" });
    const cases = [
      { response: { rows: [{ name: "arke-world", status: { status: "connected" } }] }, expected: "connected" },
      { response: { rows: [{ name: "arke-world", status: { status: "failed", error: "SECRET_LEASE_URL_PRIVATE_TEXT" } }] }, expected: "failed" },
      { response: { rows: [] }, expected: "missing" },
      { response: { rows: "SECRET_LEASE_URL_PRIVATE_TEXT", status: 500 }, expected: "unavailable" },
      { response: { rows: [{ name: "arke-world", status: { status: "connected" } }], directory: "C:/another/world" }, expected: "unavailable" },
      { response: { rows: "SECRET_LEASE_URL_PRIVATE_TEXT".repeat(5000) }, expected: "unavailable" },
      { response: { hold: true }, expected: "unavailable" },
    ];
    for (const [index, entry] of cases.entries()) {
      stub.mcpResponse = () => entry.response;
      await adapter.dispatchAsync({ sessionId, parts: [{ type: "text", text: "UNPUBLISHED_PROMPT" }] });
      await until(() => traces.filter(row => row.what === "world-tools.snapshot").length === index + 1, "bounded MCP snapshot", 10_000);
      const snapshot = traces.filter(row => row.what === "world-tools.snapshot").at(-1)!;
      assert.equal(snapshot.status, entry.expected); assert.equal(snapshot.dispatch, index + 1);
      assert.equal(stub.requests.filter(row => row.path.endsWith("/prompt")).length, index + 1, "diagnostics never repeat a paid prompt");
    }
    const checks = stub.requests.filter(row => row.path === "/api/mcp");
    assert.ok(checks.every(row => row.authorized && row.query["location[directory]"] === "C:/scratch/world-tools"));
    assert.ok(!JSON.stringify(traces).includes("SECRET_LEASE"));
    assert.ok(!JSON.stringify(traces).includes("UNPUBLISHED_PROMPT"));
    assert.equal(traces.filter(row => row.what === "dispatch.failed").length, 0);
  } finally { await adapter.dispose(); await stub.stop(); }
});

it("aborts diagnostics with the runtime and emits no late snapshot", async () => {
  const stub = new StubOpenCodeV2(); await stub.start(); stub.mcpResponse = () => ({ hold: true });
  const traces: Record<string, unknown>[] = [];
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD, onTrace: row => traces.push(row) });
  try {
    const { sessionId } = await adapter.createSession({ purpose: "world-chat", cwd: "C:/scratch/stopped", agent: "world-builder" });
    await adapter.dispatchAsync({ sessionId, parts: [{ type: "text", text: "Fixture" }] });
    await until(() => stub.requests.some(row => row.path === "/api/mcp"), "diagnostic request");
    await adapter.dispose();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(traces.some(row => row.what === "world-tools.snapshot"), false);
  } finally { await adapter.dispose(); await stub.stop(); }
});
