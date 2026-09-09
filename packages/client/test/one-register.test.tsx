import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { legacySceneView } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * One register per surface (issue 1010, findings U1–U3 of the 8 September review).
 *
 * Three habits the review found across the app, and the shape each was given here:
 *
 *  - a verb repeated once per row is a glyph with the word in its tooltip, never a band of text;
 *  - a control inside a designed screen is the house control, never the platform's;
 *  - a glyph names a state or a count, or it is not drawn — the master's own "a dot only where
 *    it warns", applied to the status dot that followed every name on four screens.
 *
 * These render whole routes rather than components, because what the review was reading was the
 * page: a card whose foot no longer names its status would pass a component test and still leave
 * the screen saying less than it did.
 */

const WORLD = FIXTURE_STATE.world!;
const WORLD_ID = WORLD.meta.worldId;
const HERE = dirname(fileURLToPath(import.meta.url));
const UI_CSS = readFileSync(join(HERE, "../src/components/ui.css"), "utf8");
const FIDELITY_CSS = readFileSync(join(HERE, "../src/screens/fidelity.css"), "utf8");

function renderRoute(path: string): string {
  __setStateForTest(FIXTURE_STATE);
  try {
    return renderToString(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
}

/** The markup of the one element carrying this accessible name. */
function labelled(html: string, label: string): string | null {
  const match = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html);
  return match === null ? null : match[0];
}

describe("a repeated row verb is a glyph, not a band of words (U1)", () => {
  it("gives the record's quiet row its verbs as labelled glyphs", () => {
    const html = renderRoute(`/w/${WORLD_ID}/cast/maren-kest`);
    for (const verb of ["Rename", "Duplicate", "Retire"]) {
      const button = labelled(html, verb);
      assert.ok(button, `${verb} is a control with an accessible name`);
      assert.match(button, /class="[^"]*ui-iconbtn/, `${verb} is drawn as a glyph`);
      // The drawn tip, not `title`: `title` answers the pointer only, so a glyph tabbed to would
      // say nothing at all — which is what the row of words it replaced never did.
      assert.match(button, /class="[^"]*fy-tip/, `${verb} carries the tooltip that answers focus`);
      assert.match(button, new RegExp(`data-tip="${verb}`), `${verb} carries a tooltip`);
    }
    // Dropping the word must not drop what the word stood next to: the text button carried this
    // on its own `title`, and a glyph with less to say than the control it replaced is a worse
    // control (codex review of this change).
    assert.match(
      html,
      /data-tip="Retire — stays resolvable for existing citations; leaves pickers for new work"/,
      "and Retire still says what it leaves behind",
    );
    assert.doesNotMatch(
      html,
      /<button[^>]*class="ui-btn[^"]*"[^>]*>Rename<\/button>/,
      "and no longer a second row of words under the primary buttons",
    );
  });

  /*
   * A glyph says less than a word, so it has to keep the affordances the word had. Chapters
   * disables the first Up and the last Down, the kit's Upload goes dead outside the desktop app,
   * and the Bible's speaker is dead on an empty section — all of which read as live controls
   * until the shared rule says otherwise (codex review of this change).
   */
  it("says an unavailable glyph is unavailable, and stops hovering it", () => {
    assert.match(UI_CSS, /\.ui-iconbtn:disabled\s*\{[^}]*cursor:\s*default/);
    assert.match(UI_CSS, /\.ui-iconbtn:hover:not\(:disabled\)/, "an unavailable glyph does not light up");
    assert.doesNotMatch(UI_CSS, /\.ui-iconbtn:hover\s*\{/, "and the unguarded hover rule is gone");
    // A fieldset disables everything inside it without passing any of them `disabled`.
    assert.match(UI_CSS, /\.ui-check:has\(input:disabled\)/);
  });

  /*
   * A tooltip that only answers the pointer leaves a keyboard user with a glyph and nothing,
   * and one that cannot leave its container leaves the put-away chat rail's two controls unnamed.
   * Both were regressions of this change, one round apart (codex review).
   */
  it("shows the tooltip on focus as well as hover, and leaves room for it where it is clipped", () => {
    assert.match(FIDELITY_CSS, /\.fy-tip:hover::after,\s*\.fy-tip:focus-visible::after/);
    // The put-away rail is 48px and both its controls are glyphs; a tip is wider than that, and
    // the column used to hide its overflow. `position: fixed` is no escape here — fy-fade-up
    // leaves a transform on the column, which is a containing block for fixed descendants.
    const rail = /\.fy-chatnav \{([\s\S]*?)\}/.exec(FIDELITY_CSS);
    assert.ok(rail, "the rail is styled");
    assert.doesNotMatch(rail[1]!, /overflow:\s*hidden/, "the rail does not clip its controls' tips");
    assert.match(FIDELITY_CSS, /\.fy-chatnav__list \{[^}]*overflow-x:\s*hidden/, "the list still clips");
  });

  it("gives the bible's contents one speaker per heading rather than the word Listen", () => {
    const html = renderRoute(`/w/${WORLD_ID}/bible`);
    assert.doesNotMatch(html, />Listen</, "Listen is not printed once per section");
    const speaker = /<button[^>]*aria-label="Read [^"]+ aloud"[^>]*>/.exec(html);
    assert.ok(speaker, "the speaker keeps the words on its accessible name");
    assert.match(speaker[0]!, /class="[^"]*ui-iconbtn/, "and is drawn as a glyph");
  });

  it("keeps the cut's toolbar to one register: every control a glyph with a tip", () => {
    const html = renderRoute(`/w/${WORLD_ID}/p/saltlight/cut`);
    const toolbar = /<div class="fy-timeline__toolbar">([\s\S]*?)<\/div><div class="fy-timeline__canvas"/.exec(html);
    assert.ok(toolbar, "the toolbar renders");
    for (const word of ["Add audio track", "Scene labels", "Split", "snap", "duck"]) {
      assert.ok(
        !toolbar[1]!.includes(`>${word}<`),
        `${word} is a tooltip on a glyph, not a label beside one`,
      );
    }
    for (const label of ["Add audio track", "Scene labels", "Snap", "Keyboard shortcuts"]) {
      assert.match(toolbar[1]!, new RegExp(`aria-label="${label}"`), `${label} keeps its accessible name`);
      assert.match(toolbar[1]!, new RegExp(`data-tip="${label}`), `${label} keeps a tip a pointer can read`);
    }
  });
});

describe("a designed screen draws its own controls (U2)", () => {
  /*
   * With one exception, and it is a requirement rather than a taste: SPEC-041 R-81 binds a
   * *generation result* to native playback controls, so seeking, volume and fullscreen survive.
   * A `take-review` card owes only playable media (R-26), which is where the house player goes.
   */
  it("keeps the platform's player on a generation result and nowhere else", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/components/conversation.tsx"),
      "utf8",
    );
    assert.match(source, /receipt\.generation\.results[\s\S]{0,1400}<video[^>]*controls/);
    assert.match(source, /R-81/, "and says which requirement holds it there");
  });

  it("wears the house select on Settings, chevron and all", () => {
    const html = renderRoute("/settings/notifications");
    assert.match(html, /<span class="ui-select"><select class="ui-select__control"/);
    assert.match(html, /aria-label="Background notifications"/);
  });

  it("wears it on the full shot's camera fields too", () => {
    const production = WORLD.productions[0]!;
    const record = production.scenes?.[0];
    assert.ok(record, "the fixture has a scene");
    // A scene record is either shape (SPEC-029); the projection is how a screen reads its shots.
    const scene = legacySceneView(record);
    assert.ok(scene.shots.length > 0, "and a shot to open");
    const html = renderRoute(
      `/w/${WORLD_ID}/p/${production.meta.id}/scenes/${scene.id}/shots/${scene.shots[0]!.id}`,
    );
    assert.match(html, /class="ui-select__control fy-sheetselect"/, "the sheet's own type over the house control");
    assert.doesNotMatch(
      html,
      /<select class="fy-sheetselect"/,
      "and no select left wearing the platform's button",
    );
  });
});

describe("a glyph names a state or a count, or it is not drawn (U3)", () => {
  it("states locked or sketch in words on the cast ledger, with no dot after the name", () => {
    const html = renderRoute(`/w/${WORLD_ID}/cast`);
    const row = /<div class="fy-row__name">([\s\S]*?)<\/div>/.exec(html);
    assert.ok(row, "the ledger renders rows");
    assert.doesNotMatch(row[1]!, /fy-dot/, "no unlegended dot follows the name");
    assert.match(html, /<span class="fy-row__meta">locked · /, "the row says the state instead");
  });

  it("keeps the status off every heading of a location record", () => {
    const html = renderRoute(`/w/${WORLD_ID}/locations/the-vigil`);
    assert.ok(html.includes('<div class="fy-sheet__sechead">'), "the record has headings to check");
    assert.doesNotMatch(
      html,
      /<div class="fy-sheet__sechead"[^>]*>[\s\S]{0,120}?fy-dot/,
      "the badge under the name says it once",
    );
  });

  it("names the state on the production cast card that used to carry a bare dot", () => {
    const html = renderRoute(`/w/${WORLD_ID}/p/saltlight/cast`);
    const title = /<div class="fy-gridcard__title">([\s\S]*?)<\/div>/.exec(html);
    assert.ok(title, "the production's cast renders cards");
    assert.doesNotMatch(title[1]!, /fy-dot/, "no dot after the name");
    assert.match(html, /<div class="fy-gridcard__foot"[^>]*>[^<]*·[^<]*(locked|sketch)/, "the foot carries it");
  });
});
