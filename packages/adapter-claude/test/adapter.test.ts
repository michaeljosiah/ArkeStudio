import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { confinementFor, type HarnessEvent } from "@arke-studio/contracts";
import {
  ClaudeAdapter,
  createNormalizeState,
  decideTool,
  intentOf,
  normalizeClaude,
  toolSummary,
  type RunQuery,
} from "../src/index.js";

/** Scripted SDK messages, plus a hook onto the options the adapter actually passed. */
function fakeQuery(script: unknown[]): { run: RunQuery; options: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const run: RunQuery = ({ prompt, options }) => {
    captured = options;
    return (async function* () {
      const iterator = prompt[Symbol.asyncIterator]();
      await iterator.next(); // wait for the turn's user message
      for (const message of script) yield message;
    })();
  };
  return { run, options: () => captured };
}

const assistant = (blocks: unknown[]) => ({ type: "assistant", message: { content: blocks } });
const result = (over: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", is_error: false, result: "done", ...over });

async function collect(adapter: ClaudeAdapter, run: () => Promise<unknown>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  const stream = adapter.streamEvents();
  const pump = (async () => {
    for await (const event of stream) events.push(event);
  })();
  await run();
  await adapter.dispose();
  await pump;
  return events;
}

describe("the confinement, enforced per tool call", () => {
  const authoring = confinementFor({ readOnly: false });
  const readOnly = confinementFor({ readOnly: true });

  it("knows Claude's names for the intents it permits", () => {
    assert.equal(intentOf("Read"), "read");
    assert.equal(intentOf("Write"), "edit");
    assert.equal(intentOf("Grep"), "search");
    assert.equal(intentOf("mcp__arke-world__search_canon"), "world-query");
  });

  it("allows an authoring agent to edit, and refuses the same tool to one that answers", () => {
    assert.deepEqual(decideTool(authoring, "Edit"), { allow: true });
    assert.deepEqual(decideTool(readOnly, "Edit"), { allow: false, reason: "refused", intent: "edit" });
  });

  it("refuses a tool it has never heard of, rather than assuming it is harmless", () => {
    // Measured: a real installation advertises thirty-odd tools, and gained five between two runs
    // of the same spike. Anything not in the table is refused by construction.
    for (const unknown of ["Monitor", "Workflow", "CronCreate", "SomeToolShippedNextTuesday"]) {
      assert.deepEqual(decideTool(authoring, unknown), { allow: false, reason: "unknown" });
    }
  });

  it("refuses the shell under every spelling, because denying one was measured to be routed around", () => {
    for (const shell of ["Bash", "PowerShell"]) {
      assert.equal(decideTool(authoring, shell).allow, false, `${shell} is not an intent this agent has`);
    }
  });

  it("is the gate the adapter actually installs, not a table it keeps beside one", async () => {
    const fake = fakeQuery([result()]);
    const adapter = new ClaudeAdapter({ command: "claude", runQuery: fake.run });
    const { sessionId } = await adapter.createSession({ purpose: "authoring", agent: "sheet-editor" });
    await adapter.sendMessage({ sessionId, parts: [{ type: "text", text: "go" }] });
    const gate = fake.options()["canUseTool"] as (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }>;
    assert.equal((await gate("Edit", {})).behavior, "allow");
    assert.equal((await gate("Bash", {})).behavior, "deny");
    assert.equal((await gate("Monitor", {})).behavior, "deny");
    await adapter.dispose();
  });
});

describe("the options a session is opened with", () => {
  it("isolates the session from the user's own configuration", async () => {
    const fake = fakeQuery([result()]);
    const adapter = new ClaudeAdapter({ command: "C:/claude.exe", runQuery: fake.run });
    const { sessionId } = await adapter.createSession({ purpose: "authoring", agent: "sheet-editor", cwd: "/proposals/p1" });
    await adapter.sendMessage({ sessionId, parts: [{ type: "text", text: "go" }] });
    const options = fake.options();
    assert.deepEqual(options["settingSources"], [], "omitting this loads their settings AND connects their MCP servers");
    assert.equal(options["pathToClaudeCodeExecutable"], "C:/claude.exe", "unpinned runs the SDK's own bundled copy");
    assert.equal(options["cwd"], "/proposals/p1");
    assert.equal("allowedTools" in options, false, "a bare entry there would auto-approve before the gate is consulted");
    await adapter.dispose();
  });

  it("carries the confinement preamble into the system prompt, under a rewritten brief", async () => {
    const fake = fakeQuery([result()]);
    const adapter = new ClaudeAdapter({
      command: "claude",
      runQuery: fake.run,
      agents: { "sheet-editor": { brief: "Do whatever you like." } },
    });
    const { sessionId } = await adapter.createSession({ purpose: "authoring", agent: "sheet-editor" });
    await adapter.sendMessage({ sessionId, parts: [{ type: "text", text: "go" }] });
    const prompt = String(fake.options()["systemPrompt"]);
    assert.ok(prompt.includes("Do whatever you like."), "the brief is honoured");
    assert.ok(prompt.startsWith("You are working inside an Arke Studio proposal directory"));
    assert.ok(prompt.includes("Do not touch the version or updated fields"));
    await adapter.dispose();
  });

  it("registers the world tool only when a world is open", async () => {
    const withWorld = fakeQuery([result()]);
    const a = new ClaudeAdapter({ command: "claude", runQuery: withWorld.run, worldQueryUrl: "http://127.0.0.1:9/mcp" });
    const s1 = await a.createSession({ purpose: "authoring", agent: "sheet-editor" });
    await a.sendMessage({ sessionId: s1.sessionId, parts: [{ type: "text", text: "go" }] });
    // The shape is measured, not guessed: against the real WorldQueryServer, `http` connects and
    // exposes the tools as mcp__arke-world__*, `sse` reports failed, and a bare url is not
    // listed at all. Changing this silently loses the only way the world is legible.
    assert.deepEqual(withWorld.options()["mcpServers"], {
      "arke-world": { type: "http", url: "http://127.0.0.1:9/mcp" },
    });
    await a.dispose();

    const without = fakeQuery([result()]);
    const b = new ClaudeAdapter({ command: "claude", runQuery: without.run });
    const s2 = await b.createSession({ purpose: "authoring", agent: "sheet-editor" });
    await b.sendMessage({ sessionId: s2.sessionId, parts: [{ type: "text", text: "go" }] });
    assert.equal("mcpServers" in without.options(), false);
    await b.dispose();
  });

  it("refuses a session for an agent that is not on the roster", async () => {
    const adapter = new ClaudeAdapter({ command: "claude", runQuery: fakeQuery([]).run });
    await assert.rejects(() => adapter.createSession({ purpose: "authoring", agent: "not-an-agent" }), /no roster agent/);
    await adapter.dispose();
  });
});

describe("normalising the SDK's messages", () => {
  it("accumulates assistant text, because the contract's delta carries the whole answer", () => {
    const state = createNormalizeState();
    normalizeClaude(assistant([{ type: "text", text: "The " }]), "s1", state);
    const outcome = normalizeClaude(assistant([{ type: "text", text: "draft." }]), "s1", state);
    assert.equal(outcome.kind, "events");
    const event = outcome.kind === "events" ? outcome.events[0]! : null;
    assert.equal(event?.type === "message.delta" ? event.text : "", "The draft.");
  });

  it("renders tool use in the product's language, not the harness's (R-15)", () => {
    assert.equal(toolSummary("mcp__arke-world__search_canon", { query: "tide" }), 'checked canon — "tide"');
    assert.equal(toolSummary("Edit", { file_path: "C:/p/characters/maren.md" }), "edited maren.md");
    assert.equal(toolSummary("Grep", { pattern: "tide" }), "searched for tide");
  });

  it("surfaces each tool once, however often the block repeats", () => {
    const state = createNormalizeState();
    const block = [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.md" } }];
    assert.equal(normalizeClaude(assistant(block), "s1", state).kind, "events");
    assert.equal(normalizeClaude(assistant(block), "s1", state).kind, "ignore");
  });

  it("completes the turn on a result, and ends the session with a reason", () => {
    const state = createNormalizeState();
    const outcome = normalizeClaude(result({ result: "final draft" }), "s1", state);
    assert.equal(outcome.kind, "events");
    const events = outcome.kind === "events" ? outcome.events : [];
    assert.equal(events[0]?.type, "message.completed");
    assert.equal(events[1]?.type === "session.ended" ? events[1].reason : null, "completed");
  });

  it("reads is_error rather than subtype — a failed turn still arrives as success", () => {
    // Measured: an auth failure returned subtype "success" with is_error true and the reason
    // only in the text. Trusting subtype would have reported a completed turn carrying an error.
    const outcome = normalizeClaude(
      result({ is_error: true, result: "Failed to authenticate" }),
      "s1",
      createNormalizeState(),
    );
    const events = outcome.kind === "events" ? outcome.events : [];
    assert.equal(events[0]?.type, "session.error");
    assert.equal(events[1]?.type === "session.ended" ? events[1].reason : null, "error");
  });

  it("dead-letters an unrecognised shape rather than propagating a partial (R-14)", () => {
    const state = createNormalizeState();
    assert.equal(normalizeClaude({ type: "quantum.flux" }, "s1", state).kind, "dead-letter");
    assert.equal(normalizeClaude("not an object", "s1", state).kind, "dead-letter");
    assert.equal(normalizeClaude({ type: "system", subtype: "init" }, "s1", state).kind, "ignore");
  });
});

describe("the session lifecycle", () => {
  it("announces a session, streams its answer, and ends it", async () => {
    const fake = fakeQuery([assistant([{ type: "text", text: "drafted" }]), result({ result: "drafted" })]);
    const adapter = new ClaudeAdapter({ command: "claude", runQuery: fake.run });
    const events = await collect(adapter, async () => {
      const { sessionId } = await adapter.createSession({ purpose: "authoring", agent: "sheet-editor" });
      await adapter.sendMessage({ sessionId, parts: [{ type: "text", text: "draft it" }] });
    });
    assert.deepEqual(
      events.map((e) => e.type),
      ["session.created", "message.delta", "message.completed", "session.ended"],
    );
  });

  it("resolves sendMessage only once the turn is over, unlike dispatchAsync", async () => {
    // Held open explicitly rather than raced against the scheduler: the point is that the turn
    // is still running, not that some observer has not been scheduled yet.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const run: RunQuery = ({ prompt }) =>
      (async function* () {
        const iterator = prompt[Symbol.asyncIterator]();
        await iterator.next();
        yield assistant([{ type: "text", text: "still drafting" }]);
        await held;
        yield result();
      })();

    const adapter = new ClaudeAdapter({ command: "claude", runQuery: run });
    const { sessionId } = await adapter.createSession({ purpose: "authoring", agent: "sheet-editor" });

    // dispatchAsync must not block while the turn runs.
    const dispatched = await adapter.dispatchAsync({ sessionId, parts: [{ type: "text", text: "go" }] });
    assert.ok(dispatched.correlationId, "fire-and-watch returned while the turn was still open");

    let settled = false;
    const pending = adapter.sendMessage({ sessionId, parts: [{ type: "text", text: "and again" }] }).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the turn has not ended, so the synchronous send has not either");

    release();
    await pending;
    assert.equal(settled, true);
    await adapter.dispose();
  });

  it("returns the caller's correlation id, and invents one when there is none", async () => {
    const adapter = new ClaudeAdapter({ command: "claude", runQuery: fakeQuery([result()]).run });
    const { sessionId } = await adapter.createSession({ purpose: "authoring", agent: "sheet-editor" });
    const mine = await adapter.dispatchAsync({ sessionId, parts: [{ type: "text", text: "a" }], correlationId: "c-1" });
    assert.equal(mine.correlationId, "c-1");
    const theirs = await adapter.dispatchAsync({ sessionId, parts: [{ type: "text", text: "b" }] });
    assert.ok(theirs.correlationId.length > 0);
    await adapter.dispose();
  });

  it("declares only what it can do — no permissions to relay, no model catalogue", () => {
    const adapter = new ClaudeAdapter({ command: "claude" });
    assert.deepEqual([...adapter.capabilities()], ["events"]);
    assert.equal(adapter.knownInputTokenLimit(), null, "the model is the user's, and unknown until a turn reports it");
  });

  it("wants nothing on disk, and says so by offering nothing", () => {
    // The reason `sessionFiles` exists at all. OpenCode reads its confinement from a config file
    // beside the work; this takes the same confinement as query options, so a proposal directory
    // it ran in is indistinguishable from one it never touched.
    const adapter = new ClaudeAdapter({ command: "claude" });
    assert.equal(adapter.sessionFiles, undefined);
  });

  it("reports a turn that threw as an ended session rather than hanging the caller", async () => {
    // An iterator that rejects rather than a generator that throws — the same failure, and
    // closer to what a vanished binary actually does to the stream.
    const run: RunQuery = () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("binary vanished")) }),
    });
    const adapter = new ClaudeAdapter({ command: "claude", runQuery: run });
    const events = await collect(adapter, async () => {
      const { sessionId } = await adapter.createSession({ purpose: "authoring", agent: "sheet-editor" });
      await adapter.sendMessage({ sessionId, parts: [{ type: "text", text: "go" }] }).catch(() => {});
    });
    assert.ok(events.some((e) => e.type === "session.error"));
    assert.ok(events.some((e) => e.type === "session.ended" && e.reason === "error"));
  });

  it("stops what it started when disposed", async () => {
    const fake = fakeQuery([result()]);
    const adapter = new ClaudeAdapter({ command: "claude", runQuery: fake.run });
    const { sessionId } = await adapter.createSession({ purpose: "authoring", agent: "sheet-editor" });
    await adapter.sendMessage({ sessionId, parts: [{ type: "text", text: "go" }] });
    await adapter.dispose();
    await assert.rejects(
      () => adapter.dispatchAsync({ sessionId, parts: [{ type: "text", text: "again" }] }),
      /unknown session/,
    );
  });
});
