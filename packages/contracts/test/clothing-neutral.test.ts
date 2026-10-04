import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { namesExposure, neutralClothing } from "../src/reference.js";
import { pictureRefusal } from "../src/audiobook-illustrate.js";

/**
 * Clothing named neutrally (2026-10-04, after testing 0.5.60-local.14): three pictures of Ife at
 * the club table and her close view were refused by the image provider's safety check. Their words
 * repeated her look line's `bare shoulders`, `low-backed silk slip dress` and `beneath her braids`
 * while the look image, the same dress, rode as the reference. The garment and its colour are
 * named; the skin, the cut and the body are not.
 */

const IFE = "She wears long knotless braids gathered off her neck in a low twist (not straight hair), a low-backed cream-gold silk slip dress, bare shoulders, heavy old-gold hoop earrings and stacked old-gold bangles, gold strappy heeled sandals, a small structured gold clutch in one hand and a phone in the other.";

describe("neutralClothing", () => {
  it("names Ife's dress by its garment and colour, keeps every other thing she wears, and drops the bare shoulders", () => {
    const said = neutralClothing(IFE);
    assert.equal(
      said,
      "She wears long knotless braids gathered off her neck in a low twist (not straight hair), a cream-gold silk evening dress, heavy old-gold hoop earrings and stacked old-gold bangles, gold strappy heeled sandals, a small structured gold clutch in one hand and a phone in the other.",
    );
    assert.equal(namesExposure(said), false);
  });

  it("takes the cut and the skin out of a drafted prompt and leaves its action and its expression", () => {
    const said = neutralClothing("Medium two-shot across the low table of a leather booth. Ife, in a low-backed cream-gold silk slip dress with bare shoulders, turns her glass slowly on the table, her back bare beneath her braids, her eyes on Ade, calm and direct. Purple club light.");
    assert.equal(said, "Medium two-shot across the low table of a leather booth. Ife, in a cream-gold silk evening dress, turns her glass slowly on the table, her eyes on Ade, calm and direct. Purple club light.");
    for (const words of ["bare", "low-backed", "slip dress", "beneath her braids"]) assert.ok(!said.includes(words), words);
  });

  it("leaves clothing that shows nothing, and words that only sound like a cut, as they are", () => {
    for (const line of ["Oilskin coat, dark and stiff with salt; hood up, two braids.", "Harbour coat, bare head.", "Maren, clinging to the rail, looks down a sheer drop as the road curves away.", "A slit of light under the door."]) {
      assert.equal(neutralClothing(line), line);
    }
  });

  it("drops a clause that is only skin and keeps a garment its cut is taken from", () => {
    assert.equal(neutralClothing("A strapless red gown with a thigh-high slit, bare legs, silver heels."), "A red gown, silver heels.");
  });

  it("keeps the jewellery, shoes or hair a clause about skin also names (codex on PR 1559)", () => {
    assert.equal(neutralClothing("A green wrapper, bare arms stacked with old-gold bangles, gold sandals."), "A green wrapper, stacked with old-gold bangles, gold sandals.");
    assert.equal(neutralClothing("Ife turns, her back bare beneath her braids, and smiles."), "Ife turns, and smiles.");
    assert.equal(neutralClothing("A black gown, bare arms in elbow-length white gloves."), "A black gown, in elbow-length white gloves.", "a thing worn that no list names is kept");
  });
});

describe("pictureRefusal", () => {
  it("says a safety refusal in plain words, whichever provider made it", () => {
    assert.equal(pictureRefusal("openai: the safety system refused the picture it made (moderation blocked) — recompose the prompt away from what it flagged and try again"), "refused by the image safety check");
    assert.equal(pictureRefusal("HTTP 400: Your request was rejected by the safety system"), "refused by the image safety check");
  });

  it("keeps the first clause of any other reason, without its provider", () => {
    assert.equal(pictureRefusal("openai: rate limited — try again in a minute"), "rate limited");
    assert.equal(pictureRefusal(""), "not made");
  });
});
