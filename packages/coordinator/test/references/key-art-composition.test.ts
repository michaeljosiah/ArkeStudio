import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResolvedArtDirection, WorldMeta } from "@arke-studio/contracts";
import { bibleExcerpt, keyArtComposition } from "../../src/references/key-art-references.js";

/*
 * Read from a real founding build (issue 906): the sent prompt ended a clause `soundtrack..`,
 * carried `**` from the bible, and cut it mid-sentence — `...say out loud that The image:` —
 * because the fallback position outranked the last sentence end whenever that end was more
 * than eighty characters back.
 */
describe("the key-art composition (issue 906)", () => {
  it("cuts the bible at the last sentence inside the budget, however far back that is", () => {
    const first = "The horror is that nobody will say it out loud.";
    const long = `${first} ${"x".repeat(600)}`;
    assert.equal(bibleExcerpt(long, 500), first);
  });

  it("falls back to a word boundary only when no sentence ends inside the budget", () => {
    const words = Array.from({ length: 200 }, (_, index) => `word${index}`).join(" ");
    const excerpt = bibleExcerpt(words, 100);
    assert.ok(excerpt.length <= 101, "the budget plus the ellipsis");
    assert.match(excerpt, /^word\d+( word\d+)*…$/);
  });

  it("flattens markdown before an image model can read the asterisks", () => {
    const bible = "# The forty-first name\n\n**The horror** is _quiet_. It is `plain`.\n\n- a list\n> a quote";
    assert.equal(bibleExcerpt(bible), "The horror is quiet. It is plain. a list a quote");
  });

  it("never doubles a full stop between clauses", () => {
    const prompt = keyArtComposition({
      meta: {
        name: "The Forty-First Name",
        logline: "Only the name on the page and the answer on the soundtrack.",
        tone: "hushed, exact.",
      } as WorldMeta,
      direction: { description: "Sodium light, ruled paper, one lamp." } as ResolvedArtDirection,
      bible: "",
      brief: { subject: "A hand on a bedframe.", moment: "Lights-out roll call.", stakes: "Whose name is missing.", characters: [] },
      cast: [],
    });
    assert.ok(!prompt.includes(".."), prompt);
    assert.ok(prompt.includes("one lamp. Only the name on the page and the answer on the soundtrack. Tone: hushed, exact."), prompt);
    assert.ok(prompt.includes("The image: A hand on a bedframe. The moment: Lights-out roll call. At stake: Whose name is missing."), prompt);
  });
});
