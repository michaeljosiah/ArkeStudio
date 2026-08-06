import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorldChatSummary } from "@arke-studio/contracts";
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
