import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newId, type WorldChatRun, type WorldChatStoredEvent } from "@arke-studio/contracts";
import { foldConversation } from "../../src/world-chat/fold.js";
import { projectWorkspace } from "../../src/world-chat/project.js";

/**
 * A turn that failed has to be visible (#70 §10.1.1).
 *
 * This was reported from the packaged app as "nothing seems to happen". The message was sent, a
 * run started, the studio was asked, and two minutes later the run finished as `timeout` — and
 * the screen showed exactly what it had shown before: the message, and no reply. There was no
 * error, no notice, nothing to press.
 *
 * The cause was that `runStatus` is read from the *active* run, and a run stops being active the
 * instant it fails. So the one moment the person most needs to be told something is the moment
 * the app has nothing left to tell them with. Silence then reads as "this feature does nothing".
 *
 * The rule: if a turn ended without an answer, the workspace says so, and says which turn, so it
 * can be offered again.
 */

const AT = "2026-08-06T09:00:00Z";
const LATER = "2026-08-06T09:02:00Z";
const CV = newId("cv");

function run(
  turnId: string,
  status: WorldChatRun["status"],
  overrides: Partial<WorldChatRun> = {},
): WorldChatRun {
  return {
    id: newId("run"),
    turnId,
    basedOnConversationSeq: 0,
    status,
    adapter: "opencode",
    harnessCleanup: "not-required",
    contextDigest: `sha256:${"a".repeat(64)}`,
    startedAt: AT,
    endedAt: LATER,
    ...overrides,
  } as WorldChatRun;
}

/** A turn that was asked and never answered, ending in `status`. */
function unanswered(
  status: WorldChatRun["status"],
  safeDetail?: string,
): { events: WorldChatStoredEvent[]; turnId: string } {
  const turnId = newId("turn");
  const started = run(turnId, "running", { endedAt: undefined });
  return {
    turnId,
    events: [
      {
        type: "turn.started",
        message: {
          id: newId("msg"),
          turnId,
          role: "user",
          text: "the bells",
          attachmentIds: [],
          createdAt: AT,
        },
        run: started,
      },
      {
        type: "run.finished",
        run: { ...started, status, endedAt: LATER, ...(safeDetail ? { safeDetail } : {}) },
      },
    ] as WorldChatStoredEvent[],
  };
}

function project(events: WorldChatStoredEvent[]) {
  const { view } = foldConversation(
    CV,
    AT,
    events.map(
      (event, i) => ({ schemaVersion: 1, seq: i + 1, eventId: newId("wce"), at: AT, event }) as never,
    ),
  );
  return { view, context: projectWorkspace(view, new Map()) };
}

describe("a turn that ended without an answer", () => {
  for (const status of ["timeout", "failed", "budget-exceeded"] as const) {
    it(`is carried to the screen when it ${status}`, () => {
      const { events, turnId } = unanswered(status, "the studio took too long to answer");
      const { view, context } = project(events);

      assert.equal(view.activeRun, null, "it is not active — which is exactly why it needed carrying");
      assert.ok(view.lastFailedRun, "the fold keeps it");
      assert.equal(context.lastFailure?.status, status);
      assert.equal(context.lastFailure?.turnId, turnId, "named, so it can be offered again");
    });
  }

  it("says nothing when the person cancelled it themselves", () => {
    // They pressed stop. Telling them their turn did not finish would be the app explaining
    // their own decision back to them.
    const { events } = unanswered("cancelled");
    assert.equal(project(events).context.lastFailure, undefined);
  });

  it("says nothing about a failure a later turn already answered", () => {
    const { events } = unanswered("timeout");
    const laterTurn = newId("turn");
    const answered = [
      ...events,
      {
        type: "turn.completed",
        message: {
          id: newId("msg"),
          turnId: laterTurn,
          role: "studio",
          text: "Noted.",
          attachmentIds: [],
          createdAt: LATER,
        },
        run: run(laterTurn, "completed"),
        receipts: [],
        candidates: [],
        groups: [],
        tombstones: [],
      },
    ] as WorldChatStoredEvent[];

    assert.equal(
      project(answered).context.lastFailure,
      undefined,
      "an older failure is history, not the state",
    );
  });

  it("says nothing about a turn its own retry answered", () => {
    const { events, turnId } = unanswered("timeout");
    const retried = [
      ...events,
      {
        type: "turn.completed",
        message: {
          id: newId("msg"),
          turnId,
          role: "studio",
          text: "Noted.",
          attachmentIds: [],
          createdAt: LATER,
        },
        run: run(turnId, "completed"),
        receipts: [],
        candidates: [],
        groups: [],
        tombstones: [],
      },
    ] as WorldChatStoredEvent[];

    assert.equal(project(retried).context.lastFailure, undefined, "the retry is the answer");
  });

  it("leaves an unfinished run to the active-run path, rather than reporting it twice", () => {
    // A run still marked running in the log means the process died mid-turn, so the fold calls
    // it interrupted and the restart repair owns it. It is still the *active* run, so it already
    // has somewhere to be shown; adding a failure notice beside it would say the same thing
    // twice in two different voices.
    const turnId = newId("turn");
    const events = [
      {
        type: "turn.started",
        message: {
          id: newId("msg"),
          turnId,
          role: "user",
          text: "the bells",
          attachmentIds: [],
          createdAt: AT,
        },
        run: run(turnId, "running", { endedAt: undefined }),
      },
    ] as WorldChatStoredEvent[];

    const { view, context } = project(events);
    assert.equal(context.runStatus, "interrupted");
    assert.ok(view.activeRun, "carried as the active run");
    assert.equal(context.lastFailure, undefined, "and not also as a failure");
  });

  /**
   * The other half of "nothing seems to happen", reported from the packaged build.
   *
   * A failed turn was made visible; a turn *in flight* still was not. On disk a live run and one
   * abandoned by a crash are the same record — a start with no terminal event — so the fold calls
   * both interrupted and `runStatus` was never once `running`. The screen therefore never said
   * the studio was thinking, never disabled Send, and never offered Stop, for the whole two
   * minutes somebody sat waiting. Only the runner knows the difference, so it has to say.
   */
  it("says a turn is running while it actually is", () => {
    const turnId = newId("turn");
    const events = [
      {
        type: "turn.started",
        message: {
          id: newId("msg"),
          turnId,
          role: "user",
          text: "the bells",
          attachmentIds: [],
          createdAt: AT,
        },
        run: run(turnId, "running", { endedAt: undefined }),
      },
    ] as WorldChatStoredEvent[];

    const { view } = foldConversation(
      CV,
      AT,
      events.map(
        (event, i) => ({ schemaVersion: 1, seq: i + 1, eventId: newId("wce"), at: AT, event }) as never,
      ),
    );

    assert.equal(
      projectWorkspace(view, new Map(), { liveRun: true }).runStatus,
      "running",
      "the log cannot tell live from crashed; the runner can, and it wins",
    );
    assert.equal(
      projectWorkspace(view, new Map(), { liveRun: false }).runStatus,
      "interrupted",
      "and with no live run it is still the crash reading, which the restart repair owns",
    );
  });

  it("carries no world or message content in the detail it shows", () => {
    const { events } = unanswered("failed", "the studio took too long to answer");
    const { context } = project(events);
    assert.ok(
      !JSON.stringify(context.lastFailure).includes("the bells"),
      "a failure notice is not a transcript",
    );
  });
});
