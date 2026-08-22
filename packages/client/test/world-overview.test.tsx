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

/** The hub, rendered against a world the case has adjusted. */
function renderHub(world: Partial<typeof WORLD> = {}): string {
  __setStateForTest({ ...FIXTURE_STATE, world: { ...WORLD, ...world } });
  try {
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${WORLD_ID}`]}>
        <App />
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
}

/**
 * The hero carries nothing to operate (design 63a).
 *
 * The key-art row lived here — Generate from the logline, Upload an image, a model picker and the
 * keep-or-discard offer — over an image this screen does not even show. Asserted as an absence
 * because that is exactly what regressed twice: a control returns to the hero the moment somebody
 * needs somewhere to put one.
 */
describe("the world hub hero (design 63a)", () => {
  it("offers no way to make or bring an image", () => {
    const html = renderHub();
    assert.doesNotMatch(html, /fy-keyart/, "the key-art row is gone, not merely hidden");
    assert.doesNotMatch(html, /Generate key art/);
    assert.doesNotMatch(html, /Upload an image/);
  });

  it("holds no control of any kind between the logline and the fan", () => {
    const html = renderHub();
    const hero = /<div class="fy-hero">([\s\S]*?)<\/div>\s*<div class="fy-fan">/.exec(html);
    assert.ok(hero, "the hero still precedes the fan");
    assert.doesNotMatch(hero[1]!, /<button/, "a hub is a way in, not a workbench");
  });
});

/**
 * What the world is made of, and what is waiting (design 63b).
 *
 * The figures are the world's own — a production's guests are counted nowhere here (SPEC-020 R-8)
 * — and every one of them carries a second line, including on a world with nothing in it. A blank
 * line is what makes the four cells different heights, which is the whole reason it is pinned.
 */
describe("the world at a glance (design 63b)", () => {
  it("draws four figures, each with a line saying what is outstanding", () => {
    const html = renderHub();
    const cells = html.match(/fy-glance__cell/g) ?? [];
    assert.equal(cells.length, 4);
    const subs = [...html.matchAll(/class="fy-glance__sub">([^<]*)</g)].map((m) => m[1]);
    assert.equal(subs.length, 4);
    for (const sub of subs) assert.notEqual(sub, "", "an empty line would shorten its cell");
  });

  it("says something in every cell of a world with nothing in it", () => {
    const html = renderHub({ sheets: [], canon: [], proposals: [], referenceKits: [], productions: [] });
    const subs = [...html.matchAll(/class="fy-glance__sub">([^<]*)</g)].map((m) => m[1]);
    assert.equal(subs.length, 4);
    for (const sub of subs) assert.notEqual(sub, "", "zero is a state to state, not a gap");
    assert.match(html, /Nothing has been made from this world yet/, "and the productions row says so too");
  });

  it("counts the world's own cast, never a production's guests (SPEC-020 R-8)", () => {
    const guest: Sheet = { ...BASE, id: "kettle-boy", name: "Kettle Boy", production: "saltlight" };
    const own = renderHub();
    const withGuest = renderHub({ sheets: [...WORLD.sheets, guest] });
    const figure = (html: string): string =>
      /class="fy-glance__n">(\d+)<\/div><div class="fy-glance__label">Character/.exec(html)?.[1] ?? "";
    assert.notEqual(figure(own), "", "the characters figure is findable");
    assert.equal(figure(withGuest), figure(own), "a guest changes nothing on the world's own count");
  });
});

describe("what needs a person (design 63b)", () => {
  it("names at most two, whatever is waiting", () => {
    const html = renderHub();
    assert.ok(WORLD.proposals.length + WORLD.canon.filter((c) => c.status === "open").length > 0);
    assert.ok((html.match(/fy-needs__item/g) ?? []).length <= 2);
  });

  it("keeps the kind of decision and its verb out of the clipped run", () => {
    // A proposal's summary is a whole sentence; with the kind after it in one clipped span, the
    // one thing this line exists to say was the first thing the ellipsis ate.
    const html = renderHub();
    assert.match(html, /class="fy-needs__why"/);
    assert.match(html, /class="fy-needs__go"/);
    assert.match(declarationsFor(".fy-needs__why"), /flex:\s*none/);
    assert.match(declarationsFor(".fy-needs__go"), /flex:\s*none/);
    assert.match(declarationsFor(".fy-needs__what"), /text-overflow:\s*ellipsis/, "only the subject gives ground");
  });

  it("is absent rather than empty when nothing is waiting", () => {
    const settled = WORLD.canon.map((c) => (c.status === "open" ? { ...c, status: "settled" as const } : c));
    const html = renderHub({ proposals: [], canon: settled });
    assert.doesNotMatch(html, /fy-needs__count/, '"0 things need you" is furniture, not information');
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
 * The bands below the fold (design 63b).
 *
 * Same discipline as the fan and the ledger cards: pin every band and clip every line, so three
 * productions with a one-word title, a logline and no shots at all still sit level — and four
 * glance cells hold one height whatever the world has in it.
 */
describe("the sections below the fold hold their heights", () => {
  it("pins the glance's outstanding line", () => {
    const decls = declarationsFor(".fy-glance__sub");
    assert.match(decls, /height:\s*15px/, "a fixed height, so a settled cell is not shorter");
    assert.match(decls, /white-space:\s*nowrap/);
    assert.match(decls, /text-overflow:\s*ellipsis/);
  });

  for (const [selector, height] of [
    [".fy-prodtile__frame", 128],
    [".fy-prodtile__eyebrow", 13],
    [".fy-prodtile__name", 19],
    [".fy-prodtile__foot", 15],
  ] as const) {
    it(`pins ${selector} at ${height}px`, () => {
      assert.match(declarationsFor(selector), new RegExp(`height:\\s*${height}px`));
    });
  }

  for (const selector of [".fy-prodtile__name", ".fy-prodtile__meta"]) {
    it(`clips ${selector} to one line`, () => {
      const decls = declarationsFor(selector);
      assert.match(decls, /white-space:\s*nowrap/);
      assert.match(decls, /overflow:\s*hidden/);
      assert.match(decls, /text-overflow:\s*ellipsis/);
    });
  }
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

  it("a record the gate could not read is not announced as a field being too long", () => {
    // `invalid` carries more than one kind of refusal, and since the structured records joined
    // the gate's schema fences the commonest is a file the scanner would drop. The fixed title
    // called that a length problem and offered "shorten it" — advice for a different fault.
    __setStateForTest(FIXTURE_STATE);
    try {
      __applyEventForTest({
        at: "2026-08-05T12:00:00Z",
        type: "proposal.blocked",
        worldId: WORLD_ID,
        proposalId: PROPOSAL,
        reason: "invalid",
        detail:
          "productions/saltlight/scenes/slack-water.json: not a scene: Expected ',' or '}' after property value in JSON at position 339",
      });
      const html = renderToString(
        <MemoryRouter initialEntries={[`/w/${WORLD_ID}/proposals`]}>
          <App />
        </MemoryRouter>,
      ).replace(/<!-- -->/g, "");
      assert.doesNotMatch(html, /over its limit/, "no length claim about a parse error");
      assert.doesNotMatch(html, /shorten it/, "and no advice to shorten what is not too long");
      assert.match(html, /This draft cannot be written as it stands/, "the title frames the problem instead");
      assert.match(html, /not a scene: Expected/, "and the gate's own words say what it is");
      assert.match(html, /Ask the studio to fix it, or discard this draft/, "the exit fits the fault");
      assert.match(html, /Nothing has landed/);
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });
});
