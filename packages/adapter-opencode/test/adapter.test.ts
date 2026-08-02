import assert from "node:assert/strict";
import { after, before, describe, it, type TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { HarnessEvent } from "@arke-studio/contracts";
import { OpenCodeAdapter } from "../src/opencode-adapter.js";
import { probeCapabilities } from "../src/capabilities.js";
import { createNormalizeState, normalizeOpenCode, toolSummary } from "../src/normalize.js";
import { buildSessionConfig } from "../src/config.js";
import { discoverOpenCode } from "../src/discovery.js";
import { StubOpenCode } from "./helpers/stub-server.js";

describe("normalisation (R-14, R-15)", () => {
  it("unwraps the ≥1.17 payload envelope and maps text parts to deltas", () => {
    const state = createNormalizeState();
    normalizeOpenCode(
      { payload: { type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant" } } } },
      state,
    );
    const outcome = normalizeOpenCode(
      {
        payload: {
          type: "message.part.updated",
          properties: { part: { sessionID: "s1", messageID: "m1", type: "text", text: "drafting…" } },
        },
      },
      state,
    );
    assert.equal(outcome.kind, "events");
    assert.equal(outcome.kind === "events" && outcome.events[0]!.type, "message.delta");
  });

  it("renders tool calls as product-language progress (R-15)", () => {
    assert.equal(toolSummary("arke-world_search_canon", { query: "tide" }, undefined), 'checked canon — "tide"');
    assert.equal(toolSummary("arke-world_get_entry", { id: "CANON-002" }, undefined), "read canon entry CANON-002");
    assert.equal(toolSummary("edit", { filePath: "C:/x/characters/maren-kest.md" }, undefined), "edited maren-kest.md");
  });

  it("finalises the turn on session.idle with the last assistant text", () => {
    const state = createNormalizeState();
    normalizeOpenCode(
      { payload: { type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant" } } } },
      state,
    );
    normalizeOpenCode(
      {
        payload: {
          type: "message.part.updated",
          properties: { part: { sessionID: "s1", messageID: "m1", type: "text", text: "final draft" } },
        },
      },
      state,
    );
    const outcome = normalizeOpenCode({ payload: { type: "session.idle", properties: { sessionID: "s1" } } }, state);
    assert.equal(outcome.kind, "events");
    const event = outcome.kind === "events" ? outcome.events[0]! : null;
    assert.equal(event?.type, "message.completed");
    assert.equal(event?.type === "message.completed" && event.text, "final draft");
  });

  it("dead-letters unrecognised frames rather than propagating partials (R-14)", () => {
    const state = createNormalizeState();
    assert.equal(normalizeOpenCode({ payload: { type: "quantum.flux" } }, state).kind, "dead-letter");
    assert.equal(normalizeOpenCode("not an object", state).kind, "dead-letter");
    assert.equal(normalizeOpenCode({ payload: { type: "server.heartbeat" } }, state).kind, "ignore");
  });

  it("maps the session.next generation: deltas accumulate, tools surface, non-tool finish completes", () => {
    const state = createNormalizeState();
    const s = "ses_next";
    const frame = (type: string, data: Record<string, unknown>) => normalizeOpenCode({ type, data: { sessionID: s, assistantMessageID: "m9", ...data } }, state);

    assert.equal(frame("session.next.step.started", { agent: "sheet-editor" }).kind, "ignore");
    const tool = frame("session.next.tool.called", { callID: "c1", tool: "arke-world_search_canon", input: { query: "tide" } });
    assert.equal(tool.kind, "events");
    assert.equal(tool.kind === "events" && tool.events[0]!.type, "tool.activity");

    // A step that ended to run the tool is a continuation, not the turn's end.
    const midStep = frame("session.next.step.ended", { finish: "tool-calls", tokens: { input: 500, output: 20 } });
    assert.equal(midStep.kind, "ignore");
    assert.equal(state.tokensBySession.get(s), 520);

    const d1 = frame("session.next.text.delta", { delta: "The " });
    const d2 = frame("session.next.text.delta", { delta: "draft." });
    const delta = d2.kind === "events" ? d2.events[0]! : null;
    assert.equal(delta?.type === "message.delta" ? delta.text : "", "The draft.");
    void d1;

    const end = frame("session.next.step.ended", { finish: "stop", tokens: { input: 100, output: 30 } });
    assert.equal(end.kind, "events");
    const completed = end.kind === "events" ? end.events[0]! : null;
    assert.equal(completed?.type, "message.completed");
    assert.equal(completed?.type === "message.completed" && completed.text, "The draft.");
    assert.equal(state.tokensBySession.get(s), 650, "usage accumulates across steps");
  });

  it("tracks token usage for the budget check (R-13)", () => {
    const state = createNormalizeState();
    normalizeOpenCode(
      {
        payload: {
          type: "message.updated",
          properties: { info: { id: "m1", sessionID: "s1", role: "assistant", tokens: { input: 1000, output: 500 } } },
        },
      },
      state,
    );
    assert.equal(state.tokensBySession.get("s1"), 1500);
  });
});

describe("capability probe (R-2, D6)", () => {
  const clientFor = (paths: string[], healthy = true) => ({
    async req<T>(_m: string, path: string): Promise<T> {
      if (path === "/api/health" || path === "/global/health") {
        if (!healthy) throw new Error("refused");
        return {} as T;
      }
      if (path === "/doc") return { paths: Object.fromEntries(paths.map((p) => [p, {}])) } as T;
      throw new Error("404");
    },
  });

  it("advertises what the /doc surface supports", async () => {
    const result = await probeCapabilities(
      clientFor(["/api/event", "/api/session/{sessionID}/permission/{requestID}/reply", "/api/model"]),
    );
    assert.equal(result.readiness.ready, true);
    assert.deepEqual([...result.capabilities].sort(), ["events", "models", "permissions"]);
  });

  it("fails readiness with a stated reason when the event stream is missing (R-2)", async () => {
    const result = await probeCapabilities(clientFor(["/api/session", "/api/model"]));
    assert.equal(result.readiness.ready, false);
    assert.match(result.readiness.reason ?? "", /events/);
  });

  it("stays ready with an optional capability absent — the feature degrades, not the harness", async () => {
    const result = await probeCapabilities(clientFor(["/api/event"]));
    assert.equal(result.readiness.ready, true);
    assert.equal(result.capabilities.has("permissions"), false);
  });

  it("reports unreachable servers honestly", async () => {
    const result = await probeCapabilities(clientFor([], false));
    assert.equal(result.readiness.ready, false);
    assert.match(result.readiness.reason ?? "", /health/);
  });
});

describe("the live adapter over the stub server", () => {
  const stub = new StubOpenCode();
  let adapter: OpenCodeAdapter;

  before(async () => {
    await stub.start();
    adapter = new OpenCodeAdapter({ baseUrl: () => stub.baseUrl() });
    await adapter.init();
  });
  after(async () => {
    await adapter.dispose();
    await stub.stop();
  });

  it("probes ready with the stub's full surface", () => {
    assert.equal(adapter.readiness().ready, true);
    assert.equal(adapter.serverVersion, "9.9.9-stub");
  });

  it("creates a session whose directory goes on the wire in forward-slash form (R-9)", async () => {
    const session = await adapter.createSession({
      purpose: "authoring",
      cwd: "C:\\worlds\\the-undersong\\.proposals\\pr_x",
      agent: "sheet-editor",
    });
    assert.match(session.sessionId, /^ses_stub_/);
    const create = stub.lastRequest(/^\/api\/session$/);
    const body = create?.body as { agent?: string; location?: { directory?: string } };
    assert.equal(body.agent, "sheet-editor");
    assert.equal(body.location?.directory, "C:/worlds/the-undersong/.proposals/pr_x");
    assert.ok(!body.location?.directory?.includes("\\"), "no backslash reaches the wire");
  });

  it("streams a scripted turn: tool activity, delta, completion — and filters foreign sessions", async () => {
    const session = await adapter.createSession({ purpose: "authoring", agent: "sheet-editor" });
    const seen: HarnessEvent[] = [];
    const abort = new AbortController();
    const pump = (async () => {
      for await (const event of adapter.streamEvents(abort.signal)) {
        if ("sessionId" in event && event.sessionId === session.sessionId) seen.push(event);
        if (event.type === "message.completed") break;
      }
    })();

    await adapter.dispatchAsync({ sessionId: session.sessionId, parts: [{ type: "text", text: "draft it" }] });
    await new Promise((r) => setTimeout(r, 300));
    stub.emitTurn("ses_foreign_1", "not ours"); // a user's own unrelated activity — must not surface
    stub.emitTurn(session.sessionId, "the draft text");
    await pump;
    abort.abort();

    const types = seen.map((e) => e.type);
    assert.ok(types.includes("tool.activity"), `expected tool.activity in ${types.join(",")}`);
    assert.ok(types.includes("message.delta"));
    assert.ok(types.includes("message.completed"));
    const tool = seen.find((e) => e.type === "tool.activity");
    assert.equal(tool?.type === "tool.activity" && tool.summary, 'checked canon — "tide calling"');
    assert.equal(adapter.usageTokens(session.sessionId), 150, "usage tracked from message.updated");
    assert.ok(!seen.some((e) => "sessionId" in e && e.sessionId === "ses_foreign_1"));
  });

  it("interrupts a session on request (R-13)", async () => {
    const session = await adapter.createSession({ purpose: "authoring" });
    await adapter.interrupt(session.sessionId);
    assert.ok(stub.lastRequest(new RegExp(`/api/session/${session.sessionId}/interrupt$`)));
  });
});

describe("session configuration (R-5, R-6, R-10)", () => {
  it("writes the roster with shell and network tools denied, and never a credential", () => {
    const config = buildSessionConfig({ worldQueryUrl: "http://127.0.0.1:9999/mcp" });
    const agents = config["agent"] as Record<
      string,
      { tools: Record<string, boolean>; permission: Record<string, string> }
    >;
    for (const name of ["sheet-editor", "canon-author", "canon-qa", "scene-writer", "story-writer", "world-author"]) {
      assert.ok(agents[name], `roster includes ${name}`);
      assert.equal(agents[name]!.tools["bash"], false, `${name} denies bash (R-10)`);
      assert.equal(agents[name]!.tools["webfetch"], false, `${name} denies webfetch`);
      // Explicit allows, never a wildcard — a wildcard was observed to override the denies.
      assert.equal(agents[name]!.permission["bash"], "deny");
      assert.equal(agents[name]!.permission["webfetch"], "deny");
      assert.equal(agents[name]!.permission["edit"], "allow");
      assert.equal("*" in agents[name]!.permission, false);
    }
    const mcp = config["mcp"] as Record<string, { type: string; url: string }>;
    assert.equal(mcp["arke-world"]!.type, "remote");
    const raw = JSON.stringify(config).toLowerCase();
    for (const needle of ["api_key", "apikey", "secret", "token", "password"]) {
      assert.ok(!raw.includes(needle), `config carries no credential material (${needle})`);
    }
  });
});

/**
 * A stub OpenCode the test can actually run: a batch file on Windows, a shell script elsewhere.
 * Discovery spawns what it finds, so a stub that only runs on one platform tests only that one.
 */
function stubOpenCode(t: TestContext, name: string, version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "arke-oc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const windows = process.platform === "win32";
  const file = join(dir, windows ? `${name}.cmd` : name);
  writeFileSync(file, windows ? `@echo ${version}\r\n` : `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return file;
}

describe("discovery (R-1)", () => {
  it("prefers a configured path over PATH, and names the version", (t) => {
    const found = discoverOpenCode({ configuredPath: stubOpenCode(t, "fake-opencode", "7.7.7") });
    assert.equal(found?.source, "configured");
    assert.equal(found?.version, "7.7.7");
  });

  it("falls back to PATH when nothing is configured", (t) => {
    // Put our own opencode first on PATH rather than trusting the machine to have one — a test
    // that passes because the developer happens to have it installed proves nothing on CI.
    const onPath = stubOpenCode(t, "opencode", "6.6.6");
    const original = process.env["PATH"];
    process.env["PATH"] = `${join(onPath, "..")}${delimiter}${original ?? ""}`;
    try {
      const found = discoverOpenCode();
      assert.equal(found?.source, "path");
      assert.equal(found?.version, "6.6.6");
    } finally {
      process.env["PATH"] = original;
    }
  });
});

describe("the event stream survives a harness that goes quiet (R-2, R-14)", () => {
  it("hangs up on a silent stream, reconnects, and reports the turn it missed", async () => {
    // The failure this reproduces: a restarted harness leaves a half-open socket. It never
    // errors and never yields, so the reader waits forever on a connection that will never
    // speak again — and the app is deaf while the turn it is waiting for completes and passes.
    const stub = new StubOpenCode();
    await stub.start();
    const adapter = new OpenCodeAdapter({ baseUrl: () => stub.baseUrl(), streamSilenceMs: 150 });
    await adapter.init();
    const { sessionId } = await adapter.createSession({ purpose: "authoring" });

    const abort = new AbortController();
    const seen: string[] = [];
    const events = adapter.streamEvents(abort.signal);
    const pump = (async () => {
      for await (const e of events) {
        seen.push(e.type);
        if (e.type === "message.completed") break;
      }
    })();

    // Wait for the first connection, then go quiet without closing it.
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(stub.streamCount, 1, "connected once");
    stub.stallStreams();

    // The turn completes while nobody is listening — REST is the only record of it.
    stub.replayMessages = [
      {
        info: { id: "msg_missed", sessionID: sessionId, role: "assistant", time: { completed: Date.now() } },
        parts: [{ text: "the answer nobody heard" }],
      },
    ];

    await Promise.race([pump, new Promise((r) => setTimeout(r, 6000))]);
    abort.abort();
    await adapter.dispose();
    await stub.stop();

    assert.ok(seen.includes("message.completed"), `the missed turn is reported — saw ${seen.join(", ") || "nothing"}`);
  });
});
