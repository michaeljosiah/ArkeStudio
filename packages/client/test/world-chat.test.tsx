import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorldChatSummary } from "@arke-studio/contracts";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import {
  __applyEventForTest,
  __connectionStatusForTest,
  __setStateForTest,
  wrapUpWorldChat,
} from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { RowMenuPanel, byPendingConsequence } from "../src/screens/world-chat.js";

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
 * The way in is the screen (design 71).
 *
 * The whole feature was built — store, retrieval, turn engine, workspace, wrap-up — with no
 * control anywhere that creates a conversation, and the screen said "No conversations yet" and
 * left it at that. The fix after that was a list with a button on it, which is a door in front of
 * a door: arriving at World Chat meant choosing what to read before saying anything. `/chat` is
 * now a conversation nobody has said anything in yet, and the composer is the way in.
 */
describe("arriving at World Chat", () => {
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

  it("opens on a conversation rather than on a list of them", () => {
    const html = render(withConversations([]));
    assert.match(html, /New conversation/, "the head names what this is");
    assert.match(
      html,
      /Say something about this world/,
      "and the composer says what to do with it, rather than a screen in front of it",
    );
  });

  it("says nothing has been understood, because nothing has been said", () => {
    const html = render(withConversations([]));
    assert.match(html, /Nothing understood yet/);
    assert.match(html, /Nothing is ready to write yet/);
  });

  it("offers another way in beside the conversations already had", () => {
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
    assert.match(html, /The bells/, "the history is beside the conversation, not in front of it");
    assert.match(html, /New conversation/, "starting a second one must not require deleting the first");
    assert.match(html, /Hide history/, "and it can be put away");
  });

  it("says on a row what that conversation is owed, and nothing when it is owed nothing", () => {
    const html = render(
      withConversations([
        {
          id: "cv_01J8F3K2QW9VZX4N7M0RTYB6HC",
          title: "owed",
          status: "open",
          updatedAt: AT,
          pointCount: 1,
          openProposalCount: 2,
          notCarried: [],
        },
      ]),
    );
    assert.match(html, /2 waiting on you/);
    assert.doesNotMatch(
      html,
      /points to decide/,
      "a rail is scanned, so status does not earn a permanent second line",
    );
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
    assert.match(html, /New conversation/);
    assert.match(
      html,
      /needs OpenCode running/,
      "it says what is missing rather than presenting a button that does nothing",
    );
  });
});


/**
 * The turn in flight (#70 §15.3), ported from opencode's `[spinner] Making edits · 12s`.
 *
 * Reported from the packaged build as "there is nothing indicating that the AI is thinking". It
 * was worse than a missing indicator: `runStatus` could never be `running` at all, because the
 * fold calls every unterminated run interrupted, so the composer never locked and Stop never
 * appeared either. Silence for two minutes is indistinguishable from having sent nothing.
 */
describe("saying that the studio is working", () => {
  const CV = "cv_01J8F3K2QW9VZX4N7M0RTYB6HC";

  function renderWorking(over: Record<string, unknown> = {}): string {
    __setStateForTest({
      ...FIXTURE_STATE,
      world: {
        ...FIXTURE_STATE.world!,
        conversations: [
          {
            id: CV as never,
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
        conversationId: CV,
        status: "open",
        messages: [],
        hasMore: false,
        seq: 1,
        points: [],
        attachments: [],
        runStatus: "running",
        runStartedAt: AT,
        retrievalUnavailable: false,
        ...over,
      } as never,
    });
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/chat/${CV}`]}>
        <App />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");
  }

  it("shows a working line while a turn is in flight", () => {
    const html = renderWorking();
    assert.match(html, /fy-working/, "the whole complaint was that nothing appeared");
    assert.match(html, /aria-live="polite"/, "and it is announced, once, rather than only drawn");
  });

  it("says a word rather than only spinning", () => {
    assert.match(renderWorking(), /Thinking/, "a spinner with no words is a shrug");
  });

  it("offers Stop beside the thing it stops, and names the shortcut", () => {
    const html = renderWorking();
    assert.match(html, /fy-working__stop/);
    assert.match(html, /esc/, "a keybinding nobody is told about is not a feature");
  });

  it("shows nothing at all once the turn is done", () => {
    const html = renderWorking({ runStatus: null, runStartedAt: null });
    assert.doesNotMatch(html, /fy-working/, "the line belongs to the turn, not to the screen");
  });

  /**
   * Caught by watching a real turn: the sequence began "Writing" — the last word of the
   * *previous* turn. Progress is transient and keyed by conversation, so without gating it on
   * the run's own start, every turn opens by describing work that finished a minute ago.
   */
  it("ignores a label left over from the previous turn", () => {
    renderWorking();
    __applyEventForTest({
      at: "2026-08-06T09:59:00Z", // before this run started
      type: "world-chat.progress",
      conversationId: CV,
      label: "Writing",
    } as never);
    const html = renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/chat/${CV}`]}>
        <App />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");

    assert.match(html, /Thinking/, "it falls back to the resting word");
    assert.doesNotMatch(html, /Writing/, "rather than describing the turn before this one");
  });

  it("takes a label produced by this turn", () => {
    renderWorking();
    __applyEventForTest({
      at: "2026-08-06T10:00:30Z", // after this run started
      type: "world-chat.progress",
      conversationId: CV,
      label: "Searching canon",
    } as never);
    const html = renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/chat/${CV}`]}>
        <App />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");

    assert.match(html, /Searching canon/);
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
        runStartedAt: null,
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
        runStartedAt: null,
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
        runStartedAt: null,
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
  function renderRail(rows: unknown[]): string {
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

  const listed = (over: Partial<WorldChatSummary>) =>
    ({
      id: "cv_01J8F3K2QW9VZX4N7M0RTYB6HC",
      title: "The bells",
      status: "open",
      updatedAt: AT,
      pointCount: 1,
      openProposalCount: 0,
      notCarried: [],
      ...over,
    }) as WorldChatSummary;

  /** The row with its menu already open — the state a press puts it in, rendered directly. */
  function renderMenu(row: WorldChatSummary, confirming = false): string {
    return renderToString(
      <MemoryRouter>
        <RowMenuPanel
          worldId={FIXTURE_WORLD_ID}
          row={row}
          menu={{ id: row.id, x: 0, y: 0, confirming }}
          onOpenMenu={() => {}}
          onCloseMenu={() => {}}
        />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");
  }

  it("puts the menu on the row, so a rail scanned for a title still disposes of one", () => {
    assert.match(renderRail([listed({})]), /aria-label="More"/);
  });

  it("offers both, because archive is the answer whenever delete is refused", () => {
    const html = renderMenu(listed({}));
    assert.match(html, /Archive/);
    assert.match(html, /Delete/);
  });

  it("says why delete is unavailable, in text rather than a tooltip", () => {
    const html = renderMenu(
      listed({ openProposalCount: 2, deletionBlock: "unresolved-proposals" } as never),
    );
    assert.match(
      html,
      /its proposals are still waiting/,
      "a reason only a mouse can reach is not a reason",
    );
    assert.match(html, /disabled/, "and the control is genuinely unavailable, not merely explained");
    assert.match(html, /Archive/, "while the thing that does work is still offered");
  });

  it("does not confirm before it is asked to — the menu is not a warning", () => {
    assert.doesNotMatch(renderMenu(listed({})), /go for good/);
    assert.match(renderMenu(listed({}), true), /go for good/, "and says what goes when it is");
  });

  it("offers a shelved conversation back rather than only the way to shelve it", () => {
    assert.match(renderMenu(listed({ status: "archived" })), /Restore/);
  });

  it("keeps archived conversations behind a disclosure rather than sinking them into the list", () => {
    const html = renderRail([
      listed({ title: "still going" }),
      listed({ id: "cv_01J8F3K2QW9VZX4N7M0RTYB6HD", title: "shelved", status: "archived" } as never),
    ]);
    assert.match(html, /Archived · 1/, "archiving has to visibly tidy or nobody uses it");
    assert.doesNotMatch(html, /shelved/, "and what was tidied away is not still in the list");
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
    runStartedAt: null,
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

/**
 * A wrap-up the coordinator would not do (#70 §11.3).
 *
 * This is the failure the feature could least afford, because it presented as nothing at all: the
 * screen left for the proposals on the press itself, the coordinator refused, and the person
 * arrived at an empty approvals list having been told nothing. A refused wrap-up writes nothing,
 * so the workspace that follows is identical to the one before and cannot carry the reason — the
 * event is the only thing that has it, and the path from it to the rail is what is worth pinning.
 */
describe("a wrap-up that was refused", () => {
  const CV = "cv_01J8F3K2QW9VZX4N7M0RTYB6HC";

  function render(): string {
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/chat/${CV}`]}>
        <App />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");
  }

  function openConversation(): void {
    __setStateForTest({
      ...FIXTURE_STATE,
      world: {
        ...FIXTURE_STATE.world!,
        conversations: [
          {
            id: CV as never,
            title: "The bells",
            status: "open",
            updatedAt: AT,
            pointCount: 1,
            openProposalCount: 0,
            notCarried: [],
          },
        ],
      },
      worldChat: {
        conversationId: CV,
        status: "open",
        messages: [],
        hasMore: false,
        seq: 1,
        points: [],
        attachments: [],
        runStatus: null,
        runStartedAt: null,
        retrievalUnavailable: false,
      } as never,
    });
  }

  it("says why, on the rail it was pressed from", () => {
    openConversation();
    __applyEventForTest({
      at: AT,
      type: "world-chat.wrap-up-refused",
      conversationId: CV,
      requestId: "req-1",
      reason: "stale",
      detail: "This conversation moved on while you were looking at it. Open it again and wrap up from there.",
    } as never);

    const html = render();
    assert.match(html, /fy-panel__refused/, "the reason has somewhere to be shown");
    assert.match(html, /moved on while you were looking at it/);
  });


  /*
   * The screen enters its waiting state on the strength of this, so a command that never left
   * must say so. Otherwise a press made a moment after the socket dropped starts a wait that
   * nothing can end: no conversation closes, no refusal arrives, and the button reads "Turning
   * this into proposals…" for the rest of the session — the same silence, one layer up.
   */
  it("says when the command could not be sent at all", () => {
    openConversation();
    __connectionStatusForTest("closed");
    try {
      assert.equal(wrapUpWorldChat(FIXTURE_WORLD_ID, CV, 1), null, "no attempt id, because no attempt");
    } finally {
      __connectionStatusForTest("open");
    }
  });

  it("keeps one conversation's refusal off another's rail", () => {
    openConversation();
    __applyEventForTest({
      at: AT,
      type: "world-chat.wrap-up-refused",
      conversationId: "cv_01J8F3K2QW9VZX4N7M0RTYB6HZ",
      reason: "nothing-to-carry",
      detail: "Nothing in this conversation is settled enough to propose yet.",
    } as never);

    assert.doesNotMatch(render(), /fy-panel__refused/, "a refusal belongs to the conversation it came from");
  });
});
