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
