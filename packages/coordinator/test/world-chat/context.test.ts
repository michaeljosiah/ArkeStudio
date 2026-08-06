import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  newId,
  type CandidateTombstone,
  type CandidateId,
  type ConversationId,
  type MessageId,
  type RunId,
  type TurnId,
  type WorldChatMessage,
} from "@arke-studio/contracts";
import { assembleContext, BOUNDS, shouldSummarise } from "../../src/world-chat/context.js";
import {
  createRunScratch,
  removeRunScratch,
  runScratchDir,
  sweepRunScratch,
} from "../../src/world-chat/run-scratch.js";

/**
 * Bounded context and the per-run scratch (#70 §8.2, §8.5).
 *
 * The bound that matters most is the one that is not applied: a user's own message is never cut.
 */

const AT = "2026-08-06T10:00:00Z";

function message(role: "user" | "studio", text: string): WorldChatMessage {
  return {
    id: newId("msg") as MessageId,
    turnId: newId("turn") as TurnId,
    role,
    text,
    attachmentIds: [],
    createdAt: AT,
  };
}

function baseInput() {
  return {
    candidates: [],
    messages: [] as WorldChatMessage[],
    tombstones: [] as CandidateTombstone[],
    currentUserMessage: "and the bells?",
  };
}

describe("context assembly", () => {
  it("never truncates what the user just typed", () => {
    const long = "salt ".repeat(20_000);
    const context = assembleContext({ ...baseInput(), currentUserMessage: long });
    assert.equal(context.currentUserMessage, long, "cutting somebody's sentence to fit a budget is not an option");
    assert.equal(context.currentUserMessage.length, long.length);
  });

  it("holds every other section to its stated bound", () => {
    const context = assembleContext({
      ...baseInput(),
      summary: "s".repeat(BOUNDS.summary * 2),
      worldContext: "w".repeat(BOUNDS.worldContext * 2),
      messages: Array.from({ length: 40 }, (_, i) => message("user", `${i} `.repeat(2_000))),
    });

    assert.ok(context.summary.length <= BOUNDS.summary);
    assert.ok(context.worldContext.length <= BOUNDS.worldContext);
    assert.ok(context.recentTurns.length <= BOUNDS.recentTurns);
  });

  it("says which sections it had to trim, rather than trimming quietly", () => {
    const context = assembleContext({ ...baseInput(), summary: "s".repeat(BOUNDS.summary + 1) });
    assert.deepEqual(context.trimmed, ["summary"]);
  });

  it("keeps the most recent history when it has to choose", () => {
    const context = assembleContext({
      ...baseInput(),
      messages: [message("user", "the oldest thing said"), message("user", "the newest thing said")],
    });
    assert.match(context.recentTurns, /the newest thing said/);
  });

  it("carries retractions as keys, not as the text that was retracted", () => {
    const tombstone: CandidateTombstone = {
      candidateId: newId("cand") as CandidateId,
      revision: 1,
      structuralKey: "canon.create|new:the whale bone idea",
      payloadDigest: `sha256:${"a".repeat(64)}`,
      retractedByMessageId: newId("msg") as MessageId,
      at: AT,
    };
    const context = assembleContext({ ...baseInput(), tombstones: [tombstone] });

    assert.match(context.tombstones, /canon\.create/);
    assert.match(context.tombstones, /sha256:/);
    assert.ok(
      !context.tombstones.includes("statement"),
      "putting the withdrawn text back in front of the model every turn is the opposite of forgetting it",
    );
  });

  it("gives the same context the same digest, and a changed one a different digest", () => {
    const a = assembleContext(baseInput());
    const b = assembleContext(baseInput());
    const c = assembleContext({ ...baseInput(), currentUserMessage: "something else" });
    assert.equal(a.digest, b.digest);
    assert.notEqual(a.digest, c.digest);
  });

  it("summarises on turn count or on length, whichever comes first", () => {
    assert.equal(shouldSummarise({ turnCount: 8, recentTurnsLength: 10 }), true);
    assert.equal(shouldSummarise({ turnCount: 2, recentTurnsLength: BOUNDS.recentTurns }), true);
    assert.equal(shouldSummarise({ turnCount: 2, recentTurnsLength: 10 }), false);
  });
});

describe("the per-run scratch directory", () => {
  async function appRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "arke-scratch-"));
  }

  it("writes session configuration outside the world", async () => {
    const root = await appRoot();
    const conversationId = newId("cv") as ConversationId;
    const runId = newId("run") as RunId;

    const dir = await createRunScratch({
      appRoot: root,
      conversationId,
      runId,
      config: { mcp: { arke: { url: "http://127.0.0.1:1/mcp/abc" } } },
    });

    assert.equal(dir, runScratchDir(root, conversationId, runId));
    const config = JSON.parse(await readFile(join(dir, "opencode.json"), "utf8"));
    assert.equal(config.mcp.arke.url, "http://127.0.0.1:1/mcp/abc");
    assert.deepEqual(await readdir(dir), ["opencode.json"], "and nothing else is in there");
  });

  it("removes one run without disturbing another", async () => {
    const root = await appRoot();
    const conversationId = newId("cv") as ConversationId;
    const keep = newId("run") as RunId;
    const drop = newId("run") as RunId;
    await createRunScratch({ appRoot: root, conversationId, runId: keep, config: {} });
    await createRunScratch({ appRoot: root, conversationId, runId: drop, config: {} });

    await removeRunScratch(root, conversationId, drop);

    const remaining = await readdir(join(root, "run", "world-chat", conversationId));
    assert.deepEqual(remaining, [keep]);
  });

  it("does not fail when the scratch is already gone", async () => {
    const root = await appRoot();
    const conversationId = newId("cv") as ConversationId;
    const runId = newId("run") as RunId;
    await removeRunScratch(root, conversationId, runId);
    await removeRunScratch(root, conversationId, runId);
  });

  it("sweeps what a crashed process left, and says what it swept", async () => {
    const root = await appRoot();
    const conversationId = newId("cv") as ConversationId;
    const runId = newId("run") as RunId;
    await createRunScratch({ appRoot: root, conversationId, runId, config: {} });

    const swept = await sweepRunScratch(root);
    assert.deepEqual(swept, [`${conversationId}/${runId}`]);
    assert.deepEqual(await readdir(join(root, "run", "world-chat")), []);
  });

  it("sweeps an app that has never run a conversation", async () => {
    assert.deepEqual(await sweepRunScratch(await appRoot()), []);
  });
});
