import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { manuscriptReviewFont } from "../../src/productions/manuscript-review-pdf.js";

const source = new URL("../../src/productions/manuscript-review-pdf.ts", import.meta.url).href;
// `dist/main.cjs` with `dist/fonts` beside it, as apps/desktop/scripts/build.mjs lays the bundle out.
const bundled = new URL("../../src/publications/main.cjs", import.meta.url).href;

it("finds the report's font from source and from the packaged bundle (issue 2528)", () => {
  assert.ok(existsSync(manuscriptReviewFont(source)));
  assert.ok(existsSync(manuscriptReviewFont(bundled)));
  assert.equal(manuscriptReviewFont(bundled), fileURLToPath(new URL("./fonts/DejaVuSans.ttf", bundled)));
});
