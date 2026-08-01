import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fallbackSlug, slugify, uniqueSlug } from "../../src/world/slug.js";

describe("slugification (R-7, R-8)", () => {
  it("lowercases, hyphenates and trims", () => {
    assert.equal(slugify("Maren Kest"), "maren-kest");
    assert.equal(slugify("  The   Verse -- Rises!  "), "the-verse-rises");
  });

  it("transliterates common Latin diacritics", () => {
    assert.equal(slugify("Éowyn Kèst"), "eowyn-kest");
    assert.equal(slugify("Søren Åberg"), "soren-aberg");
    assert.equal(slugify("Straße"), "strasse");
  });

  it("escapes every Windows reserved device name", () => {
    for (const name of ["CON", "PRN", "AUX", "NUL", "Nul", "COM1", "com9", "LPT0", "lpt9"]) {
      const slug = slugify(name);
      assert.doesNotMatch(slug, /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/, `${name} → ${slug} must not be reserved`);
      assert.match(slug, /^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it("produces legal filenames from forbidden characters and trailing dots/spaces", () => {
    assert.equal(slugify('a<b>c:d"e/f\\g|h?i*j'), "a-b-c-d-e-f-g-h-i-j");
    assert.equal(slugify("name."), "name");
    assert.equal(slugify("name  "), "name");
  });

  it("caps slug length at 48", () => {
    const slug = slugify("x".repeat(200));
    assert.ok(slug.length <= 48);
  });

  it("falls back for unslugifiable names, keeping the display name elsewhere (R-9)", () => {
    assert.equal(slugify("🌊🌊🌊"), "");
    const fb = fallbackSlug("character");
    assert.match(fb, /^character-[0-9a-z]{8}$/);
    const unique = uniqueSlug("🌊🌊🌊", "character", []);
    assert.match(unique, /^character-[0-9a-z]{8}$/);
  });

  it("resolves collisions case-insensitively — NTFS is (D4)", () => {
    assert.equal(uniqueSlug("Maren Kest", "character", ["other"]), "maren-kest");
    assert.equal(uniqueSlug("maren kest", "character", ["Maren-Kest"]), "maren-kest-2");
    assert.equal(uniqueSlug("MAREN KEST", "character", ["maren-kest", "maren-kest-2"]), "maren-kest-3");
  });

  it("keeps collision suffixes within the length cap", () => {
    const long = "x".repeat(60);
    const first = uniqueSlug(long, "character", []);
    const second = uniqueSlug(long, "character", [first]);
    assert.ok(second.length <= 48);
    assert.notEqual(first, second);
  });
});
