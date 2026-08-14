import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { CHARACTER_ROLE_MAX, type Sheet } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __applyEventForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, "../src/screens/fidelity.css"), "utf8");

/**
 * The world hub's cast fan (SPEC-007 R-18, R-19).
 *
 * The design draws the fan as fixed-height cards, which only holds if the two lines on the card
 * are bounded. Height itself is a CSS concern and is asserted in the stylesheet test; what these
 * assert is the input to it — that the role line carries the role and nothing else, and that a
 * character with no role contributes no text rather than a sentence of essence prose.
 */

const WORLD = FIXTURE_STATE.world!;
const WORLD_ID = WORLD.meta.worldId;

/** The fixture world with its cast replaced, so each case controls exactly one card. */
function renderHubWithCast(characters: Sheet[]): string {
  const others = WORLD.sheets.filter((s) => s.type !== "character");
  __setStateForTest({
    ...FIXTURE_STATE,
    world: { ...WORLD, sheets: [...characters, ...others] },
  });
  try {
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${WORLD_ID}`]}>
        <App />
      </MemoryRouter>,
    );
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
}

const BASE: Sheet = {
  id: "ilo-venn",
  type: "character",
  name: "Ilo Venn",
  version: 1,
  status: "sketch",
  canonRules: [],
  links: [],
  created: "2026-05-02",
  updated: "2026-05-02",
  sections: [
    {
      heading: "Essence",
      body: "A cartographer who maps the drowned streets by memory because the charts all lie.",
    },
  ],
};

describe("the world hub cast fan (R-18, R-19)", () => {
  it("shows the role on the card", () => {
    const html = renderHubWithCast([{ ...BASE, role: "Cartographer" }]);
    assert.ok(html.includes('class="fy-polaroid__role">Cartographer<'), "the role is the card's second line");
  });

  it("shows nothing where a character has no role, rather than a sentence of essence", () => {
    const html = renderHubWithCast([BASE]);
    assert.ok(
      html.includes('class="fy-polaroid__role"></div>'),
      "the role line renders empty so the card keeps its height",
    );
    assert.ok(
      !html.includes("A cartographer who maps the drowned streets"),
      "essence prose never stands in for a missing role — it is what made the fan ragged",
    );
  });

  it("still renders a role that was already on disk before the cap existed", () => {
    // The read path is deliberately unbounded (R-18): a world that opened yesterday must open
    // today. The card clips it in CSS rather than the sheet being rejected or the text cut.
    const long = "Rigger and runner of quiet cargo, and other errands";
    assert.ok(long.length > CHARACTER_ROLE_MAX);
    const html = renderHubWithCast([{ ...BASE, role: long }]);
    assert.ok(html.includes(`class="fy-polaroid__role">${long}<`), "rendered whole; the clip is CSS");
  });
});

/** The declarations in effect for a selector, across every rule that names it. */
function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules = [...CSS.matchAll(new RegExp(`([^{}]*)\\{([^}]*)\\}`, "g"))];
  return rules
    .filter(([, head]) =>
      head!.split(",").some((part) => new RegExp(`(^|\\s)${escaped}\\s*$`).test(part!.trim())),
    )
    .map(([, , body]) => body)
    .join(";");
}

describe("the card holds one height whatever it is given", () => {
  // Both lines are clipped rather than wrapped, and both hold a fixed height. Together with the
  // fixed frame and padding that makes .fy-polaroid a constant 243px — the whole point of the
  // fan. Lose any one of these and cards start growing with their copy again.
  for (const selector of [".fy-polaroid__name", ".fy-polaroid__role"]) {
    it(`clips ${selector} to a single fixed line`, () => {
      const decls = declarationsFor(selector);
      assert.match(decls, /white-space:\s*nowrap/, "must not wrap");
      assert.match(decls, /overflow:\s*hidden/, "must not spill");
      assert.match(decls, /text-overflow:\s*ellipsis/, "overflow reads as truncation, not a hard cut");
      assert.match(decls, /height:\s*\d+px/, "a fixed height, so an empty line still occupies one");
    });
  }

  it("keeps the frame a fixed size, the other half of the constant height", () => {
    assert.match(declarationsFor(".fy-polaroid__frame"), /height:\s*180px/);
  });
});

/**
 * The location and faction grids (SPEC-007 R-20, R-21).
 *
 * These cards carry derived prose rather than a bounded field, so uniformity comes from clamping
 * by rendered line. Equal boxes are not the test — CSS grid fakes those within a row on its own,
 * which is exactly what hid the defect. What matters is that every band holds its size, so the
 * meta line lands at the same offset on a sparse card and a fully-written one.
 */

const LOCATION: Sheet = {
  id: "the-bell-market",
  type: "location",
  name: "The Bell Market",
  version: 1,
  status: "sketch",
  canonRules: [],
  links: [],
  created: "2026-05-02",
  updated: "2026-05-02",
  sections: [{ heading: "Look", body: "A church that forgot it was one.\nNobody stands under the bell." }],
};

const FACTION: Sheet = {
  id: "the-salvage-guild",
  type: "faction",
  name: "The Salvage Guild",
  version: 1,
  status: "sketch",
  canonRules: [],
  links: [],
  created: "2026-05-02",
  updated: "2026-05-02",
  sections: [{ heading: "Essence", body: "Divers who sell what the deep lets go of." }],
};

function renderSheets(path: string, sheets: Sheet[]): string {
  __setStateForTest({ ...FIXTURE_STATE, world: { ...WORLD, sheets } });
  try {
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${WORLD_ID}/${path}`]}>
        <App />
      </MemoryRouter>,
    );
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
}

describe("location and faction cards are fixed height (R-20, R-21)", () => {
  it("marks both card kinds as fixed so the clamp rules apply", () => {
    assert.match(renderSheets("locations", [LOCATION]), /fy-gridcard--fixed/);
    const factions = renderSheets("factions", [FACTION]);
    assert.match(factions, /fy-gridcard--fixed/);
    assert.match(
      factions,
      /fy-gridcard--fixed-faction/,
      "factions run a size larger and carry two more bands",
    );
  });

  it("leaves the canon grid unclamped — its entries may run as long as they run", () => {
    // The clamp is scoped to a modifier precisely so this stays true. If it ever moves onto
    // .fy-gridcard__body directly, canon entries start losing their text.
    assert.doesNotMatch(renderSheets("canon", WORLD.sheets), /fy-gridcard--fixed/);
  });

  it("renders both wants and fears lines even when the faction has neither", () => {
    const html = renderSheets("factions", [FACTION]);
    const lines = html.match(/fy-wants__line/g) ?? [];
    assert.equal(lines.length, 2, "a sketch with no wants and no fears still reserves both lines");
    assert.match(html, /fy-gridcard__links/, "and the links row, so a faction with no links is not shorter");
  });

  it("hands the card whole prose and lets CSS clamp it, rather than slicing mid-word", () => {
    const long =
      "The harbour's shadow government: nine chairs, seven filled, two kept empty for the drowned, " +
      "and they tax what moves, pardon what pays, and forget what sinks.";
    const html = renderSheets("factions", [{ ...FACTION, sections: [{ heading: "Essence", body: long }] }]);
    // The old 120-char slice ended here, mid-word and with no ellipsis.
    assert.doesNotMatch(html, /pardon\s*<\/div>/, "no hard character cut");
    assert.match(
      html,
      /forget what sinks\./,
      "the full first sentence reaches the card; the clamp does the rest",
    );
  });

  it("flattens the hard wrapping in a markdown body so it measures as one run", () => {
    const html = renderSheets("locations", [LOCATION]);
    assert.match(html, /A church that forgot it was one\./);
    assert.doesNotMatch(html, /one\.\n/, "the newline between wrapped source lines is collapsed");
  });

  for (const selector of [
    ".fy-gridcard--fixed .fy-gridcard__body",
    ".fy-gridcard--fixed-faction .fy-gridcard__body",
  ]) {
    it(`clamps ${selector} to a fixed two-line box`, () => {
      const decls = declarationsFor(selector);
      // Height must be px, and so must the line-height that divides into it — a unitless or
      // ratio line-height makes the box a non-integer number of lines and clips a sliver of the
      // second one. Either spelling counts: `line-height: 18px` or the `font: …/18px` shorthand.
      const height = /(?:^|;)\s*height:\s*(\d+)px/.exec(decls);
      assert.ok(height, "a fixed height whatever the copy");
      const lineHeight = /line-height:\s*(\d+)px/.exec(decls) ?? /font:[^;]*\/(\d+)px/.exec(decls);
      assert.ok(lineHeight, "line-height in px, so the height is exactly two lines");
      assert.equal(Number(height[1]), Number(lineHeight[1]) * 2, "the box is exactly two lines tall");
    });
  }

  it("clamps the description by line, with an ellipsis at the real break", () => {
    const decls = declarationsFor(".fy-gridcard--fixed .fy-gridcard__body");
    assert.match(decls, /-webkit-line-clamp:\s*2/, "two rendered lines, not a character count");
    assert.match(decls, /overflow:\s*hidden/);
  });

  it("clips the card name to one line", () => {
    const decls = declarationsFor(".fy-gridcard--fixed .fy-gridcard__name");
    assert.match(decls, /white-space:\s*nowrap/);
    assert.match(decls, /text-overflow:\s*ellipsis/);
  });

  it("pins the faction's wants/fears pair and its links row", () => {
    const wants = declarationsFor(".fy-wants");
    assert.match(wants, /height:\s*40px/, "two 20px lines, present or not");
    const line = declarationsFor(".fy-wants__line");
    assert.match(line, /white-space:\s*nowrap/, "a long want cannot push fears out of the card");
    const links = declarationsFor(".fy-gridcard__links");
    assert.match(links, /height:\s*20px/, "one row");
    assert.match(links, /flex-wrap:\s*nowrap/, "a fourth pill would otherwise add 20px");
    assert.match(links, /overflow:\s*hidden/);
  });
});

/**
 * The world picker (SPEC-001 R-12).
 *
 * The picker lays its cards out with align-items:flex-start, so nothing stretches and every card
 * is exactly its own content — there is no grid here to mask a ragged row. The card height and
 * the dashed "New world" card's height therefore come from one custom property.
 */

type PickerWorld = (typeof FIXTURE_STATE)["worlds"][number];

const WORLD_ROW: PickerWorld = {
  worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD",
  slug: "vessel",
  name: "Vessel",
  logline: "Alien Man is the only being who can move between two worlds that were never meant to overlap.",
  counts: { characters: 0, locations: 0, factions: 0, canonEntries: 0, productions: 0 },
  keyArt: null,
  updated: FIXTURE_STATE.worlds[0]!.updated,
};

function renderPicker(worlds: PickerWorld[]): string {
  __setStateForTest({ ...FIXTURE_STATE, worlds });
  try {
    return renderToString(
      <MemoryRouter initialEntries={["/worlds"]}>
        <App />
      </MemoryRouter>,
    );
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
}

describe("world picker cards are fixed height (SPEC-001 R-12)", () => {
  it("renders the logline box even for a world that has none", () => {
    const { logline: _dropped, ...noLogline } = WORLD_ROW;
    const html = renderPicker([noLogline as PickerWorld]);
    assert.match(
      html,
      /class="fy-worldcard__logline"><\/div>/,
      "an empty box, not a missing one — otherwise this card is shorter than its neighbours",
    );
  });

  it("gives the counts their own clipped element rather than a bare text node", () => {
    // A bare text node in a flex row becomes an anonymous flex item and wraps internally, which
    // is what turned this 15px band into 38px once the timestamp became a full date.
    const html = renderPicker([WORLD_ROW]);
    assert.match(html, /class="fy-worldcard__counts"/);
  });

  it("takes the card height and the New world card's height from one declaration", () => {
    const card = declarationsFor(".fy-worldcard");
    const placeholder = declarationsFor(".fy-newworldcard");
    const varName = /height:\s*var\((--[\w-]+)\)/.exec(card)?.[1];
    assert.ok(varName, ".fy-worldcard takes its height from a custom property");
    assert.ok(placeholder.includes(`height: var(${varName})`), "and so does the placeholder");
    // Defined once, on the row that holds both — so there is exactly one number to change.
    const definition = new RegExp(`${varName}:\\s*\\d+px`);
    assert.match(declarationsFor(".fy-home-cards"), definition, `${varName} is defined on .fy-home-cards`);
  });

  it("pins every band on the card", () => {
    assert.match(declarationsFor(".fy-worldcard__frame"), /height:\s*286px/);
    const name = declarationsFor(".fy-worldcard__name");
    assert.match(name, /height:\s*24px/);
    assert.match(name, /white-space:\s*nowrap/);
    const logline = declarationsFor(".fy-worldcard__logline");
    assert.match(logline, /-webkit-line-clamp:\s*2/, "two rendered lines, ellipsised at the break");
    assert.match(logline, /height:\s*39px/);
    assert.match(
      declarationsFor(".fy-worldcard__meta"),
      /height:\s*15px/,
      "one line, whatever the date says",
    );
    assert.match(declarationsFor(".fy-worldcard__counts"), /text-overflow:\s*ellipsis/);
  });

  it("keeps the timestamp from being squeezed by a long count string", () => {
    assert.match(declarationsFor(".fy-worldcard__meta .mono"), /flex:\s*none/);
  });
});

describe("the gate's over-limit refusal reaches the user (SPEC-007 R-18)", () => {
  const PROPOSAL = FIXTURE_STATE.world!.proposals[0]!.proposal.id;

  it("names the file and the count, and says what the way out is", () => {
    __setStateForTest(FIXTURE_STATE);
    try {
      __applyEventForTest({
        at: "2026-08-05T12:00:00Z",
        type: "proposal.blocked",
        worldId: WORLD_ID,
        proposalId: PROPOSAL,
        reason: "invalid",
        detail: "characters/maren-kest.md: role is 34 characters; the limit is 28",
      });
      // The panels used to stack on the hub and the notice was read there. They have their own
      // screen now, so this reads it where it renders — the requirement is that the refusal
      // reaches the user, not that it reaches them on any particular screen.
      //
      // What carries findability from the hub is the chrome, not a panel on it: the proposals
      // icon wears the same warning dot as activity whenever something waits and reaches the
      // proposals screen from anywhere, which is a stronger guarantee than one screen's copy.
      const hub = renderToString(
        <MemoryRouter initialEntries={[`/w/${WORLD_ID}`]}>
          <App />
        </MemoryRouter>,
      ).replace(/<!-- -->/g, "");
      assert.match(
        hub,
        /title="Proposals — 1 awaiting a decision"/,
        "the chrome still says something is waiting, so the notice is findable",
      );
      assert.match(hub, /fy-iconbtn__dot/, "and wears the warning dot that says so at a glance");

      const html = renderToString(
        <MemoryRouter initialEntries={[`/w/${WORLD_ID}/proposals`]}>
          <App />
        </MemoryRouter>,
      ).replace(/<!-- -->/g, "");
      assert.match(html, /A field is over its limit/, "the notice has a title of its own");
      assert.match(html, /role is 34 characters; the limit is 28/, "and the count, so it can be acted on");
      // There is no way to hand-edit a staged proposal, so the notice must offer the exit.
      assert.match(html, /Ask the studio to shorten it, or discard this draft/);
      assert.match(html, /Nothing has landed/);
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });
});
