import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMIC_STYLE_WORDS_MAX, ComicStyleSchema } from "@arke-studio/contracts";
import { COMIC_STYLE_PRESETS, chooseComicStyle, comicStylePicture, draftFromStyle, styleFromDraft } from "../src/lib/comic-styles.js";

/** A graphic novel's styles (design turn 248, SPEC-064 R-21a): the cards, and what a choice saves as. */
describe("comic styles (turn 248)", () => {
  it("nine presets in the drawn order, each with its page on disk by a relative path", () => {
    assert.deepEqual(COMIC_STYLE_PRESETS.map((preset) => preset.name), ["Manga", "Superhero", "Clean line", "Noir", "Webtoon", "Painted", "Watercolour", "Ink and wash", "Vintage print"]);
    for (const preset of COMIC_STYLE_PRESETS) {
      const picture = comicStylePicture(preset.id);
      assert.ok(picture.startsWith("./"), "file:// would read a leading slash as the disk's root");
      assert.ok(existsSync(join("public", picture)), `${picture} ships with the app`);
      assert.ok(ComicStyleSchema.safeParse({ words: preset.words, preset: preset.id }).success, `${preset.id} saves as it seeds`);
      assert.ok(preset.words.length <= COMIC_STYLE_WORDS_MAX);
    }
  });

  it("a card seeds its words; World look and Your own start empty", () => {
    assert.match(chooseComicStyle("noir").words, /^Crime noir comic/);
    assert.equal(chooseComicStyle("world").words, "");
    assert.equal(chooseComicStyle("own").words, "");
  });

  it("World look, or empty words, saves as no style; an edited preset keeps its card", () => {
    assert.equal(styleFromDraft({ choice: "world", words: "ignored" }), null);
    assert.equal(styleFromDraft({ choice: "own", words: "   " }), null);
    assert.deepEqual(styleFromDraft({ choice: "noir", words: " Noir, rain. " }), { words: "Noir, rain.", preset: "noir" });
    assert.deepEqual(styleFromDraft({ choice: "own", words: "Mine." }), { words: "Mine." });
  });

  it("reads a stored style back; a preset this build does not have reads as Your own", () => {
    assert.deepEqual(draftFromStyle(undefined), { choice: "world", words: "" });
    assert.deepEqual(draftFromStyle({ words: "Manga.", preset: "manga" }), { choice: "manga", words: "Manga." });
    assert.deepEqual(draftFromStyle({ words: "Old.", preset: "retired-style" }), { choice: "own", words: "Old." });
  });
});
