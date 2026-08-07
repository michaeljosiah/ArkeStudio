import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorldChatSummary } from "@arke-studio/contracts";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __applyEventForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { byPendingConsequence } from "../src/screens/world-chat.js";

/**
 * The World Chat workspace (#70 phase 3).
 *
 * The ordering test is the one that matters. Everything else on this screen is presentation; the
 * order of the list is a judgement about what the person opening it is most likely to owe
 * somebody, and getting it wrong buries the thing they came for.
 */

const AT = "2026-08-06T10:00:00Z";

function row(over: Partial<WorldChatSummary>): WorldChatSummary {
  return {
    id: `cv_01J8F3K2QW9VZX4N7M0RTYB${String(over.pointCount ?? 0).padStart(3, "0")}`.slice(0, 30) as never,
    title: "a conversation",
    status: "open",
    updatedAt: AT,
    pointCount: 0,
    openProposalCount: 0,
    ...over,
  } as WorldChatSummary;
}

describe("ordering conversations by pending consequence", () => {
  it("puts a conversation with proposals waiting above everything else", () => {
    const busy = row({ title: "recent, nothing owed", updatedAt: "2026-08-06T23:00:00Z", pointCount: 9 });
    const owed = row({ title: "older, owes a decision", updatedAt: "2026-01-01T00:00:00Z", openProposalCount: 2 });

    const sorted = [busy, owed].sort(byPendingConsequence);
    assert.equal(
      sorted[0]!.title,
      "older, owes a decision",
      "recency would bury the thing that is actually waiting on somebody",
    );
  });

  it("ranks more waiting proposals first", () => {
    const one = row({ title: "one", openProposalCount: 1 });
    const three = row({ title: "three", openProposalCount: 3 });
    assert.equal([one, three].sort(byPendingConsequence)[0]!.title, "three");
  });

  it("puts open conversations above closed and archived ones", () => {
    const archived = row({ title: "archived", status: "archived" });
    const closed = row({ title: "closed", status: "closed" });
    const open = row({ title: "open", status: "open" });
    assert.deepEqual(
      [archived, closed, open].sort(byPendingConsequence).map((r) => r.title),
      ["open", "closed", "archived"],
    );
  });

  it("falls back to how much was understood, then to recency", () => {
    const few = row({ title: "few", pointCount: 1 });
    const many = row({ title: "many", pointCount: 8 });
    assert.equal([few, many].sort(byPendingConsequence)[0]!.title, "many");

    const older = row({ title: "older", updatedAt: "2026-01-01T00:00:00Z" });
    const newer = row({ title: "newer", updatedAt: "2026-08-06T12:00:00Z" });
    assert.equal([older, newer].sort(byPendingConsequence)[0]!.title, "newer");
  });

  it("does not reorder equal rows, so the list does not shuffle as it refreshes", () => {
    const a = row({ title: "a" });
    const b = row({ title: "b" });
    assert.deepEqual([a, b].sort(byPendingConsequence).map((r) => r.title), ["a", "b"]);
  });
});


/**
 * There has to be a way in.
 *
 * The whole feature was built — store, retrieval, turn engine, workspace, wrap-up — with no
 * control anywhere that creates a conversation. The screen said "No conversations yet" and left
 * it at that, which is a door with no handle.
 */
describe("starting a conversation", () => {
  function render(state: ClientState): string {
    __setStateForTest(state);
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/chat`]}>
        <App />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");
  }

  const withConversations = (rows: unknown[]): ClientState => ({
    ...FIXTURE_STATE,
    world: { ...FIXTURE_STATE.world!, conversations: rows as never },
  });

  it("offers a way in when there are none", () => {
    assert.match(render(withConversations([])), /Start a conversation/);
  });

  it("offers a way in when there already are some", () => {
    const html = render(
      withConversations([
        {
          id: "cv_01J8F3K2QW9VZX4N7M0RTYB6HC",
          title: "The bells",
          status: "open",
          updatedAt: AT,
          pointCount: 1,
          openProposalCount: 0,
          notCarried: [],
        },
      ]),
    );
    assert.match(html, /New conversation/, "starting a second one must not require deleting the first");
  });

  it("does not disable the way in when the studio is not running", () => {
    const down: ClientState = {
      ...withConversations([]),
      app: {
        ...FIXTURE_STATE.app,
        health: { ...FIXTURE_STATE.app.health, harness: { status: "unavailable", reason: "not started" } },
      },
    };
    const html = render(down);
    assert.match(html, /Start a conversation/);
    assert.match(
      html,
      /needs OpenCode running/,
      "it says what is missing rather than presenting a button that does nothing",
    );
  });
});


/**
 * Handing a conversation a file (#70 §13.1, §13.2).
 *
 * The composer has always been able to take attachments — drag, paste, picker, chips — and World
 * Chat passed it none of the handlers, so it could display attachments it had no way to create.
 * What is worth pinning is the honesty of the refusal: an unreadable file must not land as a chip
 * that looks attached, because the person then carries on talking as though it had been read.
 */
describe("attaching a document to a conversation", () => {
  const CONVERSATION_ID = "cv_01J8F3K2QW9VZX4N7M0RTYB6HC";

  function renderConversation(over: Partial<ClientState> = {}): string {
    __setStateForTest({
      ...FIXTURE_STATE,
      world: {
        ...FIXTURE_STATE.world!,
        conversations: [
          {
            id: CONVERSATION_ID as never,
            title: "The bells",
            status: "open",
            updatedAt: AT,
            pointCount: 0,
            openProposalCount: 0,
            notCarried: [],
          },
        ],
      },
      worldChat: {
        conversationId: CONVERSATION_ID,
        status: "open",
        messages: [],
        hasMore: false,
        seq: 1,
        points: [],
        attachments: [],
        runStatus: null,
        retrievalUnavailable: false,
      } as never,
      ...over,
    });
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/chat/${CONVERSATION_ID}`]}>
        <App />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");
  }

  it("offers a way to attach at all", () => {
    assert.match(
      renderConversation(),
      /fy-cx__attach/,
      "the composer could show attachments it had no way to be given",
    );
  });

  it("shows a readable document under its own name", () => {
    const html = renderConversation({
      worldChat: {
        conversationId: CONVERSATION_ID,
        status: "open",
        messages: [],
        hasMore: false,
        seq: 1,
        points: [],
        attachments: [
          { id: "wca_1", fileName: "undersong-draft.md", kind: "document", readability: "text-readable", promoted: false },
        ],
        runStatus: null,
        retrievalUnavailable: false,
      } as never,
    });
    assert.match(html, /undersong-draft\.md/);
    assert.doesNotMatch(html, /not readable in chat/);
  });

  it("marks an unreadable attachment on its chip rather than letting it pass as read", () => {
    const html = renderConversation({
      worldChat: {
        conversationId: CONVERSATION_ID,
        status: "open",
        messages: [],
        hasMore: false,
        seq: 1,
        points: [],
        attachments: [
          { id: "wca_2", fileName: "brief.pdf", kind: "document", readability: "not-readable", promoted: false },
        ],
        runStatus: null,
        retrievalUnavailable: false,
      } as never,
    });
    assert.match(html, /not readable in chat/);
  });

  /**
   * Driven through the real event rather than by setting state, because the refusal has no
   * durable home: nothing was written, so the event is the only thing carrying it and the path
   * from it to the chip is the thing worth testing.
   */
  it("says on a chip what it would not take, and why", () => {
    renderConversation();
    __applyEventForTest({
      at: AT,
      type: "world-chat.attachment-refused",
      conversationId: CONVERSATION_ID,
      name: "maren.png",
      reason: "World Chat can only read text for now, and maren.png is an image file.",
    } as never);
    const html = renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/chat/${CONVERSATION_ID}`]}>
        <App />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");

    assert.match(html, /maren\.png/);
    assert.match(html, /can only read text for now/, "a file that vanished silently would read as a bug");
  });

  it("keeps one conversation's refusals out of another's composer", () => {
    renderConversation();
    __applyEventForTest({
      at: AT,
      type: "world-chat.attachment-refused",
      conversationId: "cv_01J8F3K2QW9VZX4N7M0RTYB6HZ",
      name: "elsewhere.png",
      reason: "World Chat can only read text for now.",
    } as never);
    const html = renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/chat/${CONVERSATION_ID}`]}>
        <App />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");

    assert.doesNotMatch(html, /elsewhere\.png/, "attachment linkage is scoped to one conversation (§13.1)");
  });
});

/**
 * Getting rid of a conversation (R-50, §15.1).
 *
 * The list was a set of bare links: a conversation could be started and never disposed of. The
 * thing worth pinning is not that Delete exists but that it never stands alone — deletion is
 * refused for as long as a conversation's proposals are undecided, which is most of the time it
 * has done anything, and a row offering only the control that will not work reads as broken.
 */
describe("disposing of a conversation", () => {
  function renderList(rows: unknown[]): string {
    __setStateForTest({
      ...FIXTURE_STATE,
      world: { ...FIXTURE_STATE.world!, conversations: rows as never },
    });
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/chat`]}>
        <App />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");
  }

  const listed = (over: Partial<WorldChatSummary>) => ({
    id: "cv_01J8F3K2QW9VZX4N7M0RTYB6HC",
    title: "The bells",
    status: "open",
    updatedAt: AT,
    pointCount: 1,
    openProposalCount: 0,
    notCarried: [],
    ...over,
  });

  it("offers both, because archive is the answer whenever delete is refused", () => {
    const html = renderList([listed({})]);
    assert.match(html, /Archive/);
    assert.match(html, /Delete/);
  });

  it("says why delete is unavailable, in text rather than a tooltip", () => {
    const html = renderList([
      listed({ openProposalCount: 2, deletionBlock: "unresolved-proposals" } as never),
    ]);
    assert.match(
      html,
      /Cannot delete — its proposals are still waiting/,
      "a reason only a mouse can reach is not a reason",
    );
    assert.match(html, /disabled/, "and the control is genuinely unavailable, not merely explained");
    assert.match(html, /Archive/, "while the thing that does work is still offered");
  });

  it("does not confirm before it is asked to — the row is not a warning", () => {
    assert.doesNotMatch(renderList([listed({})]), /go for good/);
  });

  it("gives archived conversations their own heading rather than sinking them into the list", () => {
    const html = renderList([
      listed({ title: "still going" }),
      listed({ id: "cv_01J8F3K2QW9VZX4N7M0RTYB6HD", title: "shelved", status: "archived" }),
    ]);
    assert.match(html, /Archived · 1/, "archiving has to visibly tidy or nobody uses it");
    assert.match(html, /Restore/, "and what was shelved can be taken back off the shelf");
  });
});

/**
 * A conversation you have just made is not missing.
 *
 * Reported from a real session: clicking "Start a conversation" landed on "That conversation is
 * not here". The workspace had loaded and the summary row had not, because `.conversations` is
 * excluded from the watcher and the cached bundle never noticed the new one. The screen believed
 * the stale list over the workspace in front of it.
 */
describe("arriving at a conversation the list has not caught up with", () => {
  function renderAt(state: ClientState, conversationId: string): string {
    __setStateForTest(state);
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/chat/${conversationId}`]}>
        <App />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");
  }

  const CV = "cv_01J8F3K2QW9VZX4N7M0RTYB6HC";

  const workspace = {
    conversationId: CV,
    status: "open",
    seq: 1,
    hasMore: false,
    runStatus: null,
    retrievalUnavailable: false,
    messages: [],
    points: [],
    attachments: [],
  };

  it("shows the conversation when the workspace has it but the list does not", () => {
    const state = {
      ...FIXTURE_STATE,
      world: { ...FIXTURE_STATE.world!, conversations: [] },
      worldChat: workspace as never,
    } as ClientState;

    const html = renderAt(state, CV);
    assert.ok(
      !html.includes("That conversation is not here"),
      "the workspace loaded by this id is better evidence than a list that has not refreshed",
    );
  });

  it("still says so when neither has it", () => {
    const state = {
      ...FIXTURE_STATE,
      world: { ...FIXTURE_STATE.world!, conversations: [] },
      worldChat: null,
    } as ClientState;
    assert.match(renderAt(state, CV), /That conversation is not here/);
  });
});
