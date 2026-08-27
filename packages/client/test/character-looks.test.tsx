import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState, ReviewDecision, Take } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { lookAttachmentLabel, lookGallery, RECENT_LOOKS } from "../src/screens/character-reference.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The looks gallery against real volume (SPEC-017 D14). Eight unpromoted takes cost money
 * eight times, so all eight stay reachable: the newest five lead, the older ones are one
 * press away, and the new-variations notice is a control rather than an announcement.
 * (Before this, the grid was `slice(-5)`: takes older than the newest five existed on disk,
 * still unpromoted, with no way to ever see them again.)
 */

/** A completed, unreviewed look take; `n` staggers the id and the completion minute together. */
function lookTake(n: number, overrides: Partial<Take> = {}): Take {
  const nn = String(n).padStart(2, "0");
  return {
    id: `tk_01J8F0000000000000000000${nn}`,
    coversShots: [],
    kind: "look",
    reference: { sheetId: "maren-kest" },
    provider: "fal",
    model: "flux-pro-1.1",
    provenance: { canonRevision: 42, sheets: { "maren-kest": 4 } },
    prompt: `Painterly, tidal, restrained. Maren Kest — tide-caller. Look ${n}.`,
    references: ["references/maren-kest/head-front.png"],
    params: { lookPrompt: `Look ${n}`, lookKind: "costume" },
    cost: { estimatedMicroUsd: 40000, actualMicroUsd: null },
    dispatchedAt: `2026-08-01T09:${nn}:00Z`,
    completedAt: `2026-08-01T10:${nn}:00Z`,
    media: "look.png",
    ...overrides,
  };
}

function stateWith(takes: Take[], reviews: ReviewDecision[] = []): ClientState {
  const world = FIXTURE_STATE.world!;
  return { ...FIXTURE_STATE, world: { ...world, referenceTakes: takes, referenceReviews: reviews } };
}

function renderLooks(): string {
  return renderToString(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_STATE.world!.meta.worldId}/cast/maren-kest/looks`]}>
      <App />
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
}

/** Same guard as the navigation test: a control inside a control never survives hydration. */
function nestedButtons(html: string): string[] {
  const found: string[] = [];
  const open: number[] = [];
  const tags = /<button\b|<\/button>/g;
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(html)) !== null) {
    if (tag[0] === "</button>") open.pop();
    else {
      if (open.length > 0) found.push(html.slice(open[0]!, open[0]! + 90));
      open.push(tag.index);
    }
  }
  return found;
}

describe("the looks read model", () => {
  const kit = FIXTURE_STATE.world!.referenceKits[0]!;

  it("returns every unpromoted take, newest first — none is dropped", () => {
    const takes = [3, 7, 1, 8, 5, 2, 6, 4].map((n) => lookTake(n));
    const gallery = lookGallery(kit, takes, [], "maren-kest");
    assert.equal(gallery.length, 8, "eight takes cost money eight times; all eight are here");
    assert.deepEqual(
      gallery.map((entry) => entry.take?.completedAt),
      [8, 7, 6, 5, 4, 3, 2, 1].map((n) => `2026-08-01T10:0${n}:00Z`),
    );
    assert.equal(gallery[0]!.path, `references/maren-kest/takes/${lookTake(8).id}/look.png`);
  });

  it("excludes reviewed takes, other sheets, and other kinds", () => {
    const reviewed = lookTake(1);
    const otherSheet = lookTake(2, { reference: { sheetId: "the-vigil" } });
    const otherKind = lookTake(3, { kind: "main-photo" });
    const kept = lookTake(4);
    const reviews: ReviewDecision[] = [
      { ts: "2026-08-01T11:00:00Z", takeId: reviewed.id, decision: "accept", by: "user" },
    ];
    const gallery = lookGallery(kit, [reviewed, otherSheet, otherKind, kept], reviews, "maren-kest");
    assert.deepEqual(
      gallery.map((entry) => entry.take?.id),
      [kept.id],
    );
  });

  it("interleaves promoted looks with pending takes by recency", () => {
    const promotedKit = {
      ...kit,
      looks: [
        {
          id: "council-coat",
          file: "looks/council-coat.png",
          kind: "costume" as const,
          prompt: "Formal Ebb Council coat",
          acceptedAt: "2026-08-01T10:05:30Z",
        },
      ],
    };
    const gallery = lookGallery(promotedKit, [lookTake(5), lookTake(6)], [], "maren-kest");
    assert.deepEqual(
      gallery.map((entry) => entry.label),
      ["Look 6", "Formal Ebb Council coat", "Look 5"],
    );
    assert.equal(gallery[1]!.path, "references/maren-kest/looks/council-coat.png");
  });

  it("captions with the user's own words, truncated, falling back to the kind", () => {
    const long = lookTake(1, { params: { lookPrompt: "x".repeat(80), lookKind: "costume" } });
    const kindOnly = lookTake(2, { params: { lookKind: "condition-age" }, prompt: undefined });
    const bare = lookTake(3, { params: {}, prompt: undefined });
    const gallery = lookGallery(kit, [long, kindOnly, bare], [], "maren-kest");
    const labels = new Map(gallery.map((entry) => [entry.take!.id, entry.label]));
    assert.match(labels.get(long.id)!, /^x{47}…$/, "the composed dispatch prompt never floods the pill");
    assert.equal(labels.get(kindOnly.id), "Condition / age");
    assert.equal(labels.get(bare.id), "Exploration");
  });
});

describe("where a look is in use", () => {
  const productions = [
    {
      meta: { id: "saltlight", title: "Saltlight" },
      scenes: [{ id: "sc_04", number: 4 }],
    },
  ];
  const look = {
    id: "council-coat",
    file: "looks/council-coat.png",
    kind: "costume" as const,
    prompt: "Formal Ebb Council coat",
    acceptedAt: "2026-08-01T10:05:30Z",
  };

  it("names the production, or the production and the scene", () => {
    assert.equal(
      lookAttachmentLabel({ ...look, attachedTo: { kind: "production", productionId: "saltlight" } }, productions),
      "Saltlight",
    );
    assert.equal(
      lookAttachmentLabel(
        { ...look, attachedTo: { kind: "scene", productionId: "saltlight", sceneId: "sc_04" } },
        productions,
      ),
      "Saltlight · Sc 4",
    );
  });

  it("says nothing for an unattached look, a pending take, or a production since deleted", () => {
    assert.equal(lookAttachmentLabel(look, productions), null);
    assert.equal(lookAttachmentLabel(undefined, productions), null);
    assert.equal(
      lookAttachmentLabel({ ...look, attachedTo: { kind: "production", productionId: "gone" } }, productions),
      null,
      "a stale attachment is not a label naming nothing",
    );
  });

  /* A deleted scene leaves the attachment behind it, and `attachmentFor` wants the exact scene
     id — so the look rides nowhere. Naming the production said the opposite, in the very words a
     production-wide attachment uses (codex round 3). */
  it("says nothing of a scene that is gone, rather than claiming the whole production", () => {
    assert.equal(
      lookAttachmentLabel(
        { ...look, attachedTo: { kind: "scene", productionId: "saltlight", sceneId: "sc_99" } },
        productions,
      ),
      null,
    );
  });
});

describe("the looks gallery route", () => {
  it("leads with the five newest and keeps the older ones one press away", () => {
    __setStateForTest(stateWith([1, 2, 3, 4, 5, 6, 7, 8].map((n) => lookTake(n))));
    try {
      const html = renderLooks();
      for (const n of [4, 5, 6, 7, 8]) {
        assert.ok(html.includes(lookTake(n).id), `take ${n} is on screen`);
      }
      for (const n of [1, 2, 3]) {
        assert.ok(!html.includes(lookTake(n).id), `take ${n} waits behind the toggle, not beyond reach`);
      }
      assert.match(html, /<button[^>]*fy-looks-results__older[^>]*>Show 3 older looks<\/button>/);
      assert.match(html, /<button[^>]*fy-looks-results__fresh[^>]*>8 new variations ready<\/button>/);
      assert.ok(html.includes("Look 8"), "tiles carry the takes' own words");
      assert.ok(!html.includes("Calling the tide"), "not the sample copy the design canvas used");
      assert.equal(nestedButtons(html).length, 0, "the toggle is a sibling of the grid, never inside a tile");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("offers no toggle at five or fewer, and counts the singular", () => {
    __setStateForTest(stateWith([1, 2, 3, 4, 5].map((n) => lookTake(n))));
    try {
      const html = renderLooks();
      for (const n of [1, 2, 3, 4, 5]) assert.ok(html.includes(lookTake(n).id));
      assert.ok(!html.includes("older look"), "nothing is hidden, so nothing offers to unhide");
      assert.ok(html.includes("5 new variations ready"));
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }

    __setStateForTest(stateWith(Array.from({ length: RECENT_LOOKS + 1 }, (_, i) => lookTake(i + 1))));
    try {
      assert.match(renderLooks(), /Show 1 older look</, "one hidden take is a look, not looks");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("keeps the quiet D14 line when nothing is pending", () => {
    __setStateForTest(FIXTURE_STATE);
    const html = renderLooks();
    assert.ok(html.includes("Looks never carry by default"));
    assert.ok(!html.includes("fy-looks-results__fresh"), "no notice without something to notice");
  });

  /* An attachment is what a look is *for*, and it used to be readable only by selecting the
     tile and opening the control that sets it — so the gallery showed no difference between a
     look riding a production and one riding nothing. */
  it("marks an attached tile with where it is used, without selecting it", () => {
    const world = FIXTURE_STATE.world!;
    const attached = {
      ...world,
      referenceKits: world.referenceKits.map((candidate) =>
        candidate.sheetId === "maren-kest"
          ? {
              ...candidate,
              looks: [
                {
                  id: "council-coat",
                  file: "looks/council-coat.png",
                  kind: "costume" as const,
                  prompt: "Formal Ebb Council coat",
                  acceptedAt: "2026-08-01T10:05:30Z",
                  attachedTo: { kind: "scene" as const, productionId: "saltlight", sceneId: "sc_04" },
                },
              ],
            }
          : candidate,
      ),
    };
    __setStateForTest({ ...FIXTURE_STATE, world: attached });
    try {
      const html = renderLooks();
      assert.match(html, /fy-looks-results__inuse[^>]*>Saltlight · Sc 4</);
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });
});
