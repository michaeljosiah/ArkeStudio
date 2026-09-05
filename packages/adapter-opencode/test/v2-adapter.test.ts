import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@arke-studio/contracts";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { createNormalizeV2State, normalizeOpenCodeV2 } from "../src/v2/normalize.js";
import { buildSessionConfigV2 } from "../src/v2/config.js";
import { credentialEnvPatch } from "../src/config.js";
import { sameDirectory } from "../src/v2/http.js";
import { meetsV2Gate, discoverOpenCode2, discoverPreferredHarness } from "../src/discovery.js";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "./helpers/stub-server-v2.js";
import { until } from "./wait.js";

// 30s: the stub answers over loopback in-process, but a starved shard stalls the event loop
// for seconds at a time — the settle tier from the coordinator's supervisor.test.ts note.
const SETTLE_MS = 30_000;

/** Wait until `predicate` has seen enough events, or fail loudly with what arrived. */
async function collect(
  adapter: OpenCodeV2Adapter,
  isDone: (events: HarnessEvent[]) => boolean,
  // The deadline starts at call time, and several tests create the collect promise before
  // gating on 30s waits — a smaller default here would fire mid-gate and abort the stream
  // while those budgets were still legitimately running.
  timeoutMs = SETTLE_MS,
): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), timeoutMs);
  (deadline as { unref?: () => void }).unref?.();
  for await (const event of adapter.streamEvents(abort.signal)) {
    events.push(event);
    if (isDone(events)) break;
  }
  clearTimeout(deadline);
  if (!isDone(events)) {
    assert.fail(`timed out waiting for events; saw: ${events.map((e) => e.type).join(", ") || "(none)"}`);
  }
  return events;
}

/**
 * Wait until the pump's connect-time resync has run (its permission GET is the last leg).
 * The stub pre-populates REST state before streaming frames, so on a slow runner the resync
 * can legitimately recover a scripted turn via REST before the SSE frames are read — correct
 * adapter behavior, but a test scripting "deltas then completion" must start after it.
 */
async function untilResynced(stub: StubOpenCodeV2, mark: number): Promise<void> {
  await until(
    () => stub.requests.slice(mark).some((r) => r.method === "GET" && r.path.endsWith("/permission")),
    "the connect-time resync to finish (its permission GET is the last leg)",
    SETTLE_MS,
  );
}

describe("v2 normalisation (issue 327 §6)", () => {
  it("accumulates text deltas into full-text message.delta events", () => {
    const state = createNormalizeV2State();
    normalizeOpenCodeV2(
      { type: "session.text.delta", data: { sessionID: "s1", assistantMessageID: "m1", delta: "The " } },
      state,
    );
    const outcome = normalizeOpenCodeV2(
      { type: "session.text.delta", data: { sessionID: "s1", assistantMessageID: "m1", delta: "draft." } },
      state,
    );
    assert.equal(outcome.kind, "events");
    const event = outcome.kind === "events" ? outcome.events[0]! : null;
    assert.equal(event?.type, "message.delta");
    assert.equal(event?.type === "message.delta" && event.text, "The draft.");
  });

  it("turns execution.succeeded into the shared fetch path, not a text-less completion", () => {
    const state = createNormalizeV2State();
    const outcome = normalizeOpenCodeV2({ type: "session.execution.succeeded", data: { sessionID: "s1" } }, state);
    assert.deepEqual(outcome, { kind: "turn-succeeded", sessionId: "s1" });
  });

  it("keeps the structured error type in front, even with an empty message", () => {
    const state = createNormalizeV2State();
    const outcome = normalizeOpenCodeV2(
      { type: "session.execution.failed", data: { sessionID: "s1", error: { type: "provider.auth", message: "" } } },
      state,
    );
    assert.equal(outcome.kind, "events");
    const event = outcome.kind === "events" ? outcome.events[0]! : null;
    assert.equal(event?.type, "session.error");
    assert.equal(event?.type === "session.error" && event.message, "provider.auth");
  });

  it("maps interruption reasons onto session.ended", () => {
    const state = createNormalizeV2State();
    const outcome = normalizeOpenCodeV2(
      { type: "session.execution.interrupted", data: { sessionID: "s1", reason: "superseded" } },
      state,
    );
    assert.equal(outcome.kind, "events");
    const event = outcome.kind === "events" ? outcome.events[0]! : null;
    assert.equal(event?.type, "session.ended");
    assert.equal(event?.type === "session.ended" && event.detail, "superseded");
  });

  it("maps permission.asked with plural resources onto permission.requested", () => {
    const state = createNormalizeV2State();
    const outcome = normalizeOpenCodeV2(
      {
        type: "permission.asked",
        data: { id: "per_1", sessionID: "s1", action: "shell", resources: ["echo hi"], save: ["echo *"] },
      },
      state,
    );
    assert.equal(outcome.kind, "events");
    const event = outcome.kind === "events" ? outcome.events[0]! : null;
    assert.equal(event?.type, "permission.requested");
    assert.equal(event?.type === "permission.requested" && event.actionClass, "shell");
    assert.equal(event?.type === "permission.requested" && event.detail, "echo hi");
  });

  it("SETS usage totals rather than adding them — v2 states running totals", () => {
    const state = createNormalizeV2State();
    normalizeOpenCodeV2(
      { type: "session.usage.updated", data: { sessionID: "s1", tokens: { input: 500, output: 20, reasoning: 100 } } },
      state,
    );
    normalizeOpenCodeV2(
      { type: "session.usage.updated", data: { sessionID: "s1", tokens: { input: 700, output: 40, reasoning: 100 } } },
      state,
    );
    assert.equal(state.tokensBySession.get("s1"), 840, "the second total replaces the first");
  });

  it("names a held tool call from its input.started frame", () => {
    const state = createNormalizeV2State();
    normalizeOpenCodeV2(
      { type: "session.tool.input.started", data: { sessionID: "s1", id: "call_1", name: "shell" } },
      state,
    );
    const outcome = normalizeOpenCodeV2(
      { type: "session.tool.called", data: { sessionID: "s1", id: "call_1", input: { command: "echo hi" }, executed: false } },
      state,
    );
    assert.equal(outcome.kind, "events");
    const event = outcome.kind === "events" ? outcome.events[0]! : null;
    assert.equal(event?.type === "tool.activity" && event.tool, "shell");
  });

  it("ignores registration noise but dead-letters the genuinely unknown (R-14)", () => {
    const state = createNormalizeV2State();
    // A location load emits ~100 of these (measured); they must not churn the dead letters.
    assert.equal(normalizeOpenCodeV2({ type: "plugin.added", data: {} }, state).kind, "ignore");
    assert.equal(normalizeOpenCodeV2({ type: "session.renamed", data: {} }, state).kind, "ignore");
    assert.equal(normalizeOpenCodeV2({ type: "quantum.flux", data: {} }, state).kind, "dead-letter");
    assert.equal(normalizeOpenCodeV2("not an object", state).kind, "dead-letter");
  });
});

describe("v2 adapter against the scripted server (issue 327 §11)", () => {
  const stub = new StubOpenCodeV2();
  before(async () => stub.start());
  after(async () => stub.stop());

  function makeAdapter(password: string = STUB_V2_PASSWORD): OpenCodeV2Adapter {
    return new OpenCodeV2Adapter({
      baseUrl: () => stub.baseUrl(),
      password: () => password,
      warmupMs: 3_000,
    });
  }

  it("is unauthorized without the password — the auth path is exercised, not assumed", async () => {
    const adapter = makeAdapter("wrong-password");
    try {
      await adapter.init();
      assert.equal(adapter.readiness().ready, false);
      assert.match(adapter.readiness().reason ?? "", /401/);
    } finally {
      await adapter.dispose();
    }
  });

  it("tolerates the server-global warm-up instead of declaring a healthy server broken", async () => {
    const cold = new StubOpenCodeV2();
    cold.coldHealthMs = 700;
    await cold.start();
    const adapter = new OpenCodeV2Adapter({
      baseUrl: () => cold.baseUrl(),
      password: () => STUB_V2_PASSWORD,
      warmupMs: 5_000,
    });
    try {
      await adapter.init();
      assert.equal(adapter.readiness().ready, true);
      assert.equal(adapter.serverVersion, "0.0.0-next-17444");
    } finally {
      await adapter.dispose();
      await cold.stop();
    }
  });

  it("creates the session in its location and pins the agent as session state", async () => {
    const adapter = makeAdapter();
    try {
      await adapter.init();
      const ref = await adapter.createSession({ purpose: "authoring", cwd: "C:\\worlds\\proposal-1", agent: "scene-writer" });
      assert.ok(ref.sessionId.startsWith("ses_stub_"));
      const create = stub.lastRequest(/^\/api\/session$/);
      assert.deepEqual(create?.body, { location: { directory: "C:/worlds/proposal-1" } });
      const pin = stub.lastRequest(/\/agent$/);
      assert.deepEqual(pin?.body, { agent: "scene-writer" });
      assert.equal(pin?.authorized, true);
    } finally {
      await adapter.dispose();
    }
  });

  it("detects a session created in the wrong location — the silent failure mode", async () => {
    const adapter = makeAdapter();
    try {
      await adapter.init();
      stub.echoLocation = "C:/somewhere/else";
      await assert.rejects(
        adapter.createSession({ purpose: "authoring", cwd: "C:\\worlds\\proposal-2", agent: "scene-writer" }),
        /wrong location/,
      );
    } finally {
      stub.echoLocation = null;
      await adapter.dispose();
    }
  });

  it("generates fresh msg_ wire ids per prompt — ids are durable and globally unique", async () => {
    const adapter = makeAdapter();
    try {
      await adapter.init();
      const ref = await adapter.createSession({ purpose: "authoring", agent: "scene-writer" });
      const isPrompt = (r: { path: string }) => r.path.endsWith("/prompt");
      const seen = stub.requests.filter(isPrompt).length;
      await adapter.dispatchAsync({ sessionId: ref.sessionId, parts: [{ type: "text", text: "one" }] });
      await adapter.dispatchAsync({ sessionId: ref.sessionId, parts: [{ type: "text", text: "two" }] });
      await until(() => stub.requests.filter(isPrompt).length >= seen + 2, "both scripted prompts to reach the stub", SETTLE_MS);
      const prompts = stub.requests.filter(isPrompt).slice(-2);
      const ids = prompts.map((p) => (p.body as { id?: string }).id);
      assert.ok(ids.every((id) => id?.startsWith("msg_arke_")), `wire ids in the msg_ namespace: ${ids.join(", ")}`);
      assert.notEqual(ids[0], ids[1], "wire ids never repeat — a reuse answers 409");
    } finally {
      await adapter.dispose();
    }
  });

  it("completes a turn by fetching the final message — the event carries no text", async () => {
    const adapter = makeAdapter();
    try {
      await adapter.init();
      const ref = await adapter.createSession({ purpose: "authoring", agent: "scene-writer" });
      const mark = stub.requests.length;
      const eventsPromise = collect(
        adapter,
        (events) => events.some((e) => e.type === "message.completed"),
      );
      await until(() => stub.streamCount > 0, "the stub to open an event stream", SETTLE_MS);
      await untilResynced(stub, mark);
      stub.emitTurn(ref.sessionId, "It printed arke-spike.");
      const events = await eventsPromise;
      const completed = events.find((e) => e.type === "message.completed");
      assert.equal(completed?.type === "message.completed" && completed.text, "It printed arke-spike.");
      const deltas = events.filter((e) => e.type === "message.delta");
      assert.ok(deltas.length >= 1, "deltas stream before the completion");
      // A repeated success signal for the same turn reports nothing new (dedup by message id).
      const late: HarnessEvent[] = [];
      const lateAbort = new AbortController();
      const drain = (async () => {
        for await (const event of adapter.streamEvents(lateAbort.signal)) late.push(event);
      })();
      stub.emit({ id: "evt_again", type: "session.execution.succeeded", data: { sessionID: ref.sessionId } });
      await new Promise((r) => setTimeout(r, 250));
      lateAbort.abort();
      await drain;
      assert.equal(
        late.filter((e) => e.type === "message.completed").length,
        0,
        "the already-reported turn does not complete twice",
      );
    } finally {
      await adapter.dispose();
    }
  });

  it("carries the held-call permission round trip, session-scoped reply included", async () => {
    const adapter = makeAdapter();
    try {
      await adapter.init();
      const ref = await adapter.createSession({ purpose: "authoring", agent: "scene-writer" });
      const mark = stub.requests.length;
      const eventsPromise = collect(
        adapter,
        (events) => events.some((e) => e.type === "permission.requested"),
      );
      await until(() => stub.streamCount > 0, "the stub to open an event stream", SETTLE_MS);
      await untilResynced(stub, mark);
      stub.emitHeldToolCall(ref.sessionId, "per_stub_1", "echo arke-spike");
      const events = await eventsPromise;
      const ask = events.find((e) => e.type === "permission.requested");
      assert.equal(ask?.type === "permission.requested" && ask.actionClass, "shell");
      assert.equal(ask?.type === "permission.requested" && ask.detail, "echo arke-spike");
      const tool = events.find((e) => e.type === "tool.activity");
      assert.equal(tool?.type === "tool.activity" && tool.tool, "shell");

      const ack = await adapter.respondToPermission({ permissionId: "per_stub_1", decision: "once" });
      assert.equal(ack.status, "confirmed", "confirmation comes from the replied event, not HTTP status");
      const reply = stub.lastRequest(/\/permission\/per_stub_1\/reply$/);
      assert.deepEqual(reply?.body, { reply: "once" });
      assert.match(reply?.path ?? "", new RegExp(`^/api/session/${ref.sessionId}/`), "the reply is session-scoped");
    } finally {
      await adapter.dispose();
    }
  });

  it("assesses permission asks against the session's captured v2 confinement", async () => {
    const adapter = makeAdapter();
    try {
      await adapter.init();
      const readOnlyCwd = "C:\\worlds\\world-chat";
      adapter.prepareSession({ preparationId: "prep_read", researchWeb: true });
      const readOnly = await adapter.createSession({
        purpose: "world-chat",
        cwd: readOnlyCwd,
        agent: "world-builder",
        preparationId: "prep_read",
      });
      const assess = (actionClass: string) =>
        adapter.assessPermission({
          sessionId: readOnly.sessionId,
          permissionId: `per_${actionClass}`,
          actionClass,
        }).status;
      assert.equal(assess("websearch"), "allowed");
      assert.equal(assess("edit"), "denied");
      assert.equal(assess("shell"), "denied");
      assert.equal(assess("external_directory"), "denied");
      assert.equal(assess("future-tool"), "ask");

      const authorCwd = "C:\\worlds\\authoring";
      adapter.prepareSession({ preparationId: "prep_author", researchWeb: false });
      const author = await adapter.createSession({
        purpose: "authoring",
        cwd: authorCwd,
        agent: "scene-writer",
        preparationId: "prep_author",
      });
      assert.equal(
        adapter.assessPermission({ sessionId: author.sessionId, permissionId: "per_web", actionClass: "websearch" })
          .status,
        "denied",
      );
      assert.equal(
        adapter.assessPermission({ sessionId: author.sessionId, permissionId: "per_edit", actionClass: "edit" }).status,
        "allowed",
      );
      assert.equal(
        adapter.assessPermission({ sessionId: author.sessionId, permissionId: "per_future", actionClass: "future-tool" })
          .status,
        "ask",
      );
    } finally {
      await adapter.dispose();
    }
  });

  it("keeps concurrent v2 preparations distinct even when they share a cwd", async () => {
    const adapter = makeAdapter();
    try {
      await adapter.init();
      const cwd = "C:\\worlds\\shared";
      adapter.prepareSession({ preparationId: "prep_web", researchWeb: true });
      adapter.prepareSession({ preparationId: "prep_offline", researchWeb: false });

      const web = await adapter.createSession({
        purpose: "authoring",
        cwd,
        agent: "sheet-editor",
        preparationId: "prep_web",
      });
      const offline = await adapter.createSession({
        purpose: "authoring",
        cwd,
        agent: "sheet-editor",
        preparationId: "prep_offline",
      });
      assert.equal(
        adapter.assessPermission({ sessionId: web.sessionId, permissionId: "per_web_on", actionClass: "webfetch" })
          .status,
        "allowed",
      );
      assert.equal(
        adapter.assessPermission({ sessionId: offline.sessionId, permissionId: "per_web_off", actionClass: "webfetch" })
          .status,
        "denied",
      );
    } finally {
      await adapter.dispose();
    }
  });

  it("falls back to accumulated deltas when the completion fetch fails — a blip must not hang the turn", async () => {
    const adapter = makeAdapter();
    try {
      await adapter.init();
      const ref = await adapter.createSession({ purpose: "authoring", agent: "scene-writer" });
      const mark = stub.requests.length;
      const eventsPromise = collect(adapter, (events) => events.some((e) => e.type === "message.completed"));
      await until(() => stub.streamCount > 0, "the stub to open an event stream", SETTLE_MS);
      await untilResynced(stub, mark);
      stub.failNextMessageFetch = true;
      stub.emitTurn(ref.sessionId, "Salvaged from the stream.");
      const events = await eventsPromise;
      const completed = events.find((e) => e.type === "message.completed");
      assert.equal(
        completed?.type === "message.completed" && completed.text,
        "Salvaged from the stream.",
        "the deltas the stream already delivered are the fallback payload",
      );
    } finally {
      stub.failNextMessageFetch = false;
      await adapter.dispose();
    }
  });

  it("recovers a pending ask on connect — the global listing is not trusted", async () => {
    const adapter = makeAdapter();
    try {
      await adapter.init();
      const ref = await adapter.createSession({ purpose: "authoring", agent: "scene-writer" });
      // The ask predates the stream: only the session-scoped resync can find it.
      stub.pendingPermissions.set(ref.sessionId, [
        { id: "per_stub_resync", action: "shell", resources: ["echo lost"] },
      ]);
      const events = await collect(adapter, (all) => all.some((e) => e.type === "permission.requested"));
      const ask = events.find((e) => e.type === "permission.requested");
      assert.equal(ask?.type === "permission.requested" && ask.permissionId, "per_stub_resync");
    } finally {
      stub.pendingPermissions.clear();
      await adapter.dispose();
    }
  });

  it("lists models, marks the default, and learns its window for the budget", async () => {
    const adapter = makeAdapter();
    try {
      await adapter.init();
      stub.models = [
        { id: "gpt-5.4-mini", providerID: "openai", name: "GPT-5.4 mini", limit: { context: 400_000, input: 272_000 } },
        { id: "old-model", providerID: "openai", limit: { context: 8_000 } },
      ];
      stub.defaultModel = { id: "gpt-5.4-mini", providerID: "openai" };
      const models = await adapter.listModels();
      assert.equal(models.length, 2);
      const def = models.find((m) => m.isDefault);
      assert.equal(def?.id, "gpt-5.4-mini");
      assert.equal(adapter.knownInputTokenLimit(), 272_000, "input beats context when the provider states both");
    } finally {
      await adapter.dispose();
    }
  });
});

describe("v2 session config (issue 327 §7)", () => {
  it("gives a dispatch model precedence over an agent default", () => {
    const config = buildSessionConfigV2({
      model: "openai/gpt-5.2",
      agents: { "world-builder": { model: "ollama/gemma4" } },
    });
    const agents = config["agents"] as Record<string, { model?: string }>;
    assert.equal(agents["world-builder"]!.model, "openai/gpt-5.2");
  });

  it("orders the confinement block deny-first, managed re-allows after", () => {
    const config = buildSessionConfigV2({ defaultAgent: "scene-writer" });
    const agents = config["agents"] as Record<string, { permissions: Array<{ action: string; resource: string; effect: string }> }>;
    const someAgent = Object.values(agents)[0]!;
    const external = someAgent.permissions.filter((r) => r.action === "external_directory");
    assert.ok(external.length >= 2, "the confinement block exists");
    assert.deepEqual(external[0], { action: "external_directory", resource: "*", effect: "deny" });
    assert.ok(
      external.slice(1).every((r) => r.effect === "allow"),
      "managed-directory re-allows come AFTER the blanket deny — last match wins",
    );
    const externalDeny = someAgent.permissions.findIndex((r) => r.action === "external_directory" && r.effect === "deny");
    const shellDeny = someAgent.permissions.findIndex((r) => r.action === "shell");
    const readAllow = someAgent.permissions.findIndex((r) => r.action === "read");
    assert.ok(readAllow < shellDeny, "broad allows precede the denies");
    assert.ok(shellDeny < externalDeny, "the confinement block closes the array — order is the policy");
  });

  it("keeps codemode off for arke-world so tool naming and permissions hold", () => {
    const config = buildSessionConfigV2({ worldQueryUrl: "http://127.0.0.1:7777/mcp" });
    const mcp = config["mcp"] as { servers: Record<string, { type: string; url: string; codemode: boolean }> };
    assert.deepEqual(mcp.servers["arke-world"], {
      type: "remote",
      url: "http://127.0.0.1:7777/mcp",
      codemode: false,
    });
  });

  it("patches credentials with deletion markers — absence must be expressible", () => {
    assert.deepEqual(credentialEnvPatch({ anthropic: "sk-a", openai: "sk-o" }), {
      ANTHROPIC_API_KEY: "sk-a",
      OPENAI_API_KEY: "sk-o",
    });
    // Every managed variable is named even when its key is gone: an omission preserves a
    // revoked key through the next spawn; an explicit undefined deletes it.
    assert.deepEqual(credentialEnvPatch({ anthropic: "sk-a" }), {
      ANTHROPIC_API_KEY: "sk-a",
      OPENAI_API_KEY: undefined,
    });
    assert.deepEqual(credentialEnvPatch({}), {
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    });
  });

  it("speaks the v2 grammar: agents plural, system not prompt, default_agent set", () => {
    const config = buildSessionConfigV2({ defaultAgent: "scene-writer" });
    assert.equal(config["default_agent"], "scene-writer");
    assert.equal(config["agent"], undefined, "the v1 singular key never appears");
    const agents = config["agents"] as Record<string, Record<string, unknown>>;
    for (const definition of Object.values(agents)) {
      assert.equal(typeof definition["system"], "string");
      assert.equal(definition["prompt"], undefined);
      assert.equal(definition["tools"], undefined, "denials are permission rules in v2, not a tools map");
    }
  });
});

describe("v2 discovery and the build gate (issue 327 §3)", () => {
  it("gates on the prerelease build number, and lets stable 2.x through", () => {
    assert.equal(meetsV2Gate("0.0.0-next-17444"), true);
    assert.equal(meetsV2Gate("0.0.0-next-17443"), false);
    assert.equal(meetsV2Gate("2.0.0"), true);
    // A 2.x prerelease restarts the build counter; the major check must win over the
    // channel branch or a current binary reads as older than the beta pin.
    assert.equal(meetsV2Gate("2.0.0-next-3"), true);
    assert.equal(meetsV2Gate("1.18.10"), false);
    assert.equal(meetsV2Gate(null), false);
  });

  it("reads the build number across the renamed channels, off one counter", () => {
    // Upstream moved the prerelease channel from `next-` to `beta-` after the pin was measured
    // (2026-08-26: dist-tags beta=0.0.0-beta-18314, latest=0.0.0-beta-17823, dev=0.0.0-dev-18326,
    // all `bin: opencode2`). The counter continues, so a rename must not read as "too old" —
    // that rejected every currently installed v2 as absent.
    assert.equal(meetsV2Gate("0.0.0-beta-18314"), true);
    assert.equal(meetsV2Gate("0.0.0-beta-17823"), true);
    assert.equal(meetsV2Gate("0.0.0-dev-18326"), true);
    // The floor still applies within a renamed channel.
    assert.equal(meetsV2Gate("0.0.0-beta-17443"), false);
    // Channels that number differently are not trusted against the floor: this one is a
    // date, and a wildcarded channel match would clear any build number ever pinned.
    assert.equal(meetsV2Gate("0.0.0-tui-v2-202606261840"), false);
    // A compound channel that merely CONTAINS a trusted name is still untrusted — an
    // unanchored match would read "beta-202606261840" out of it and clear the floor on a date.
    assert.equal(meetsV2Gate("0.0.0-tui-beta-202606261840"), false);
    // The counter belongs to the 0.0.0 series. A prerelease of another line numbers by its own
    // rules, so its suffix is not a build this floor can compare against.
    assert.equal(meetsV2Gate("1.18.0-beta-202606261840"), false);
    assert.equal(meetsV2Gate("0.1.0-dev-20000"), false);
  });

  it("prefers v2, falls back to v1, and honours the Settings escape hatch", async () => {
    const machine = (present: Record<string, string>) => async (command: string, args: string[]) => {
      if (command === "where" || command === "which") {
        const target = args[0]!;
        return present[target] !== undefined
          ? { status: 0, stdout: `C:\\bin\\${target}.exe\n` }
          : { status: 1, stdout: "" };
      }
      const name = command.replace(/^C:\\bin\\/, "").replace(/\.exe$/, "");
      return present[name] !== undefined ? { status: 0, stdout: present[name]! } : { status: 1, stdout: "" };
    };

    const both = { opencode: "opencode v1.18.18", opencode2: "opencode2 v0.0.0-next-17444" };
    const preferred = await discoverPreferredHarness({ v1: { runCommand: machine(both) }, v2: { runCommand: machine(both) } });
    assert.equal(preferred?.generation, "v2");

    const v1Only = { opencode: "opencode v1.18.18" };
    const fallback = await discoverPreferredHarness({ v1: { runCommand: machine(v1Only) }, v2: { runCommand: machine(v1Only) } });
    assert.equal(fallback?.generation, "v1");

    const escape = await discoverPreferredHarness({
      preferV1: true,
      v1: { runCommand: machine(both) },
      v2: { runCommand: machine(both) },
    });
    assert.equal(escape?.generation, "v1");

    const gated = { opencode2: "opencode2 v0.0.0-next-9000" };
    const tooOld = await discoverPreferredHarness({ v1: { runCommand: machine(gated) }, v2: { runCommand: machine(gated) } });
    assert.equal(tooOld, null, "a binary older than the pin is treated as absent");
  });

  it("lets a stale configured path fall through to a current binary on PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arke-oc2-disc-"));
    const configured = join(dir, "opencode2-old.exe");
    writeFileSync(configured, "stub");
    try {
      const run = async (command: string, args: string[]) => {
        if (command === "where" || command === "which") {
          return args[0] === "opencode2"
            ? { status: 0, stdout: "C:\\bin\\opencode2.exe\n" }
            : { status: 1, stdout: "" };
        }
        if (command === configured) return { status: 0, stdout: "opencode2 v0.0.0-next-9000" };
        return { status: 0, stdout: "opencode2 v0.0.0-next-17444" };
      };
      const found = await discoverOpenCode2({ configuredPath: configured, runCommand: run });
      assert.equal(found?.source, "path", "the stale configured entry does not hide the current install");
      assert.equal(found?.version, "0.0.0-next-17444");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries the too-old v2 as the honest reason when discovery falls back to v1", async () => {
    const run = async (command: string, args: string[]) => {
      if (command === "where" || command === "which") {
        return { status: 0, stdout: `C:\\bin\\${args[0]}.exe\n` };
      }
      return command.includes("opencode2")
        ? { status: 0, stdout: "opencode2 v0.0.0-next-9000" }
        : { status: 0, stdout: "opencode v1.18.18" };
    };
    const result = await discoverPreferredHarness({ v1: { runCommand: run }, v2: { runCommand: run } });
    assert.equal(result?.generation, "v1");
    assert.equal(
      result?.rejectedV2?.version,
      "0.0.0-next-9000",
      "Settings can say 'found but too old' instead of 'not installed' (SPEC-005 R-1)",
    );
  });
});

describe("v2 http location discipline (issue 327 §5)", () => {
  it("compares directories separator-insensitively, folding case only where the filesystem does", () => {
    assert.equal(sameDirectory("C:\\worlds\\p1", "C:/worlds/p1", "win32"), true);
    assert.equal(sameDirectory("C:/Worlds/P1/", "C:\\worlds\\p1", "win32"), true);
    assert.equal(sameDirectory("C:/elsewhere", "C:/worlds/p1", "win32"), false);
    assert.equal(sameDirectory(undefined, "C:/worlds/p1", "win32"), false);
    // On Linux those are two different directories, and folding them equal would pass the
    // wrong-location guard on exactly the misdirection it exists to catch.
    assert.equal(sameDirectory("/home/u/Worlds/Alpha", "/home/u/worlds/alpha", "linux"), false);
    assert.equal(sameDirectory("/home/u/worlds/alpha/", "/home/u/worlds/alpha", "linux"), true);
  });
});
