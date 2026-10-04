import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The Audiobook view uses the whole room (design turn 193, rules 15, 16 and 18, amending 188).
 *
 * 188 capped every chapter view at 940 and centred it: prose 640, gap 28, a 250 rail. That is right
 * for the Manuscript, whose prose measure is the reason, and wrong for the Audiobook view, whose
 * block panel holds a picture, a look, delivery, a note, a take and timing and wrapped a word to a
 * line at 250. Layout cannot be measured under linkedom, so this reads the rules the view is laid
 * out by: which views the cap still reaches, and the two measures that replace it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, "../src/screens", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const responsive = read("chapter-responsive.css");
const fidelity = read("fidelity.css");

/** Every `selector { declarations }` in a sheet, with at-rules flattened: enough to ask which rules a selector appears in. */
function rules(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim().replace(/\s+/g, " "), body: match[2]!.trim().replace(/\s+/g, " ") }));
}
const mentioning = (css: string, needle: string) => rules(css).filter((rule) => rule.selector.includes(needle));

describe("the Audiobook view takes the whole room (turn 193)", () => {
  it("the 940 cap reaches the Manuscript and neither the Audiobook view nor Timing", () => {
    const capped = rules(responsive).filter((rule) => rule.body.includes("max-width: var(--content-max-chapter)"));
    assert.ok(capped.length > 0, "the Manuscript keeps its measure");
    for (const rule of capped) {
      assert.match(rule.selector, /\[data-view="manuscript"\]/, `only the Manuscript is capped: ${rule.selector}`);
      assert.doesNotMatch(rule.selector, /audiobook|timing/);
    }
    assert.equal(rules(fidelity).filter((rule) => rule.body.includes("var(--content-max-chapter)") && /audiobook|timing/.test(rule.selector)).length, 0);
  });

  it("the panel is 30% of the room between 420 and 560; the list starts at the 24 gutter and its words stop at 780 (194, rules 10 and 11)", () => {
    const root = mentioning(fidelity, ":root").map((rule) => rule.body).join(" ");
    assert.match(root, /--ab-panel: clamp\(420px, 30cqw, 560px\)/);
    assert.doesNotMatch(root, /--ab-list-max|--ab-pad/, "the centred measure and its padding are gone");
    const panel = rules(responsive).find((rule) => rule.selector === '[data-screen="chapter"][data-view="audiobook"] .fy-ch__panels' && rule.body.includes("var(--ab-panel)"));
    assert.ok(panel, "the panel's width is the token");
    assert.match(panel!.body, /border-left: 1px solid var\(--border\)/, "docked with a rule");
    assert.match(panel!.body, /container: ab-panel \/ inline-size/, "the picture card can answer the panel's own width (460 beside, 420 over)");
    const list = rules(responsive).find((rule) => rule.selector.endsWith(".fy-ab__blocks") && rule.selector.includes('[data-view="audiobook"]'));
    assert.ok(list);
    assert.match(list!.body, /max-width: none/);
    assert.doesNotMatch(list!.body, /padding-inline/, "no centring padding: the list's own 24 gutter stands");
    assert.match(rules(fidelity).find((rule) => rule.selector === ".fy-ab__blocks")!.body, /padding: 10px 24px 0/, "from the 24 gutter, rows running to the panel");
    const row = rules(fidelity).find((rule) => rule.selector === ".fy-ab__block")!;
    assert.match(row.body, /--ab-measure: 780px/);
    assert.match(row.body, /grid-template-columns: 120px minmax\(0, var\(--ab-measure\)\) minmax\(16px, 1fr\) auto/, "120 + 780 + end, the end pinned right");
    assert.match(rules(fidelity).find((rule) => rule.selector === ".fy-ab__text")!.body, /font: 400 var\(--text-base\)\/1\.6/, "narration 14, weight 400, line height 1.6");
  });

  it("the head and body have no centred cap and the centre gives its padding to the toolbar, list and foot (194)", () => {
    const audiobook = mentioning(responsive, '[data-view="audiobook"]');
    assert.ok(audiobook.some((rule) => rule.selector.endsWith('[data-view="audiobook"] .fy-sw__centre') && rule.body.startsWith("padding: 0;")));
    assert.ok(audiobook.some((rule) => rule.selector.endsWith(".fy-ch__body") && rule.body === "gap: 0;"));
    assert.ok(audiobook.every((rule) => !/margin-inline: auto/.test(rule.body)), "nothing in the Audiobook view centres itself against a cap");
  });

  it("below 1100 the toolbar folds to two lines and Read and Listen are held at a 44-high foot, on the Audiobook view alone (194, rule 15)", () => {
    const folded = (needle: string) => mentioning(responsive, needle).filter((rule) => rule.selector.startsWith('[data-screen="chapter"][data-view="audiobook"]'));
    assert.match(responsive, /\.fy-ab__hold \{ display: none; \}/, "nothing is held until the window is narrow");
    const hold = folded(".fy-ab__hold").find((rule) => rule.selector.endsWith(".fy-ab__hold") && rule.body.includes("position: sticky"))!;
    assert.match(hold.body, /bottom: 0/);
    assert.match(hold.body, /border-top: 1px solid var\(--border\)/);
    assert.ok(folded(".fy-ab__hold :is(.ui-btn, .fy-ab__pill)").some((rule) => /min-height: 44px/.test(rule.body)), "the held presses are 44 high");
    const line = folded(".fy-ch__viewline").find((rule) => rule.selector.endsWith(".fy-ch__viewline") && rule.body.includes("padding: 10px"))!;
    assert.match(line.body, /flex-wrap: wrap/, "the view switch on its own line, the presses on the next");
    assert.ok(folded(".fy-seg__item").some((rule) => /height: 30px; min-height: 0/.test(rule.body)), "the quiet presses are the toolbar's 30, not 173's 44 targets");
    // Each is scoped to the Audiobook view: Timing and the Manuscript are not drawn here.
    for (const rule of mentioning(responsive, ".fy-ab__hold").filter((rule) => !rule.selector.startsWith(".fy-ab__hold"))) {
      assert.match(rule.selector, /\[data-view="audiobook"\]/);
    }
  });

  it("only the Audiobook view's panel changes width: Timing and the Manuscript keep the 250 side", () => {
    const base = rules(responsive).find((rule) => rule.selector === ".fy-ch__panels");
    assert.match(base!.body, /width: 250px/);
    for (const rule of mentioning(responsive, ".fy-ch__panels").filter((rule) => rule.body.includes("--ab-panel") || rule.body.includes("cqw"))) {
      assert.match(rule.selector, /\[data-view="audiobook"\]/);
    }
  });
});

/**
 * Illustrate this chapter as a sheet over the main area (design turn 193h, 193j, rules 17 and 19):
 * a grid four across where the sheet is wide, two between 600 and 1099, one list on a phone with the
 * foot held, held rows amber. The sheet's own width decides the columns above 1099.
 */
const illustrate = readFileSync(join(here, "../src/components/audiobook-illustrate.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the Illustrate proposal is a sheet over the main area (turn 193)", () => {
  const rule = (selector: string) => rules(illustrate).filter((candidate) => candidate.selector === selector);

  it("stands in the chapter's grid cell over the centre, not over the dock", () => {
    const sheet = rule(".fy-ills")[0]!;
    assert.match(sheet.body, /grid-area: 1 \/ 1/);
    assert.match(sheet.body, /position: relative/);
    assert.ok(rule(".fy-sw:has(> .fy-ills) > .fy-sw__centre").some((candidate) => candidate.body === "grid-area: 1 / 1;"), "the centre shares the cell, so the dock keeps its column");
  });

  it("is four across, three and two as the sheet narrows, two on a tablet and a list on a phone", () => {
    const columns = rule(".fy-ills__grid").map((candidate) => /grid-template-columns: ([^;]+);/.exec(candidate.body)?.[1]);
    assert.deepEqual(columns, ["repeat(4, minmax(0, 1fr))", "repeat(3, minmax(0, 1fr))", "repeat(2, minmax(0, 1fr))", "repeat(2, minmax(0, 1fr))", "minmax(0, 1fr)"], "default, container 999, container 759, the 1099 media rule, the 599 media rule: in that order, so the later wins");
    assert.match(illustrate, /@media \(max-width: 1099px\)/);
    assert.match(illustrate, /@media \(max-width: 599px\)/);
    assert.match(illustrate, /@container ills \(max-width: 999px\)/);
    assert.match(rule(".fy-ills__sheet")[0]!.body, /container: ills \/ inline-size/);
  });

  it("holds the row amber and fades a skipped one; the foot stays at the bottom with Accept", () => {
    assert.match(rule(".fy-ills__card--held .fy-ills__th")[0]!.body, /border-color: var\(--warning\)/);
    assert.match(rule(".fy-ills__card--off")[0]!.body, /opacity: 0\.5/);
    assert.match(rule(".fy-ills__foot")[0]!.body, /border-top: 1px solid var\(--border\)/);
    assert.ok(rule(".fy-ills__foot .ui-btn--primary").length > 0, "Accept takes the foot on a phone");
  });
});

/** The rules inside every `@media (<query>) { … }` block of a sheet, read by brace depth. */
function inMedia(css: string, query: string): { selector: string; body: string }[] {
  const found: { selector: string; body: string }[] = [];
  const opener = `@media (${query}) {`;
  for (let at = css.indexOf(opener); at !== -1; at = css.indexOf(opener, at + 1)) {
    let depth = 1, end = at + opener.length;
    for (; end < css.length && depth > 0; end++) depth += css[end] === "{" ? 1 : css[end] === "}" ? -1 : 0;
    found.push(...rules(css.slice(at + opener.length, end - 1)));
  }
  return found;
}

describe("the block's panel as a phone sheet stands where 194h draws it", () => {
  const phone = inMedia(responsive, "max-width: 599px");

  it("rises to 110 under the view switch, the panel alone: Read, Direct and Timing keep the lower top", () => {
    const panel = phone.find((rule) => rule.selector === ".fy-chapter-block-sheet:has(.fy-abp)");
    assert.ok(panel, "a phone rule names the sheet that holds the block's panel");
    assert.equal(panel!.body, "top: calc(110px + env(safe-area-inset-top, 0px));");
    assert.ok(phone.some((rule) => rule.selector === ".fy-chapter-block-sheet" && rule.body === "top: min(311px, 40dvh);"), "the other block sheets are unchanged");
    // Only the phone moves it: the tablet's raised sheet and the desktop's docked one keep theirs.
    const elsewhere = rules(responsive).filter((rule) => rule.selector.includes(".fy-chapter-block-sheet:has(.fy-abp)") && /(^|; )(top|inset):/.test(rule.body));
    assert.equal(elsewhere.length, 1);
  });

  it("draws the grab 40 by 4 in neutral 400 with a 2 radius, on the phone alone", () => {
    const grab = phone.find((rule) => rule.selector === ".fy-chapter-block-sheet:has(.fy-abp) .fy-page-sheet__grab");
    assert.ok(grab);
    assert.match(grab!.body, /width: 40px/);
    assert.match(grab!.body, /border-radius: 2px/);
    assert.match(grab!.body, /background: var\(--neutral-400\)/);
    assert.match(grab!.body, /margin-top: 8px/);
    assert.equal(rules(responsive).filter((rule) => rule.selector.includes(":has(.fy-abp) .fy-page-sheet__grab")).length, 1);
  });

  it("draws no ring round the title the sheet focuses as it opens: neither an outline nor the global ring's box-shadow (local.18)", () => {
    // The global :focus-visible ring is a box-shadow (theme/globals.css), and Chromium matches it
    // on a heading focused after showModal(): clearing the outline alone left the title boxed.
    const title = rules(responsive).filter((rule) => rule.selector.split(",").map((part) => part.trim()).includes(".fy-abp__title h2:focus"));
    assert.ok(title.some((rule) => /outline: none/.test(rule.body)));
    assert.ok(title.some((rule) => /box-shadow: none/.test(rule.body)), "the box-shadow ring is cleared too");
    const globals = readFileSync(join(here, "../src/theme/globals.css"), "utf8");
    assert.match(globals, /:focus-visible \{[^}]*box-shadow: var\(--shadow-focus\)/, "the ring this clears is still the global box-shadow");
  });
});

describe("the toolbar's menus mark focus by their filled row (turn 194, local.15)", () => {
  it("draws no ring round the item a menu focuses as it opens: the soft fill is its mark", () => {
    const focused = rules(fidelity).filter((candidate) => candidate.selector.split(",").map((part) => part.trim()).includes(".fy-ab__menu-opt:focus-visible"));
    assert.ok(focused.some((candidate) => /background: var\(--secondary\)/.test(candidate.body)), "the filled row, as hover");
    assert.ok(focused.some((candidate) => /box-shadow: none/.test(candidate.body)), "and not the global focus ring, which drew a thick box in the filter");
  });
});
