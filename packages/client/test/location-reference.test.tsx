import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { MAX_ACTIVE_LOCATION_VIEWS, type ClientState, type LocationView, type ReferenceKit, type Take } from "@arke-studio/contracts";
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

function render(kits: ReferenceKit[], takes: Take[] = []): string {
  const world = FIXTURE_STATE.world!;
  const state: ClientState = {
    ...FIXTURE_STATE,
    world: { ...world, referenceKits: kits, referenceTakes: takes, referenceReviews: [] },
  };
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter initialEntries={[`/w/${WORLD_ID}/locations/the-vigil/reference`]}>
      <App />
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
}

describe("the location reference tab (#243)", () => {
  it("orders panels by the establishing view first, then acceptance — never by name or date alone", () => {
    // Deliberately adversarial: alphabetically "Day" leads, and by acceptance date the
    // establishing view is last. Panel 1 must still be the establishing view.
    const establishing = view(1, "Establishing view", "2026-08-05T10:00:00Z");
    const reverse = view(2, "Reverse angle", "2026-08-02T10:00:00Z");
    const day = view(3, "Day", "2026-08-03T10:00:00Z");
    const html = render([kit([day, reverse, establishing], "lv_01")]);

    const panels = [...html.matchAll(/PANEL (\d\d)<\/span>.*?<h3>([^<]+)<\/h3>/gs)].map((m) => [m[1], m[2]]);
    assert.deepEqual(panels, [
      ["01", "Establishing view"],
      ["02", "Reverse angle"],
      ["03", "Day"],
    ]);
    assert.ok(html.includes("3 of 6"), "the ceiling is stated before it is reached");
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
    assert.ok(html.includes("rebuilt on every acceptance"));
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
    assert.ok(html.includes("becomes superseded"));
    assert.ok(html.includes("leaves the panel order unchanged"));
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

  it("says what to do first when there is nothing at all", () => {
    const html = render([]);
    assert.ok(html.includes("Start with the establishing view"));
    assert.ok(html.includes("0 of 6"));
    // The empty right-hand pane earns its space by naming what will fill it.
    assert.ok(html.includes("so the model sees the room from more than one side"));
    assert.ok(!html.includes("WHAT A SHOT CARRIES"), "nothing is carried yet, so nothing is promised");
  });
});
