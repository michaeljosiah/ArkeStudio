import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ClientState } from "@arke-studio/contracts";
import { AppLog } from "../../src/app-log.js";
import { buildDiagnosticsBundle } from "../../src/diagnostics.js";
import { SecretRegistry } from "../../src/redact.js";
import { wordReceipt } from "../../src/world-chat/project.js";
import { tempDir } from "../tmp.js";

/**
 * What a conversation must never leak into (#70 §2.9, §9.3).
 *
 * A diagnostics bundle is made to be sent to somebody else. That is its entire purpose, and it is
 * why the rule about what may go in it has to be checked rather than remembered: the bundle is
 * assembled from a hand-picked set of fields, which is safe until the day somebody adds a field.
 *
 * A conversation is the most private thing this app holds. It is a person thinking out loud about
 * work that does not exist yet, in their own words, and none of it is anybody else's business —
 * not ours, and not a support channel's.
 */

/** Distinctive enough that a substring search cannot miss it if it leaks. */
const SAID = "the drowned god sings beneath the harbour at slack water";
const UNDERSTOOD = "Maren was raised by her aunt, not her mother";
const TITLE = "The bells and the lock";

function stateWithAConversation(): ClientState {
  return {
    app: {
      version: "0.4.1",
      health: {
        coordinator: { status: "healthy" },
        harness: { status: "healthy" },
        voice: { status: "unavailable", reason: "not started" },
      },
      jobs: [],
      ledger: [],
      providers: [],
      manifest: null,
      routing: { defaults: {}, faults: [] },
      models: { disabled: [] },
      spend: null,
      backgroundNotifications: "issues-only",
      appearance: { theme: "system" },
      runtime: null,
      harness: null,
      voiceRuntime: null,
      drift: [],
      agents: [],
      env: null,
    },
    worlds: [],
    world: null,
    worldChat: {
      conversationId: "cv_01J8F3K2QW9VZX4N7M0RTYB6HC",
      status: "open",
      seq: 2,
      hasMore: false,
      runStatus: null,
      retrievalUnavailable: false,
      attachments: [],
      messages: [
        {
          id: "msg_01J8F3K2QW9VZX4N7M0RTYB6HC",
          role: "user",
          text: SAID,
          receipts: [],
          createdAt: "2026-08-06T10:00:00Z",
        },
      ],
      points: [
        {
          id: "cand_01J8F3K2QW9VZX4N7M0RTYB6HC",
          kind: "point",
          subject: "Maren Kest",
          subjectKind: "sheet · v4",
          text: UNDERSTOOD,
          settled: true,
        },
      ],
    },
  } as unknown as ClientState;
}

describe("a conversation never reaches a diagnostics bundle", () => {
  it("carries nothing that was said", async () => {
    const bundle = await buildDiagnosticsBundle(stateWithAConversation(), null, new SecretRegistry());
    const text = JSON.stringify(bundle);
    assert.ok(!text.includes(SAID), "a bundle is made to be sent to somebody else");
  });

  it("carries nothing the studio understood", async () => {
    const bundle = await buildDiagnosticsBundle(stateWithAConversation(), null, new SecretRegistry());
    assert.ok(!JSON.stringify(bundle).includes(UNDERSTOOD));
  });

  it("does not even carry a conversation's title or id", async () => {
    const state = stateWithAConversation();
    (state as { worldChat: { title?: string } }).worldChat.title = TITLE;
    const text = JSON.stringify(await buildDiagnosticsBundle(state, null, new SecretRegistry()));
    assert.ok(!text.includes(TITLE), "a title is a sentence somebody wrote about their world");
    assert.ok(!text.includes("cv_01J8F3K2QW9VZX4N7M0RTYB6HC"));
  });

  it("has no worldChat section at all, rather than an emptied one", async () => {
    const bundle = await buildDiagnosticsBundle(stateWithAConversation(), null, new SecretRegistry());
    assert.ok(!("worldChat" in bundle), "the safe shape is absence, not a section somebody may later fill");
  });
});

describe("what World Chat may write to the app log", () => {
  it("records a refused wrap-up by reason, never by content", async () => {
    const dir = await tempDir("arke-privacy-");
    const log = new AppLog(join(dir, "app.jsonl"), new SecretRegistry());
    // What the coordinator actually appends when a wrap-up is refused.
    await log.append({ level: "warn", event: "world-chat.wrap-up-refused", reason: "nothing-to-carry" });
    await log.drain();

    const lines = await log.tail(10);
    const text = JSON.stringify(lines);
    assert.match(text, /wrap-up-refused/, "the event is recorded");
    assert.ok(!text.includes(SAID), "and says why without saying what");
    assert.ok(!text.includes(UNDERSTOOD));
  });
});

describe("receipts say what was checked, not what was found", () => {
  it("summarises a search without quoting the world", () => {
    const worded = wordReceipt({
      id: "check_01J8F3K2QW9VZX4N7M0RTYB6HC" as never,
      runId: "run_01J8F3K2QW9VZX4N7M0RTYB6HC" as never,
      tool: "search-canon",
      status: "empty",
      querySummary: "the bells",
      consulted: [],
      searchedCount: 41,
      at: "2026-08-06T10:00:00Z",
    });
    // §9.3: querySummary is safe product text, and this is the line a person reads under a reply.
    assert.match(worded, /41/, "how widely it looked");
    assert.ok(worded.length < 120, "a receipt is a line, not a transcript of the search");
  });

  it("says it could not look, rather than that it found nothing", () => {
    const worded = wordReceipt({
      id: "check_01J8F3K2QW9VZX4N7M0RTYB6HD" as never,
      runId: "run_01J8F3K2QW9VZX4N7M0RTYB6HC" as never,
      tool: "search-canon",
      status: "unavailable",
      consulted: [],
      at: "2026-08-06T10:00:00Z",
    });
    assert.match(worded, /could not search/);
    assert.ok(!/nothing close/.test(worded), "the two must never read the same");
  });
});
