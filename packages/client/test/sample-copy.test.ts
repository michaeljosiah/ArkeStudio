import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SENTENCE_HINT } from "../src/screens/world.js";

/**
 * The sample world stays in the sample world (issue 1006).
 *
 * The Undersong is what this application was designed against, and it ships as a world a user can
 * install and ruin. It is not the world they are in. Where its copy was used as live placeholder
 * text, a Nigerian boarding-school horror was told about harbours and drowned gods, and the app
 * appeared to be proposing a subject rather than describing a field.
 *
 * Two rules, because the leak arrived in two shapes: words, and a drawing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../src");
const PREVIEWS = join(here, "../public/art-styles");

/**
 * The sample world's own vocabulary. Proper nouns first, then the motifs that only mean anything
 * inside it — a placeholder mentioning a tide-clock is as much of a leak as one naming Maren.
 */
const SAMPLE_WORDS = [
  "undersong", "maren", "kest", "bray", "chorister", "saltlight", "odile", "sereth",
  "harbour", "tide", "drowned", "ferryman", "chandlery", "brine", "tide-caller",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

/** The screen that installs the sample world is about it, so it may name it. */
const ABOUT_THE_SAMPLE = join("screens", "shell.tsx");

describe("the sample world stays in the sample world", () => {
  it("puts none of its words in a placeholder", () => {
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      if (relative(SRC, path) === ABOUT_THE_SAMPLE) continue;
      for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
        if (!line.includes("placeholder")) continue;
        const said = SAMPLE_WORDS.filter((word) => line.toLowerCase().includes(word));
        if (said.length > 0) offenders.push(`${relative(SRC, path).split(sep).join("/")}:${index + 1} — ${said.join(", ")}`);
      }
    }
    assert.deepEqual(offenders, [], `sample-world copy used as a placeholder:\n  ${offenders.join("\n  ")}`);
  });

  it("asks each kind of sheet for the sentence that kind actually needs", () => {
    // One field served characters, locations and factions, and its example described a
    // character — so a location was asked to be a ferryman.
    for (const [kind, hint] of Object.entries(SENTENCE_HINT)) {
      assert.ok(hint.trim().length > 0, `${kind} says something`);
      assert.equal(
        SAMPLE_WORDS.some((word) => hint.toLowerCase().includes(word)),
        false,
        `${kind} names nothing from the sample world`,
      );
    }
    assert.equal(new Set(Object.values(SENTENCE_HINT)).size, 3, "each kind is asked its own question");
  });

  it("draws one scene nine ways, and that scene is nobody's", () => {
    // Holding the subject constant is the whole reason this step is a grid: it is what lets a
    // person compare the treatment rather than the subject. Holding *the sample world's*
    // lighthouse constant was an accident of where the drawing came from.
    const files = readdirSync(PREVIEWS).filter((name) => name.endsWith(".svg"));
    assert.equal(files.length, 9, "nine previews, one per preset");
    const lighthouse = ["44,80 47,34 55,34 58,80", 'x="45.5" y="28"', 'cy="31"'];
    for (const name of files) {
      const svg = readFileSync(join(PREVIEWS, name), "utf8");
      for (const shape of lighthouse) {
        assert.equal(svg.includes(shape), false, `${name} still draws the sample world's lighthouse`);
      }
      // The scene itself is still shared, which is what makes the nine comparable.
      assert.ok(svg.includes("0,72 34,58 62,70"), `${name} keeps the common horizon`);
    }
  });
});
