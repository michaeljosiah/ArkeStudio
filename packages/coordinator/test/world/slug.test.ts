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

  it("cuts a long name at the last whole word that fits (issue 3097)", () => {
    const title = "Why You Do Me Like That — Na Love or Juju music video";
    assert.equal(slugify(title), "why-you-do-me-like-that-na-love-or-juju-music");
    // A word that ends exactly at the cap is kept whole.
    assert.equal(slugify(`${"a".repeat(43)} bcde fgh`), `${"a".repeat(43)}-bcde`);
    // Taken, the suffix makes room by whole words too.
    assert.equal(uniqueSlug(title, "production", ["why-you-do-me-like-that-na-love-or-juju-music"]), "why-you-do-me-like-that-na-love-or-juju-music-2");
    const longer = "Why You Do Me Like That Now — Na Love or Juju music video";
    const first = uniqueSlug(longer, "production", []);
    assert.equal(first, "why-you-do-me-like-that-now-na-love-or-juju");
    assert.equal(uniqueSlug(longer, "production", [first]), "why-you-do-me-like-that-now-na-love-or-juju-2");
    // One short word before a long one keeps the long one's start rather than shrinking to "a".
    assert.equal(slugify(`a ${"x".repeat(60)}`), `a-${"x".repeat(46)}`);
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

  it("never gives a chapter the audiobook credits' id (design turn 252, codex on PR 2274)", () => {
    assert.equal(uniqueSlug("Audiobook Credits", "chapter", []), "audiobook-credits-2");
    assert.equal(uniqueSlug("Audiobook Credits", "character", []), "audiobook-credits", "only a chapter's id is the credits'");
  });

  it("keeps collision suffixes within the length cap", () => {
    const long = "x".repeat(60);
    const first = uniqueSlug(long, "character", []);
    const second = uniqueSlug(long, "character", [first]);
    assert.ok(second.length <= 48);
    assert.notEqual(first, second);
  });
});
