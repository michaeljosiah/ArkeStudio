import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { Loading } from "../src/components/loading.js";

/**
 * The house loader — one of the ten drawn in design-system/loading.html, adopted for every wait
 * in the app. Its reduced-motion state (a solid letter that still pulses, because the loader is
 * often the only sign that paid work is in flight) is a stylesheet rule with its reasons beside
 * it in fidelity.css; a browser is the only thing that can check it.
 */

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

});
