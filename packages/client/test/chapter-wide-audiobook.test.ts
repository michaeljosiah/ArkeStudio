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

  it("the panel is a third of the room between 420 and 520, the list's text stops at 920", () => {
    const root = mentioning(fidelity, ":root").map((rule) => rule.body).join(" ");
    assert.match(root, /--ab-panel: clamp\(420px, 34cqw, 520px\)/);
    assert.match(root, /--ab-list-max: 920px/);
    const panel = rules(responsive).find((rule) => rule.selector === '[data-screen="chapter"][data-view="audiobook"] .fy-ch__panels' && rule.body.includes("var(--ab-panel)"));
    assert.ok(panel, "the panel's width is the token");
    assert.match(panel!.body, /border-left: 1px solid var\(--border\)/, "docked with a rule");
    assert.match(panel!.body, /container: ab-panel \/ inline-size/, "the picture card can answer the panel's own width (480 beside, 420 over)");
    const list = rules(responsive).find((rule) => rule.selector.endsWith(".fy-ab__blocks") && rule.selector.includes('[data-view="audiobook"]'));
    assert.ok(list);
    assert.match(list!.body, /max-width: none/);
    assert.match(list!.body, /padding-inline: var\(--ab-pad\)/);
    const pad = rules(responsive).find((rule) => rule.body.includes("--ab-pad:"));
    assert.match(pad!.body, /max\(8px, calc\(\(100% - var\(--ab-list-max\)\) \/ 2\)\)/, "centred in the room the panel leaves");
  });

  it("the head and body have no centred cap and the column leaves its right padding to the panel", () => {
    const audiobook = mentioning(responsive, '[data-view="audiobook"]');
    assert.ok(audiobook.some((rule) => rule.selector.endsWith(".fy-sw__centre") && rule.body === "padding-right: 0;"));
    assert.ok(audiobook.some((rule) => rule.selector.endsWith(".fy-ch__body") && rule.body === "gap: 0;"));
    assert.ok(audiobook.every((rule) => !/margin-inline: auto/.test(rule.body)), "nothing in the Audiobook view centres itself against a cap");
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
