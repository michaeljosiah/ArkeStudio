import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One stylesheet, one owner per class name (2026-08-23).
 *
 * `fidelity.css` is global and flat: no modules, no scoping, and every rule is a bare class
 * selector. Two screens that reach for the same name do not conflict loudly — the one lower in
 * the file wins at equal specificity, silently, for both of them.
 *
 * Found by looking at a screenshot. Turn 97's shot drawer declared `.fy-sheet`, `.fy-sheet__main`
 * and `.fy-sheet__side`, which the character sheet had owned since long before, and sat lower in
 * the file. The character page lost its 64px gutter to `gap: 0` and got a 320px rail around a
 * 360px card: caption clipped mid-word, a horizontal scrollbar under the rail, and the card's
 * note landing on top of the prose. Nothing was wrong with either rule. They were both right for
 * one screen and there was only one name.
 *
 * What it flags is narrow on purpose: the same bare selector declared twice at the top level
 * *and* setting a property both times. A split declaration that only adds — `.fy-scrub` picking
 * up a `cursor` forty lines later — overwrites nothing and belongs to one screen; four of those
 * exist and none of them is a bug. An overlapping one is the `.fy-sheet` shape, where the later
 * rule quietly decides a value the earlier rule already chose.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CSS = join(here, "../src/screens/fidelity.css");

interface Declared {
  line: number;
  /** The property names this rule sets, so an overwrite can be told from an addition. */
  properties: Set<string>;
}

/** Top-level bare single-class rules only: `.foo { … }`, never `.dark .foo` or `.foo:hover`. */
function bareClassRules(css: string): Map<string, Declared[]> {
  const found = new Map<string, Declared[]>();
  let depth = 0;
  let line = 1;
  let buffer = "";
  // Comments are skipped in place rather than stripped first, so the reported line is the line a
  // person opens the file to — a lint whose numbers are off by the length of the licence header
  // sends you to the wrong rule and gets ignored.
  let inComment = false;
  let open: { selector: string; line: number } | null = null;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i]!;
    if (ch === "\n") line += 1;
    if (inComment) {
      if (ch === "*" && css[i + 1] === "/") {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      inComment = true;
      i += 1;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        const selector = buffer.trim();
        // One class, nothing else: no descendant, no combinator, no pseudo, no attribute.
        open = /^\.[a-zA-Z0-9_-]+$/.test(selector) ? { selector, line } : null;
      }
      depth += 1;
      buffer = "";
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && open) {
        const properties = new Set(
          buffer
            .split(";")
            .map((piece) => piece.split(":")[0]?.trim().toLowerCase() ?? "")
            .filter((name) => /^[a-z-]+$/.test(name)),
        );
        const at = found.get(open.selector) ?? [];
        at.push({ line: open.line, properties });
        found.set(open.selector, at);
        open = null;
      }
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  return found;
}

describe("the global stylesheet", () => {
  const css = readFileSync(CSS, "utf8");

  it("never lets one rule silently redecide another's property", () => {
    const clashes: string[] = [];
    for (const [selector, rules] of bareClassRules(css)) {
      for (let a = 0; a < rules.length; a += 1) {
        for (let b = a + 1; b < rules.length; b += 1) {
          const both = [...rules[a]!.properties].filter((name) => rules[b]!.properties.has(name));
          if (both.length > 0) {
            clashes.push(
              `${selector}: line ${rules[b]!.line} redecides ${both.join(", ")} set at line ${rules[a]!.line}`,
            );
          }
        }
      }
    }
    assert.deepEqual(clashes, [], `\n  ${clashes.join("\n  ")}`);
  });

  it("keeps the character sheet's own layout, which is the one that regressed", () => {
    const rules = bareClassRules(css);
    for (const owned of [".fy-sheet", ".fy-sheet__side", ".fy-sheet__main"]) {
      assert.equal(rules.get(owned)?.length, 1, `${owned} is declared by one screen only`);
    }
    // The gutter and the content-sized rail are the two the shot drawer overwrote.
    assert.match(css, /\.fy-sheet \{[^}]*gap: 64px/, "the character sheet keeps its gutter");
    assert.match(css, /\.fy-sheet__side \{[^}]*flex: none/, "and a rail sized to its own card");
    assert.ok(
      !/\.fy-sheet__side \{[^}]*width: 320px/.test(css),
      "and no fixed width narrower than the 360px card it holds",
    );
  });
});
