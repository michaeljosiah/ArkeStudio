import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The main window's `webPreferences`, read at the source.
 *
 * Nothing here can construct a `BrowserWindow` — Electron is not running under the test runner —
 * and these flags show their effect only in the packaged app. That is where a defaulted-off
 * `plugins` sat unseen until a PDF opened as an empty frame (issue 530). A source read is cheap
 * and names the regression; the alternative is a twenty-minute package run finding out.
 */
const source = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "src", "main.ts"),
  "utf8",
);
const preferences = /\n {4}webPreferences: \{\n([\s\S]*?)\n {4}\},\n/.exec(source)?.[1] ?? "";

describe("the main window's webPreferences", () => {
  it("is where this test is looking", () => {
    assert.notEqual(preferences, "", "the webPreferences block moved; every assertion below is vacuous");
  });

  it("turns Chromium's PDF viewer on", () => {
    // Electron defaults `plugins` to false, and that flag is the whole of whether an
    // `application/pdf` response has anything in the renderer to draw it.
    assert.match(preferences, /^ +plugins: true,$/m);
  });

  it("keeps the renderer confined while it does", () => {
    // Naming them here so the line above can never be widened into a general relaxation by
    // someone reaching for the same block to make something else load.
    for (const flag of ["contextIsolation: true", "nodeIntegration: false", "sandbox: true"]) {
      assert.match(preferences, new RegExp(`^ +${flag},$`, "m"), `webPreferences must keep ${flag}`);
    }
    assert.equal(/\bwebSecurity: false\b/.test(preferences), false, "web security stays on");
  });
});
