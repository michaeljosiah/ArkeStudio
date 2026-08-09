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

  it("declares a reduced-motion state that still says something is happening", () => {
    // Two shipped bugs guard this rule. First: the global reduced-motion flatten only shortens
    // the animation, and the mark's base style is a gradient offset behind clipped text —
    // stopped mid-ramp, one side of the letter stays pale. Second (build test, 2026-08-09):
    // a perfectly still A reads as a hang, and Windows "animation effects off" reports reduced
    // motion for the whole app — so the sweep goes, but a slow opacity pulse stays, because the
    // loader is often the only signal that paid work is in flight.
    const i = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
    assert.ok(i > 0, "the loader has its own reduced-motion rule");
    const markInMedia = CSS.indexOf(".fy-loading__mark", i);
    assert.ok(markInMedia > 0, "and it addresses the mark");
    const block = CSS.slice(markInMedia, CSS.indexOf("}", markInMedia));
    assert.ok(block.includes("background: none"), "the gradient is cleared, not left part-way along");
    assert.ok(block.includes("color: var(--foreground)"), "and the letter is solid");
    assert.ok(
      block.includes("fy-loading-pulse") && block.includes("!important"),
      "and it pulses — the global flatten is !important, so this must be too",
    );
    assert.ok(CSS.includes("@keyframes fy-loading-pulse"), "the pulse keyframes exist");
  });
});
