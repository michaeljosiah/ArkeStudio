import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pendingSheets, type StagedProposal } from "@arke-studio/contracts";

/**
 * Which sheets are on their way (issue 228).
 *
 * Between "Draft the sheet" and the sheet arriving, it lives in `.proposals/` and not in
 * `world.sheets` — for seconds to minutes, because an agent writes it. Every list reads
 * `world.sheets`, so every list showed its *empty state*: a submitted action looked like a
 * failed one, and the obvious response was to submit it again and draft it twice.
 */

const PROPOSAL_ID = "pr_01J8E0000000000000000000P1";

function staged(over: {
  id?: string;
  kind?: StagedProposal["proposal"]["kind"];
  summary?: string;
  paths?: string[];
  review?: StagedProposal["review"];
}): StagedProposal {
  return {
    proposal: {
      id: (over.id ?? PROPOSAL_ID) as StagedProposal["proposal"]["id"],
      kind: over.kind ?? "new-sheet",
      summary: over.summary ?? "New location: The Bell Market",
      targets: (over.paths ?? ["locations/the-bell-market.md"]).map((path) => ({
        path,
        baseVersion: null,
        baseHash: null,
      })),
      baseCanonRevision: 42,
      reservedCanonIds: [],
      source: "chat:studio",
      created: "2026-08-09T12:00:00.000Z",
      draftRevision: 1,
    },
    ripple: null,
    ...(over.review ? { review: over.review } : {}),
  } as StagedProposal;
}

const review = (path: string, label: string, action: "create" | "amend" = "create"): StagedProposal["review"] => ({
  targets: [{ path, label, kind: "new location sheet", action, fields: [] }],
});

describe("sheets that have been asked for and have not arrived (issue 228)", () => {
  it("finds the pending sheet of a kind, named as the staged file names it", () => {
    const pending = pendingSheets([staged({ review: review("locations/the-bell-market.md", "The Bell Market") })], "location");
    assert.deepEqual(pending, [
      { proposalId: PROPOSAL_ID, name: "The Bell Market", path: "locations/the-bell-market.md" },
    ]);
  });

  it("sorts a sheet into its own list by the path it will occupy, not by the summary", () => {
    // The summary is display copy. The path is what decides which list the sheet lands in.
    const proposals = [
      staged({ id: "pr_01J8E0000000000000000000P2", paths: ["characters/timi-j.md"], summary: "New character: Timi J" }),
      staged({ id: "pr_01J8E0000000000000000000P3", paths: ["locations/ojuelegba.md"], summary: "New location: Ojuelegba" }),
      staged({ id: "pr_01J8E0000000000000000000P4", paths: ["factions/the-ebb-council.md"], summary: "New faction: The Ebb Council" }),
    ];
    assert.deepEqual(pendingSheets(proposals, "character").map((p) => p.path), ["characters/timi-j.md"]);
    assert.deepEqual(pendingSheets(proposals, "location").map((p) => p.path), ["locations/ojuelegba.md"]);
    assert.deepEqual(pendingSheets(proposals, "faction").map((p) => p.path), ["factions/the-ebb-council.md"]);
  });

  it("counts nothing that is not a sheet arriving", () => {
    for (const kind of ["sheet-edit", "new-canon", "art-direction", "scene-draft"] as const) {
      const proposals = [staged({ kind, paths: ["locations/the-bell-market.md"] })];
      assert.deepEqual(pendingSheets(proposals, "location"), [], `${kind} is not a sheet arriving`);
    }
  });

  it("skips an amend that rides along on a new-sheet proposal", () => {
    // A ripple onto an existing sheet is already in the list under its own name; drawing a
    // second, drafting-looking card for it would double it.
    const proposals = [
      staged({
        paths: ["locations/the-bell-market.md", "locations/the-vigil.md"],
        review: {
          targets: [
            { path: "locations/the-bell-market.md", label: "The Bell Market", kind: "new location sheet", action: "create", fields: [] },
            { path: "locations/the-vigil.md", label: "The Vigil", kind: "location sheet · v4", action: "amend", fields: [] },
          ],
        },
      }),
    ];
    assert.deepEqual(pendingSheets(proposals, "location").map((p) => p.name), ["The Bell Market"]);
  });

  it("counts a sheet a World Chat wrap-up created, which is not a new-sheet proposal", () => {
    // wrapUpConversation stages every candidate — sheet.create included — as `worldbuilding`.
    // Dropping those left the exact failure this whole change is about: wrap up a conversation
    // that invents a character and the hub still says both "1 awaiting you" and "no one lives
    // here yet".
    const pending = pendingSheets(
      [
        staged({
          kind: "worldbuilding",
          summary: "The market that keeps the tide's hours",
          paths: ["locations/the-bell-market.md"],
          review: review("locations/the-bell-market.md", "The Bell Market"),
        }),
      ],
      "location",
    );
    assert.deepEqual(pending.map((p) => p.name), ["The Bell Market"]);
  });

  it("takes only the creations out of a wrap-up that also amends", () => {
    // One conversation stages several changes together. The amended sheet is already in the
    // list under its own name, and a drafting card for it would be that sheet twice.
    const pending = pendingSheets(
      [
        staged({
          kind: "worldbuilding",
          paths: ["locations/the-bell-market.md", "locations/the-vigil.md"],
          review: {
            targets: [
              { path: "locations/the-bell-market.md", label: "The Bell Market", kind: "new location sheet", action: "create", fields: [] },
              { path: "locations/the-vigil.md", label: "The Vigil", kind: "location sheet · v4", action: "amend", fields: [] },
            ],
          },
        }),
      ],
      "location",
    );
    assert.deepEqual(pending.map((p) => p.name), ["The Bell Market"]);
  });

  it("declines to guess when a wrap-up target has no review to say create or amend", () => {
    // A `new-sheet` is a creation by definition, so it counts without one. A `worldbuilding`
    // target could be either, and inventing a drafting card for an edit would double a sheet
    // that is already on the screen.
    const unreviewed = (kind: StagedProposal["proposal"]["kind"]) =>
      pendingSheets([staged({ kind, paths: ["locations/the-bell-market.md"] })], "location").length;
    assert.equal(unreviewed("new-sheet"), 1);
    assert.equal(unreviewed("worldbuilding"), 0);
  });

  it("still shows a row when the review could not be computed", () => {
    // A staged file that will not parse produces no review. That is exactly when someone most
    // needs to see that something is there, so the name degrades rather than the row vanishing.
    const fromSummary = pendingSheets([staged({ summary: "New location: The Bell Market" })], "location");
    assert.deepEqual(fromSummary.map((p) => p.name), ["The Bell Market"]);
    const fromSlug = pendingSheets([staged({ summary: "drafted from a conversation" })], "location");
    assert.deepEqual(fromSlug.map((p) => p.name), ["the bell market"]);
  });

  it("keeps every pending sheet, so four seeded at once are four rows", () => {
    // Beginning a world seeds up to four characters and four locations in one go.
    const proposals = ["a", "b", "c", "d"].map((n, i) =>
      staged({ id: `pr_01J8E000000000000000000${i}Q` , paths: [`characters/${n}.md`], summary: `New character: ${n}` }),
    );
    assert.equal(pendingSheets(proposals, "character").length, 4);
  });
});
