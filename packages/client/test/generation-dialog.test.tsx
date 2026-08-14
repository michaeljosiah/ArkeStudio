import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The standard dialog an image generation is asked for in.
 *
 * Three decisions, one arrangement: the words, a picture to look at, and who makes it. The point
 * of writing it once is that the next screen to generate something does not get to invent a
 * fourth arrangement of the same three — so these assertions are mostly about there being one
 * implementation, which is the property that decays.
 */

const here = dirname(fileURLToPath(import.meta.url));
const shared = readFileSync(join(here, "../src/components/generation-dialog.tsx"), "utf8");

describe("generation dialog", () => {
  it("asks for the words, a reference and the model, in that order", () => {
    const order = ['className="fy-gendialog__prompt"', 'className="fy-gendialog__reference"', "<DispatchBar"].map(
      (mark) => shared.indexOf(mark),
    );
    assert.ok(
      order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)),
      "prompt, then reference, then model",
    );
  });

  it("is the only place a generation dialog is built", () => {
    // A <dialog> on a screen means a second arrangement of the same three decisions is growing.
    const screens = join(here, "../src/screens");
    for (const file of readdirSync(screens).filter((name) => name.endsWith(".tsx"))) {
      const source = readFileSync(join(screens, file), "utf8");
      assert.ok(
        !source.includes("showModal()"),
        `screens/${file} should generate through GenerationDialog, not its own <dialog>`,
      );
    }
    assert.ok(shared.includes("showModal()"), "the shared component is the one that opens it");
  });

  it("returns focus to whatever opened it, and dismisses on a backdrop click", () => {
    assert.ok(
      shared.includes("returnFocus?.current?.focus()"),
      "closing a dialog that dropped focus leaves the keyboard at the top of the document",
    );
    assert.ok(
      shared.includes("event.target === event.currentTarget"),
      "a click on the dialog itself rather than its panel is the backdrop",
    );
  });

  /*
   * The host sends; the dialog arranges. A component that called the store itself would decide
   * what every screen using it is allowed to ask for, which is the whole reason the last three
   * generate buttons were written separately.
   */
  it("sends nothing itself", () => {
    assert.ok(!/from "\.\.\/lib\/store\.js"/.test(shared), "no store import, so no message of its own");
  });

  it("will not submit an empty prompt", () => {
    assert.ok(shared.includes("prompt.trim().length === 0"), "an empty brief is not a brief");
  });
});
