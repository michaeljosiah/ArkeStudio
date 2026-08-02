import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { Loading } from "../src/components/loading.js";

/**
 * The house loader — one of the ten drawn in design-system/loading.html, adopted for every wait
 * in the app.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, "../src/screens/fidelity.css"), "utf8");

describe("the house loader", () => {
  it("says what is being waited on, and announces itself", () => {
    const html = renderToString(<Loading label="opening the world" />);
    assert.ok(html.includes("fy-loading__mark"), "the mark is drawn");
    assert.ok(html.includes("opening the world"), "and the subject is named — a loader without one is a shrug");
    assert.ok(html.includes('role="status"'), "a screen reader is told a wait started");
  });

  it("is the same mark inline as it is alone", () => {
    const alone = renderToString(<Loading label="x" />);
    const inline = renderToString(<Loading label="x" inline />);
    assert.ok(inline.includes("fy-loading--inline"), "the inline form is a modifier");
    assert.ok(alone.includes("fy-loading__mark") && inline.includes("fy-loading__mark"), "not a second drawing");
  });

  it("declares a stopped state rather than inheriting one", () => {
    // The nearly-shipped bug: the global reduced-motion rule only shortens the animation, and the
    // mark's base style is a gradient offset behind clipped text. Stopped mid-ramp, one side of
    // the letter stays pale — a half-faded loader for the person who asked for less motion. The
    // resting state has to be written, and this is what keeps it written.
    const i = CSS.indexOf("@media (prefers-reduced-motion: reduce) {\n  .fy-loading__mark");
    assert.ok(i > 0, "the loader has its own reduced-motion rule");
    const block = CSS.slice(i, CSS.indexOf("}", CSS.indexOf(".fy-loading__mark", i)));
    assert.ok(block.includes("background: none"), "the gradient is cleared, not left part-way along");
    assert.ok(block.includes("color: var(--foreground)"), "and the letter is solid");
  });
});
