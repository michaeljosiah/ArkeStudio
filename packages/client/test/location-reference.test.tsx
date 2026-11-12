import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  MAX_ACTIVE_LOCATION_VIEWS,
  type ClientState,
  type Job,
  type LocationView,
  type ReferenceKit,
  type Take,
} from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The location Reference tab (#243, design turn 57).
 *
 * The screen's job is to make three things visible that nothing else says out loud: panel order
 * is the establishing view then acceptance order, the sheet is assembled rather than generated,
 * and a name already taken is a replacement somebody has to agree to.
 */

const WORLD_ID = FIXTURE_STATE.world!.meta.worldId;

function view(n: number, name: string, acceptedAt: string): LocationView {
  return {
    id: `lv_0${n}`,
    name,
    file: `takes/tk_01J8F000000000000000000${n}/view.png`,
    sourceTakeId: `tk_01J8F000000000000000000${n}` as LocationView["sourceTakeId"],
    sheetVersion: 2,
    artDirectionVersion: 3,
    acceptedAt,
    status: "active",
  };
}

function kit(views: LocationView[], establishingViewId: string): ReferenceKit {
  return {
    sheetId: "the-vigil",
    tiles: [],
    locationViews: views,
    establishingViewId,
    compilations: [
      {
        file: "location-sheet-8f2c1d0a4b77.png",
        format: "location-sheet",
        sheetVersion: 2,
        tiles: views.map((v) => v.file),
        compiledAt: "2026-08-02T10:00:00Z",
        source: "local",
        accepted: true,
      },
    ],
  };
}

function candidate(name?: string): Take {
  return {
    id: "tk_01J8F000000000000000000C",
    coversShots: [],
    kind: "location-view",
    reference: { sheetId: "the-vigil" },
    provider: "openai",
    model: "gpt-image-2",
    provenance: { canonRevision: 42, sheets: { "the-vigil": 2 } },
    references: ["references/the-vigil/takes/tk_01J8F0000000000000000001/view.png"],
    params: name === undefined ? {} : { locationView: { name } },
    cost: { estimatedMicroUsd: 150000, actualMicroUsd: 150000 },
    dispatchedAt: "2026-08-03T09:00:00Z",
    completedAt: "2026-08-03T09:02:00Z",
    media: "view.png",
  };
}

function render(
  kits: ReferenceKit[],
  takes: Take[] = [],
  loose: { candidates?: string[]; jobs?: Job[] } = {},
): string {
  const world = FIXTURE_STATE.world!;
  const state: ClientState = {
    ...FIXTURE_STATE,
    app: { ...FIXTURE_STATE.app, jobs: loose.jobs ?? [] },
    world: {
      ...world,
      referenceKits: kits,
      referenceTakes: takes,
      referenceReviews: [],
      referenceCandidates: loose.candidates ? { "the-vigil": loose.candidates } : {},
    },
  };
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter initialEntries={[`/w/${WORLD_ID}/locations/the-vigil/reference`]}>
      <App />
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
}

describe("location candidate reference provenance (#2149)", () => {
  const anchor = "takes/tk_original/view.png";
  const anchorPath = `references/the-vigil/${anchor}`;
  const style = "artifacts/attached-style.png";
  const cases = [
    { name: "saved anchor actually carried", params: { provenance: { anchorFile: anchor } }, references: [style, anchorPath], note: "anchored to the establishing view" },
    { name: "style-only first view", params: {}, references: [style], note: "other references attached" },
    { name: "recorded anchor absent from carried files", params: { provenance: { anchorFile: anchor } }, references: [style], note: "other references attached" },
    { name: "legacy reference matching today's kit without saved anchor", params: {}, references: ["references/the-vigil/takes/tk_01J8F0000000000000000001/view.png"], note: "other references attached" },
    { name: "another location's same relative filename", params: { provenance: { anchorFile: anchor } }, references: [`references/other-place/${anchor}`], note: "other references attached" },
    { name: "no references", params: {}, references: [], note: "no references recorded" },
    { name: "saved anchor with no carried references", params: { provenance: { anchorFile: anchor } }, references: [], note: "no references recorded" },
    { name: "malformed legacy provenance", params: { provenance: { anchorFile: 42 } }, references: [style], note: "other references attached" },
  ];
  for (const source of ["take", "candidate"] as const) for (const row of cases) {
    it(`${source}: ${row.name}`, () => {
      const take = candidate("Side view");
      take.references = [...row.references];
      take.params = { ...row.params, locationView: { name: "Side view" } };
      const path = "references/the-vigil/candidates/loose.png";
      const job: Job = {
        id: "jb_01KZPR883W8B49PZTR1GE3F1S4", idempotencyKey: "01KZPR883W8B49PZTR1GE3F1S5", worldId: WORLD_ID,
        target: { kind: "location-view-candidate", id: "the-vigil/test/1" }, capability: "image", provider: "openai", model: "gpt-image-2",
        params: { ...take.params, references: [...row.references] }, estimatedMicroUsd: 53000, status: "succeeded", providerJobId: "image-fixture", attempt: 1,
        landedFiles: [path], finalization: { status: "complete", error: null, updatedAt: "2026-08-10T21:12:08Z" }, error: null,
        createdAt: "2026-08-10T21:11:27Z", updatedAt: "2026-08-10T21:12:08Z",
      };
      const before = JSON.stringify({ take, job });
      // Neither removal nor replacement of the current establishing view changes history.
      for (const currentKits of [[], [kit([view(1, "Current establishing view", "2026-08-12T10:00:00Z")], "lv_01")]]) {
        const html = source === "take" ? render(currentKits, [take]) : render(currentKits, [], { candidates: [path], jobs: [job] });
        const document = parseHTML(html).document;
        assert.equal(document.querySelector(".fy-locref__candidate > p")?.textContent, `gpt-image-2 · ${row.note}`);
        assert.ok(document.querySelector(".fy-locref__namefield input"), "the existing naming/acceptance composition remains");
      }
      assert.equal(JSON.stringify({ take, job }), before, "projection does not rewrite saved provenance");
    });
  }
});

describe("the location reference tab (#243)", () => {
  it("orders panels by the establishing view first, then acceptance — never by name or date alone", () => {
    // Deliberately adversarial: alphabetically "Day" leads, and by acceptance date the
    // establishing view is last. Panel 1 must still be the establishing view.
    const establishing = view(1, "Establishing view", "2026-08-05T10:00:00Z");
    const reverse = view(2, "Reverse angle", "2026-08-02T10:00:00Z");
    const day = view(3, "Day", "2026-08-03T10:00:00Z");
    const html = render([kit([day, reverse, establishing], "lv_01")]);

    const panels = [...html.matchAll(/PANEL (\d\d)<\/span>.*?<h3[^>]*>([^<]+)<\/h3>/gs)].map((m) => [m[1], m[2]]);
    assert.deepEqual(panels, [
      ["01", "Establishing view"],
      ["02", "Reverse angle"],
      ["03", "Day"],
    ]);
    assert.ok(html.includes("3 of 6"), "the ceiling is stated before it is reached");
    const document = parseHTML(html).document;
    const cards = [...document.querySelectorAll(".fy-locref__gallery > article")];
    assert.equal(cards.length, 3);
    assert.deepEqual(cards.filter((card) => card.classList.contains("fy-locref__view--establishing")).map((card) => card.querySelector("h3")?.textContent), ["Establishing view"], "the chosen anchor owns the prominent card, even when it was accepted last");
    assert.match(cards[0]!.textContent, /Replace/);
    assert.ok(cards.slice(1).every((card) => !card.textContent.includes("Replace")), "secondary views keep their existing actions");
    assert.deepEqual(cards.map((card) => card.querySelector(".fy-locref__zoom")?.getAttribute("aria-label")), ["View larger: Establishing view", "View larger: Reverse angle", "View larger: Day"], "every card keeps the accessible source-image review action");
  });

  it("states the panel map a shot will carry, in the panel order it just showed", () => {
    const html = render([
      kit(
        [
          view(1, "Establishing view", "2026-08-01T10:00:00Z"),
          view(2, "Reverse angle", "2026-08-02T10:00:00Z"),
          view(3, "Night", "2026-08-03T10:00:00Z"),
        ],
        "lv_01",
      ),
    ]);
    assert.ok(html.includes("WHAT A SHOT CARRIES"));
    // Composed by the same function the binding preamble uses, so the promise on this screen and
    // the sentence in the request cannot drift into disagreeing.
    assert.ok(
      html.includes(
        "location sheet: panel 1 (top), Establishing view; panel 2, Reverse angle; panel 3 (bottom), Night",
      ),
      `panel map missing or out of order:\n${html.slice(html.indexOf("WHAT A SHOT CARRIES"), html.indexOf("WHAT A SHOT CARRIES") + 400)}`,
    );
    assert.ok(html.includes("assembled here, not generated"));
  });

  it("offers no way to generate the sheet — only the views it is made of", () => {
    const html = render([kit([view(1, "Establishing view", "2026-08-01T10:00:00Z")], "lv_01")]);
    const pane = html.slice(html.indexOf("Location sheet"));
    assert.ok(!/>\s*(Generate|Regenerate)\s*</.test(pane), "the sheet pane must carry no generate control");
    assert.equal(html.includes("rebuilt on every acceptance"), false, "the file name alone (turn 137)");
  });

  it("holds a candidate for a name before it will accept it", () => {
    const html = render([kit([view(1, "Establishing view", "2026-08-01T10:00:00Z")], "lv_01")], [candidate()]);
    assert.ok(html.includes("A view is waiting on you"));
    assert.ok(html.includes("UNREVIEWED"));
    assert.ok(html.includes("Name this view"));
    // Unnamed, Accept is refused: a view with no name has no panel label and no way to be
    // replaced later by the one that supersedes it.
    const accept = html.slice(html.indexOf("Name this view"));
    assert.match(accept, /<button[^>]*disabled[^>]*>Accept</, "Accept waits on the name");
    assert.ok(html.includes("the take is kept either way"), "rejecting is stated as reversible");
  });

  it("asks before it supersedes a name already taken, folding case and spacing the way the write does", () => {
    // "  reverse   ANGLE " is the same name as "Reverse angle" to the contract. If the screen
    // disagreed, the user would press Accept and watch the write refuse for a reason nothing
    // on screen had mentioned.
    const html = render(
      [
        kit(
          [view(1, "Establishing view", "2026-08-01T10:00:00Z"), view(2, "Reverse angle", "2026-08-02T10:00:00Z")],
          "lv_01",
        ),
      ],
      [candidate("  reverse   ANGLE ")],
    );
    // Specifically the collision copy — panel 1 carries its own Replace, and matching that
    // instead would let this test pass with the confirmation gone entirely.
    assert.ok(html.includes("Replace “reverse   ANGLE”?"), "the collision is named before the press, not after");
    assert.ok(html.includes(">Replace it<"));
    assert.ok(html.includes('title="The old view becomes superseded and keeps its place in history."'), "what replacing does rides on the control (turn 137)");
    assert.equal(html.includes("leaves the panel order unchanged"), false, "and the card no longer explains it");
    const pending = html.slice(html.indexOf("A view is waiting on you"));
    assert.match(pending, /<button[^>]*disabled[^>]*>Accept</, "and Accept waits on the confirmation");
  });

  it("refuses a seventh view before it is generated rather than after it is paid for", () => {
    const views = Array.from({ length: MAX_ACTIVE_LOCATION_VIEWS }, (_, i) =>
      view(i + 1, i === 0 ? "Establishing view" : `Angle ${i}`, `2026-08-0${i + 1}T10:00:00Z`),
    );
    const html = render([kit(views, "lv_01")]);
    assert.ok(html.includes(`${MAX_ACTIVE_LOCATION_VIEWS} of ${MAX_ACTIVE_LOCATION_VIEWS}`));
    assert.ok(html.includes("stops being read as one room"));
    const add = html.slice(html.indexOf("stops being read as one room"));
    assert.match(add, /<button[^>]*disabled[^>]*>Add a view</, "the door is shut, not merely warned about");
  });

  it("offers to promote a candidate to panel 1, and offers it only when there is a panel 1 to displace", () => {
    const withViews = render(
      [kit([view(1, "Establishing view", "2026-08-01T10:00:00Z")], "lv_01")],
      [candidate("Reverse angle")],
    );
    assert.ok(
      withViews.includes("Make this the establishing view"),
      "a later view can take panel 1 — otherwise the anchor is whatever was accepted first, forever",
    );
    // Panel 1 also carries the control the design turn shows, and it is the one generation that
    // is deliberately unanchored.
    assert.match(withViews, /Establishing view<\/h3>[\s\S]{0,300}>Replace</, "panel 1 offers Replace");

    // With nothing accepted, there is no choice to offer: the first view *is* the establishing
    // view, and a checkbox that can only be checked is a decision pretending to be one.
    const empty = render([], [candidate("Establishing view")]);
    assert.ok(!empty.includes("Make this the establishing view"));
    assert.ok(!empty.includes(">Replace<"));
  });

  it("shows the establishing view on the location's card and its detail hero, not a file it never had", () => {
    // sheetPortraitPath names `references/<id>/head-front.png` — a character's front tile, which
    // a location has never had and never will. Both surfaces rendered the placeholder forever.
    const establishing = view(1, "Establishing view", "2026-08-01T10:00:00Z");
    const world = FIXTURE_STATE.world!;
    const state: ClientState = {
      ...FIXTURE_STATE,
      world: { ...world, referenceKits: [kit([establishing, view(2, "Reverse angle", "2026-08-02T10:00:00Z")], "lv_01")] },
    };
    __setStateForTest(state);
    const at = (path: string) =>
      renderToString(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      ).replace(/<!-- -->/g, "");

    for (const [where, path] of [
      ["the locations list", `/w/${WORLD_ID}/locations`],
      ["the detail hero", `/w/${WORLD_ID}/locations/the-vigil`],
    ] as const) {
      const html = at(path);
      assert.ok(html.includes(establishing.file), `${where} should show the establishing view`);
      assert.ok(!html.includes("the-vigil/head-front.png"), `${where} must not reach for a character's front tile`);
    }
  });

  /**
   * Issue 274. A generated view lands in `candidates/` and becomes a take when its job
   * finalizes; v0.5.0 finalized without recording one and reported complete, so the picture was
   * on disk, paid for, and invisible to a screen that only ever read takes.
   */
  describe("a candidate whose take was never recorded", () => {
    const CANDIDATE = "references/the-vigil/candidates/location-view-msnq84u3-1.png";
    const strandedJob = (over: Partial<Job> = {}): Job => ({
      id: "jb_01KZPR883W8B49PZTR1GE3F1S4",
      idempotencyKey: "01KZPR883W8B49PZTR1GE3F1S5",
      worldId: WORLD_ID,
      target: { kind: "location-view-candidate", id: "the-vigil/msnq84u3/1" },
      capability: "image",
      provider: "openai",
      model: "gpt-image-2",
      params: { references: [], locationView: { name: "Establishing view" } },
      estimatedMicroUsd: 53000,
      status: "succeeded",
      providerJobId: "img-msnq84u3",
      attempt: 1,
      landedFiles: [CANDIDATE],
      finalization: { status: "complete", error: null, updatedAt: "2026-08-10T21:12:08.834Z" },
      error: null,
      createdAt: "2026-08-10T21:11:27.100Z",
      updatedAt: "2026-08-10T21:12:08.834Z",
      ...over,
    });

    it("waits on a name beside the takes, under the name its generation asked for", () => {
      const html = render([], [], { candidates: [CANDIDATE], jobs: [strandedJob()] });
      assert.ok(html.includes("A view is waiting on you"));
      assert.ok(html.includes(CANDIDATE), "the bytes on disk are what is shown");
      assert.ok(html.includes("gpt-image-2"), "and it says what made them");
      assert.match(html, /value="Establishing view"/, "the name the generation asked for opens the field");
      // Nothing distinguishes it from a take-backed candidate: accepting is what records the
      // take, so the recovery never has to be explained.
      assert.ok(html.includes("UNREVIEWED"));
      // Rejecting is a decision recorded against a take, and there is no take to record it on.
      const waiting = html.slice(html.indexOf("A view is waiting on you"));
      assert.ok(!waiting.includes(">Reject<"), "no reject where there is nothing to record it against");
    });

    it("shows nothing for a candidate no succeeded job landed — an Accept that could only refuse", () => {
      const orphan = render([], [], { candidates: [CANDIDATE] });
      assert.ok(!orphan.includes("A view is waiting on you"));

      // Nor while its finalization is still running: that is a take about to exist.
      const inflight = render([], [], {
        candidates: [CANDIDATE],
        jobs: [strandedJob({ finalization: { status: "pending", error: null, updatedAt: "2026-08-10T21:12:08.834Z" } })],
      });
      assert.ok(!inflight.includes("A view is waiting on you"));
    });

    it("drops out the moment a take owns the same job, rather than offering it twice", () => {
      const take = { ...candidate("Establishing view"), jobId: strandedJob().id as Take["jobId"] };
      const html = render([], [take], { candidates: [CANDIDATE], jobs: [strandedJob()] });
      assert.ok(!html.includes(CANDIDATE), "the loose copy is the take's own source, not a second candidate");
      assert.equal(html.match(/UNREVIEWED/g)?.length, 1);
    });
  });

  it("keeps only the creation controls when no view exists (master turn 192)", () => {
    const html = render([]);
    assert.ok(!html.includes("Start with the establishing view"));
    assert.ok(!html.includes("0 of 6"));
    assert.ok(!html.includes("Accepted views"));
    assert.match(html, />Generate<\/button>/);
    assert.match(html, />Upload<\/button>/);
    assert.ok(!html.includes("so the model sees the room from more than one side"), "instruction captions stay off the surface (#1093)");
    assert.ok(!html.includes("WHAT A SHOT CARRIES"), "nothing is carried yet, so nothing is promised");
  });

  it("keeps the first candidate and its naming and decisions without an empty accepted section", () => {
    const html = render([], [candidate("Harbour approach")]);
    assert.ok(!html.includes("Accepted views"));
    assert.ok(!html.includes("0 of 6"));
    assert.ok(html.includes("A view is waiting on you"));
    assert.match(html, /value="Harbour approach"/);
    assert.match(html, />Accept<\/button>/);
    assert.match(html, />Reject<\/button>/);
  });
});
