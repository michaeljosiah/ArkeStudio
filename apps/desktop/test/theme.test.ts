import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme, themePalette } from "../src/theme.js";

describe("desktop appearance", () => {
  it("resolves system live while explicit preferences ignore the system", () => {
    assert.equal(resolveTheme("system", true), "dark");
    assert.equal(resolveTheme("system", false), "light");
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("dark", false), "dark");
  });

  it("uses matching window and title-bar colors", () => {
    assert.deepEqual(themePalette("light"), {
      background: "#FFFFFF",
      overlay: "#FFFFFF",
      symbols: "#0A0A0A",
    });
    assert.deepEqual(themePalette("dark"), {
      background: "#0A0A0A",
      overlay: "#0A0A0A",
      symbols: "#FAFAFA",
    });
  });
});
