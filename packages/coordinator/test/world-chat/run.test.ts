import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newId,
  type ConversationId,
  type HarnessAdapter,
  type RunId,
  type WorldBundle,
  type WorldChatMessage,
} from "@arke-studio/contracts";
import { WorldChatRunner } from "../../src/world-chat/run.js";
import { SceneEditRefused } from "../../src/productions/scene-edits.js";
import { describeEntryContext } from "../../src/world-chat/entry-context.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { scanWorld } from "../../src/world/scan.js";
import { FIXTURE_WORLD } from "../world/helpers.js";
import { tempDir } from "../tmp.js";

/**
 * The turn (#70 §8).
 *
 * The tests that carry weight are about ordering, not happy paths: the user's message survives a
 * turn that fails, and nothing the model produced survives a turn that fails. Those two together
 * are what make the transcript trustworthy — you can always see what you said, and you never see
 * a reply describing work that did not happen.
 */

const AT = "2026-08-06T10:00:00Z";
const NOW = () => AT;

/**
 * A harness that says whatever the test tells it to, one answer per turn.
 *
 * Answers may be functions so a test can compose one *after* the turn has started — evidence has
 * to quote the real message id, which does not exist until `send` has written it.
 */
function fakeAdapter(
  answers: Array<string | (() => string | Promise<string>)>,
  /** `refuses` names the tools the gate turned down before the answer arrived (issue 506). */
  options: { hang?: boolean; prompts?: string[]; refuses?: readonly string[] } = {},
): HarnessAdapter {
  let turn = 0;
  return {
    id: "fake",
    capabilities: () => new Set(["events"] as never),
    readiness: () => ({ ready: true }),
    createSession: async () => ({ sessionId: "s1" }) as never,
    sendMessage: async () => ({ ok: true }) as never,
    dispatchAsync: async (input: { parts: Array<{ text?: string }> }) => {
      options.prompts?.push(input.parts.map((p) => p.text ?? "").join(""));
      return { ok: true } as never;
    },
    streamEvents: (signal?: AbortSignal) =>
      (async function* () {
        if (options.hang) {
          await new Promise((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          });
          return;
        }
        for (const tool of options.refuses ?? []) {
          yield {
            type: "tool.refused",
            sessionId: "s1",
            tool,
            summary: `refused ${tool} — outside what this agent may do`,
          } as never;
        }
        const answer = answers[Math.min(turn++, answers.length - 1)]!;
        const text = typeof answer === "function" ? await answer() : answer;
        yield { type: "message.completed", sessionId: "s1", text } as never;
      })(),
  } as unknown as HarnessAdapter;
}

async function setup(adapter: HarnessAdapter, options: { timeoutMs?: number } = {}) {
  const worldPath = await tempDir("arke-run-");
  const conversationId = newId("cv") as ConversationId;
  const store = new WorldChatStore(conversationDir(worldPath, conversationId));
  await store.create(conversationId, AT);
  await store.append(
    { type: "conversation.created", title: "a talk", entryContext: { kind: "world" } },
    { at: AT },
  );
  const bundle: WorldBundle = (await scanWorld(FIXTURE_WORLD)).bundle;

  const released: RunId[] = [];
  const runner = new WorldChatRunner({
    adapter,
    prepare: async () => ({ cwd: worldPath, leaseToken: "t".repeat(64) }),
    release: async ({ runId }) => void released.push(runId),
    receiptsFor: () => [],
    runCheckPlan: async () => ({ receipts: [], canonRevision: bundle.meta.canonRevision }),
    evidenceSources: (messages: readonly WorldChatMessage[]) => ({
      messages,
      bundle,
      attachments: [],
      attachmentText: new Map(),
    }),
    now: NOW,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  const view = async () => {
    const meta = await store.readMeta();
    return foldConversation(meta!.id, meta!.createdAt, (await store.read()).events).view;
  };

  return { runner, store, conversationId, view, released };
}

/** A well-formed answer whose evidence quotes the message it was actually sent with. */
function goodAnswer(said: string, quote: string, messageId: string): string {
  const start = said.indexOf(quote);
  return JSON.stringify({
    reply: "Noted.",
    candidateOperations: [
      {
        op: "create",
        temporaryId: "t1",
        candidate: {
          classification: "canon.create",
          title: "A rule about the bells",
          rationale: "They said so.",
          settledness: "settled",
          checkReceiptIds: [],
          evidence: [
            { kind: "message", messageId, quote, start, end: start + quote.length, purpose: "intent" },
          ],
          draft: { type: "lore", title: "The bells", statement: "The bells pass sideways.", links: [] },
        },
      },
    ],
    groupOperations: [],
  });
}

describe("taking a turn", () => {
  it("keeps the user's message even when the turn fails", async () => {
    const { runner, store, conversationId, view } = await setup(fakeAdapter(["not json at all", "still not json"]));
    const outcome = await runner.send(store, conversationId, "Her aunt taught her the bells.");

    assert.equal(outcome.status, "failed");
    const folded = await view();
    assert.equal(folded.messages.length, 1, "what they typed is still there");
    assert.equal(folded.messages[0]!.text, "Her aunt taught her the bells.");
    assert.equal(folded.messages[0]!.role, "user");
  });

  it("writes nothing the model produced when the turn fails", async () => {
    const { runner, store, conversationId, view } = await setup(fakeAdapter(["garbage", "garbage"]));
    await runner.send(store, conversationId, "anything");

    const folded = await view();
    assert.deepEqual(folded.candidates, [], "no half-applied propositions");
    assert.ok(
      !folded.messages.some((m) => m.role === "studio"),
      "and no reply describing work that did not happen",
    );
  });

  it("takes exactly one corrective turn, not a loop", async () => {
    let asked = 0;
    const counting = fakeAdapter(["bad", "bad"]);
    const original = counting.dispatchAsync.bind(counting);
    counting.dispatchAsync = async (input) => {
      asked += 1;
      return original(input);
    };

    const { runner, store, conversationId } = await setup(counting);
    await runner.send(store, conversationId, "anything");
    assert.equal(asked, 2, "the first attempt and one correction — never a third");
  });

  it("records the failure on the run rather than losing it", async () => {
    const { runner, store, conversationId } = await setup(fakeAdapter(["bad", "bad"]));
    await runner.send(store, conversationId, "anything");

    const { events } = await store.read();
    const finished = events.find((e) => e.event.type === "run.finished");
    assert.ok(finished, "the run says how it ended");
    const run = (finished!.event as { run: { status: string; safeDetail?: string } }).run;
    assert.equal(run.status, "failed");
    assert.ok(run.safeDetail && run.safeDetail.length > 0);
  });

  it("says the studio is unavailable rather than starting a run that cannot happen", async () => {
    const down = { ...fakeAdapter([]), readiness: () => ({ ready: false, reason: "OpenCode is not running" }) };
    const { runner, store, conversationId, view } = await setup(down as HarnessAdapter);
    const outcome = await runner.send(store, conversationId, "hello");

    assert.equal(outcome.status, "unavailable");
    assert.deepEqual((await view()).messages, [], "and no turn was started at all");
  });

  it("releases the lease and scratch whatever the outcome", async () => {
    const { runner, store, conversationId, released } = await setup(fakeAdapter(["bad", "bad"]));
    await runner.send(store, conversationId, "anything");
    assert.equal(released.length, 1, "a failed turn still gives back its lease");
  });
});

describe("a turn that lands", () => {
  it("records the reply and the proposition it came with", async () => {
    const said = "Her aunt taught her the bells, not her mother.";
    const worldPath = await tempDir("arke-run-ok-");
    const conversationId = newId("cv") as ConversationId;
    const store = new WorldChatStore(conversationDir(worldPath, conversationId));
    await store.create(conversationId, AT);
    await store.append(
      { type: "conversation.created", title: "a talk", entryContext: { kind: "world" } },
      { at: AT },
    );
    const bundle: WorldBundle = (await scanWorld(FIXTURE_WORLD)).bundle;

    // Composed at dispatch time, once the user's message is in the log and has an id.
    const answer = async () => {
      const meta = await store.readMeta();
      const view = foldConversation(meta!.id, meta!.createdAt, (await store.read()).events).view;
      return goodAnswer(said, "Her aunt taught her the bells", view.messages[0]!.id);
    };

    const runner = new WorldChatRunner({
      adapter: fakeAdapter([answer]),
      prepare: async () => ({ cwd: worldPath, leaseToken: "t".repeat(64) }),
      release: async () => {},
      receiptsFor: () => [],
      runCheckPlan: async () => ({ receipts: [], canonRevision: bundle.meta.canonRevision }),
      evidenceSources: (messages: readonly WorldChatMessage[]) => ({
        messages,
        bundle,
        attachments: [],
        attachmentText: new Map(),
      }),
      now: NOW,
    });

    const outcome = await runner.send(store, conversationId, said);
    assert.equal(outcome.status, "completed", "a well-formed answer lands");

    const meta = await store.readMeta();
    const view = foldConversation(meta!.id, meta!.createdAt, (await store.read()).events).view;
    assert.equal(view.messages.length, 2, "what they said and what the studio said");
    assert.equal(view.messages[1]!.role, "studio");
    assert.equal(view.candidates.length, 1, "and the proposition it understood");
    assert.equal(view.candidates[0]!.status, "live");
    assert.equal(view.candidates[0]!.title, "A rule about the bells");
    assert.equal(view.activeRun, null, "with no run left running");
  });
});

describe("what the studio is told", () => {
  it("carries earlier turns, so the conversation is one conversation", async () => {
    const prompts: string[] = [];
    const { runner, store, conversationId } = await setup(
      fakeAdapter(["not json", "not json"], { prompts }),
    );

    await runner.send(store, conversationId, "Her aunt taught her the bells.");
    await runner.send(store, conversationId, "And the lock was built after.");

    // Two attempts per failed turn, so the second turn's first prompt is index 2.
    const secondTurn = prompts[2]!;
    assert.match(
      secondTurn,
      /Her aunt taught her the bells\./,
      "the second turn must know what was said in the first — without this the Studio answers each message as though it were the only one",
    );
    assert.match(secondTurn, /And the lock was built after\./, "and what was just said");
  });

  it("puts what it already understood in front of the model", async () => {
    const said = "Her aunt taught her the bells, not her mother.";
    const prompts: string[] = [];
    const worldPath = await tempDir("arke-ctx-");
    const conversationId = newId("cv") as ConversationId;
    const store = new WorldChatStore(conversationDir(worldPath, conversationId));
    await store.create(conversationId, AT);
    await store.append(
      { type: "conversation.created", title: "a talk", entryContext: { kind: "world" } },
      { at: AT },
    );
    const bundle: WorldBundle = (await scanWorld(FIXTURE_WORLD)).bundle;

    const good = async () => {
      const meta = await store.readMeta();
      const view = foldConversation(meta!.id, meta!.createdAt, (await store.read()).events).view;
      return goodAnswer(said, "Her aunt taught her the bells", view.messages[0]!.id);
    };

    const runner = new WorldChatRunner({
      adapter: fakeAdapter([good, "not json", "not json"], { prompts }),
      prepare: async () => ({ cwd: worldPath, leaseToken: "t".repeat(64) }),
      release: async () => {},
      receiptsFor: () => [],
      runCheckPlan: async () => ({ receipts: [], canonRevision: bundle.meta.canonRevision }),
      evidenceSources: (messages: readonly WorldChatMessage[]) => ({
        messages,
        bundle,
        attachments: [],
        attachmentText: new Map(),
      }),
      now: NOW,
    });

    await runner.send(store, conversationId, said);
    await runner.send(store, conversationId, "anything else");

    assert.match(
      prompts[1]!,
      /A rule about the bells/,
      "the proposition from the first turn is in the second turn's context, so the model corrects it rather than proposing it again",
    );
  });

  it("tells the studio what the conversation was opened about", async () => {
    const prompts: string[] = [];
    const worldPath = await tempDir("arke-entry-");
    const conversationId = newId("cv") as ConversationId;
    const store = new WorldChatStore(conversationDir(worldPath, conversationId));
    await store.create(conversationId, AT);
    // Opened from a character sheet, as the "Talk about them" button does.
    await store.append(
      {
        type: "conversation.created",
        title: "Maren Kest",
        entryContext: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" },
      },
      { at: AT },
    );
    const bundle: WorldBundle = (await scanWorld(FIXTURE_WORLD)).bundle;

    const runner = new WorldChatRunner({
      adapter: fakeAdapter(["not json", "not json"], { prompts }),
      prepare: async () => ({ cwd: worldPath, leaseToken: "t".repeat(64) }),
      release: async () => {},
      receiptsFor: () => [],
      runCheckPlan: async () => ({ receipts: [], canonRevision: bundle.meta.canonRevision }),
      evidenceSources: (messages: readonly WorldChatMessage[]) => ({
        messages,
        bundle,
        attachments: [],
        attachmentText: new Map(),
      }),
      describeEntry: (context) => describeEntryContext(context, bundle),
      now: NOW,
    });

    await runner.send(store, conversationId, "her ear is worse than the sheet says");
    assert.match(
      prompts[0]!,
      /Maren Kest/,
      "without this, somebody who clicked through from a sheet would have to describe the character they were just reading",
    );
  });

  it("names withdrawn ideas without repeating what they said", async () => {
    const prompts: string[] = [];
    const { runner, store, conversationId } = await setup(fakeAdapter(["not json", "not json"], { prompts }));
    await runner.send(store, conversationId, "the whale bone idea");
    assert.ok(prompts.length > 0);
    // Nothing withdrawn yet, so the section is simply absent rather than empty and confusing.
    assert.ok(!prompts[0]!.includes("Withdrawn"));
  });
});

describe("a turn that never answers", () => {
  it("releases partial preparation and closes the run when setup fails", async () => {
    const adapter = fakeAdapter(["unused"]);
    const { store, conversationId, view } = await setup(adapter);
    const bundle = (await scanWorld(FIXTURE_WORLD)).bundle;
    let released = false;
    const runner = new WorldChatRunner({
      adapter,
      prepare: async () => {
        throw new Error("session config could not be written");
      },
      release: async () => {
        released = true;
      },
      receiptsFor: () => [],
      runCheckPlan: async () => ({ receipts: [], canonRevision: 0 }),
      evidenceSources: (messages) => ({ messages, bundle, attachments: [], attachmentText: new Map() }),
      now: NOW,
    });

    const outcome = await runner.send(store, conversationId, "start");
    assert.equal(outcome.status, "failed");
    assert.equal(released, true);
    assert.equal((await view()).activeRun, null);
  });

  it("times out rather than waiting forever, and says so", async () => {
    const { runner, store, conversationId } = await setup(fakeAdapter([], { hang: true }), { timeoutMs: 60 });
    const outcome = await runner.send(store, conversationId, "hello");
    assert.equal(outcome.status, "timeout");

    const { events } = await store.read();
    const run = (events.find((e) => e.event.type === "run.finished")!.event as { run: { status: string } }).run;
    assert.equal(run.status, "timeout");
  });

  it("carries no world or conversation content in what it records", async () => {
    const secret = "the drowned god sings beneath the harbour";
    const { runner, store, conversationId } = await setup(fakeAdapter([], { hang: true }), { timeoutMs: 60 });
    await runner.send(store, conversationId, secret);

    const { events } = await store.read();
    const run = (events.find((e) => e.event.type === "run.finished")!.event as {
      run: { safeDetail?: string };
    }).run;
    assert.ok(
      !(run.safeDetail ?? "").includes(secret),
      "operator-safe detail never carries what was said",
    );
  });

  it("stops immediately when cancelled, without waiting for the model", async () => {
    const { runner, store, conversationId } = await setup(fakeAdapter([], { hang: true }), { timeoutMs: 30_000 });
    const inFlight = runner.send(store, conversationId, "hello");
    // The run registers itself synchronously before awaiting the model, so this reaches it.
    await new Promise((resolve) => setImmediate(resolve));
    const stopped = runner.cancel(conversationId);
    const outcome = await inFlight;

    assert.equal(stopped, true);
    assert.equal(outcome.status, "cancelled");
    const { events } = await store.read();
    const run = (events.find((e) => e.event.type === "run.finished")!.event as { run: { status: string } }).run;
    assert.equal(run.status, "interrupted");
  });

  it("reports nothing to cancel when no turn is running", async () => {
    const { runner, conversationId } = await setup(fakeAdapter(["x"]));
    assert.equal(runner.cancel(conversationId), false);
  });

  it("says what was wrong with the answer, not that something was", async () => {
    /*
     * Found on 2026-08-21 driving a production thread in the installed app. Two turns failed and
     * the only record anywhere — log line, run detail, the line the screen could have shown — was
     * the word "schema". The comment above the code that produced it said the problems "are
     * already worded for a person and are the whole reason this failed", and the code mapped
     * `.code`, throwing the wording away. Unreadable in exactly the way it was written to fix.
     */
    const failures: string[] = [];
    const worldPath = await tempDir("arke-cause-");
    const conversationId = newId("cv") as ConversationId;
    const store = new WorldChatStore(conversationDir(worldPath, conversationId));
    await store.create(conversationId, AT);
    await store.append(
      { type: "conversation.created", title: "a talk", entryContext: { kind: "world" } },
      { at: AT },
    );
    const bundle: WorldBundle = (await scanWorld(FIXTURE_WORLD)).bundle;

    // Valid JSON, wrong shape — the schema path rather than the not-json one.
    const wrongShape = JSON.stringify({ reply: 7, propositions: "not an array" });
    const runner = new WorldChatRunner({
      adapter: fakeAdapter([wrongShape, wrongShape]),
      prepare: async () => ({ cwd: worldPath, leaseToken: "t".repeat(64) }),
      release: async () => {},
      receiptsFor: () => [],
      runCheckPlan: async () => ({ receipts: [], canonRevision: bundle.meta.canonRevision }),
      evidenceSources: (messages: readonly WorldChatMessage[]) => ({
        messages,
        bundle,
        attachments: [],
        attachmentText: new Map(),
      }),
      now: NOW,
      onTurnFailed: ({ cause }) => void failures.push(cause),
    });

    const outcome = await runner.send(store, conversationId, "what happened here?");
    assert.equal(outcome.status, "failed");
    assert.equal(failures.length, 1, "the failure is reported once");
    const cause = failures[0]!;
    assert.match(cause, /^answer rejected: /);
    assert.ok(
      cause.replace("answer rejected: ", "").trim().length > "schema".length,
      `the cause carries the wording, not a code: ${cause}`,
    );
    assert.notEqual(cause, "answer rejected: schema", "which is what it used to say, every time");

    // And the retry the run recorded says the same, since that is the copy that lives on disk.
    const events = (await store.read()).events;
    const retry = events.map((e) => e.event).find((e) => e.type === "run.retry-started");
    assert.ok(retry, "a corrective turn was taken");
    const detail = (retry as { run: { safeDetail?: string } }).run.safeDetail ?? "";
    assert.notEqual(detail, "schema", "the run's own record is readable too");
    assert.ok(detail.length > 0);

    // The finish record is the copy the person sees; "did not go through" here is what made a
    // repeating rejection read as a network blip (review 2026-08-22).
    const finished = events.map((e) => e.event).findLast((e) => e.type === "run.finished");
    assert.ok(finished, "the run finished on the record");
    const finalDetail = (finished as { run?: { safeDetail?: string } }).run?.safeDetail ?? "";
    assert.match(finalDetail, /^rejected: /, "the person is told it was rejected, and why");
    assert.ok(finalDetail.length > "rejected: ".length, `and the why is present: ${finalDetail}`);
  });
});

/**
 * A refusal is the one thing in a turn that can contradict the answer (issue 506).
 *
 * Measured against 0.5.50: asked to run `echo ARKE_SHELL_PROBE_7731` and paste the output, the
 * studio reported the output and an exit code. The gate had refused every call; nothing on the
 * screen said so, so there was nothing to read the reply against.
 */
describe("what a turn was refused", () => {
  async function landing(refuses: readonly string[]) {
    const said = "Her aunt taught her the bells, not her mother.";
    const worldPath = await tempDir("arke-run-refused-");
    const conversationId = newId("cv") as ConversationId;
    const store = new WorldChatStore(conversationDir(worldPath, conversationId));
    await store.create(conversationId, AT);
    await store.append(
      { type: "conversation.created", title: "a talk", entryContext: { kind: "world" } },
      { at: AT },
    );
    const bundle: WorldBundle = (await scanWorld(FIXTURE_WORLD)).bundle;
    const answer = async () => {
      const meta = await store.readMeta();
      const view = foldConversation(meta!.id, meta!.createdAt, (await store.read()).events).view;
      return goodAnswer(said, "Her aunt taught her the bells", view.messages[0]!.id);
    };
    const runner = new WorldChatRunner({
      adapter: fakeAdapter([answer], { refuses }),
      prepare: async () => ({ cwd: worldPath, leaseToken: "t".repeat(64) }),
      release: async () => {},
      receiptsFor: () => [],
      runCheckPlan: async () => ({ receipts: [], canonRevision: bundle.meta.canonRevision }),
      evidenceSources: (messages: readonly WorldChatMessage[]) => ({
        messages,
        bundle,
        attachments: [],
        attachmentText: new Map(),
      }),
      now: NOW,
    });
    const outcome = await runner.send(store, conversationId, said);
    const meta = await store.readMeta();
    const view = foldConversation(meta!.id, meta!.createdAt, (await store.read()).events).view;
    return { outcome, view, store };
  }

  it("records it against the reply that was written anyway", async () => {
    const { outcome, view } = await landing(["Bash"]);
    assert.equal(outcome.status, "completed", "a refused tool does not fail the turn");
    const user = view.messages.find((m) => m.role === "user")!;
    const reply = view.messages.find((m) => m.role === "studio")!;
    assert.equal(reply.turnId, user.turnId, "the reply and cards produced with it share the originating turn");
    assert.deepEqual(view.refusals[reply.id], ["Bash"], "keyed by the message it sits under");
  });

  it("says it once however many times the agent tried", async () => {
    const { view } = await landing(["Bash", "Bash", "Bash"]);
    const reply = view.messages.find((m) => m.role === "studio")!;
    // Deduplicated at the source: three attempts at one thing are one thing, and three lines
    // saying so would read as three separate events.
    assert.deepEqual(view.refusals[reply.id], ["Bash"]);
  });

  it("leaves an ordinary turn with nothing to say", async () => {
    const { view, store } = await landing([]);
    const reply = view.messages.find((m) => m.role === "studio")!;
    assert.equal(view.refusals[reply.id], undefined, "the field is absent, not empty");
    const completed = (await store.read()).events
      .map((e) => e.event)
      .find((e) => e.type === "turn.completed") as { refusedTools?: unknown };
    assert.equal(completed.refusedTools, undefined, "and nothing is written to the log either");
  });
});

describe("a rename becomes a fenced action without writing during the turn (SPEC-041 R-59)", () => {
  /** A scene thread, with the two deps the rename needs handed in by the test. */
  async function sceneSetup(
    adapter: HarnessAdapter,
    deps: {
      sceneVersion?: () => number | null;
      validateSceneEdits?: (input: {
        edits: readonly { kind: "rename"; title: string }[];
        baseVersion: number | null;
      }) => Promise<void>;
      validateBibleEdits?: () => Promise<void>;
    },
  ) {
    const worldPath = await tempDir("arke-run-scene-");
    const conversationId = newId("cv") as ConversationId;
    const store = new WorldChatStore(conversationDir(worldPath, conversationId));
    await store.create(conversationId, AT);
    await store.append(
      {
        type: "conversation.created",
        title: "scene talk",
        entryContext: { kind: "scene", productionId: "saltlight", sceneId: "sc_04" },
      },
      { at: AT },
    );
    const bundle: WorldBundle = (await scanWorld(FIXTURE_WORLD)).bundle;
    const runner = new WorldChatRunner({
      adapter,
      prepare: async () => ({ cwd: worldPath, leaseToken: "t".repeat(64) }),
      release: async () => {},
      receiptsFor: () => [],
      runCheckPlan: async () => ({ receipts: [], canonRevision: bundle.meta.canonRevision }),
      evidenceSources: (messages: readonly WorldChatMessage[]) => ({
        messages,
        bundle,
        attachments: [],
        attachmentText: new Map(),
      }),
      prepareActions: () => [],
      bindActions: async () => {},
      now: NOW,
      ...deps,
    });
    const view = async () => {
      const meta = await store.readMeta();
      return foldConversation(meta!.id, meta!.createdAt, (await store.read()).events).view;
    };
    return { runner, store, conversationId, view };
  }
  const renaming = (title: string) =>
    JSON.stringify({ reply: `Called it ${title}.`, candidateOperations: [], groupOperations: [], sceneEdits: [{ kind: "rename", title }] });
  const plain = JSON.stringify({ reply: "Left the name as it was.", candidateOperations: [], groupOperations: [] });

  it("checks the rename once against the version the prompt was built from and makes no target write", async () => {
    const validated: Array<{ baseVersion: number | null; titles: string[] }> = [];
    const { runner, store, conversationId, view } = await sceneSetup(fakeAdapter([renaming("The tide answers")]), {
      sceneVersion: () => 3,
      validateSceneEdits: async ({ edits, baseVersion }) => {
        validated.push({ baseVersion, titles: edits.map((edit) => edit.title) });
      },
    });
    await runner.send(store, conversationId, "Call this one The tide answers");
    assert.deepEqual(
      validated,
      [{ baseVersion: 3, titles: ["The tide answers"] }],
      "turn completion only validates; the authority write waits for approval",
    );
    const folded = await view();
    assert.match(folded.messages.at(-1)?.text ?? "", /Called it/, "and the reply that landed with it stands");
  });

  it("a rename never lands under a turn the bible then refuses (codex, PR 716)", async () => {
    const prompts: string[] = [];
    let sceneValidations = 0;
    const withBible = JSON.stringify({
      reply: "Named it and noted it.",
      candidateOperations: [],
      groupOperations: [],
      bibleEdits: [{ op: "append-to-section", heading: "Nowhere", text: "x" }],
      sceneEdits: [{ kind: "rename", title: "From the model" }],
    });
    const { runner, store, conversationId, view } = await sceneSetup(fakeAdapter([withBible, plain], { prompts }), {
      sceneVersion: () => 2,
      validateSceneEdits: async () => {
        sceneValidations += 1;
      },
      validateBibleEdits: async () => {
        throw new Error("no such heading");
      },
    });
    await runner.send(store, conversationId, "Name it and note it");
    assert.equal(sceneValidations, 1, "the rename was checked, and never written: the bible refused first");
    assert.ok(prompts.some((prompt) => /bible could not be edited/.test(prompt)), "the bible's refusal is what the retry answers");
    const folded = await view();
    assert.match(folded.messages.at(-1)?.text ?? "", /Left the name as it was/);
  });

  it("a refused rename is the one corrective problem, and the retry that drops it completes", async () => {
    const prompts: string[] = [];
    let attempts = 0;
    const { runner, store, conversationId, view } = await sceneSetup(fakeAdapter([renaming("From the model"), plain], { prompts }), {
      sceneVersion: () => 2,
      validateSceneEdits: async () => {
        attempts += 1;
        throw new SceneEditRefused("The scene changed while you were answering, so it was left alone. Answer without renaming it this turn.");
      },
    });
    await runner.send(store, conversationId, "Name it");
    assert.equal(attempts, 1, "asked once; the retry carried no rename");
    assert.ok(prompts.some((prompt) => /changed while you were answering/.test(prompt)), "the refusal reached the model in its own words");
    const folded = await view();
    assert.match(folded.messages.at(-1)?.text ?? "", /Left the name as it was/);
  });

  it("an error that is not a refusal reaches the model as the fixed line, never as a path (codex, PR 716)", async () => {
    const prompts: string[] = [];
    const { runner, store, conversationId } = await sceneSetup(fakeAdapter([renaming("Anything"), plain], { prompts }), {
      sceneVersion: () => 2,
      validateSceneEdits: async () => {
        throw new Error("ENOENT: no such file, open '/Users/private/worlds/the-undersong/productions/saltlight/scenes/x.json'");
      },
    });
    await runner.send(store, conversationId, "Name it");
    const corrective = prompts.find((prompt) => /could not be renamed/.test(prompt));
    assert.ok(corrective, "the model is told the rename failed");
    assert.ok(!/ENOENT|private|the-undersong/.test(corrective!), "and nothing about where the world lives");
  });

  it("a rename with nowhere to land is refused rather than silently dropped", async () => {
    const prompts: string[] = [];
    const { runner, store, conversationId } = await sceneSetup(fakeAdapter([renaming("Anything"), plain], { prompts }), {});
    await runner.send(store, conversationId, "Name it");
    assert.ok(prompts.some((prompt) => /cannot be renamed in this conversation/.test(prompt)), "told the model, not swallowed");
  });
});
