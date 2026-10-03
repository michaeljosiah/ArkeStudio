import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChapterAudiobookSchema } from "../src/audiobook.js";
import {
  AudiobookLookSchema,
  editLook,
  lookDigest,
  lookKey,
  lookLinesFor,
  mergeLook,
  pictureLookChanged,
  pictureLookFor,
  type AudiobookLook,
} from "../src/audiobook-look.js";
import { AudiobookPictureSchema } from "../src/audiobook-pictures.js";

/**
 * The look of a chapter (design turn 191c, SPEC-047 R-98): lines read from the prose, the author's
 * own never replaced by a derive, and a picture that remembers which lines it was made under.
 */

const AT = "2026-10-03T09:00:00.000Z";
const LATER = "2026-10-04T09:00:00.000Z";
const stamp = { chapterHash: "h1", at: LATER };

const LOOK: AudiobookLook = {
  chapterHash: "h1",
  at: AT,
  place: { text: "The flooded quarter, dusk.", blocks: ["p0.0"] },
  characters: {
    "maren-kest": { name: "Maren", sheet: "maren-kest", text: "Oilskin coat.", blocks: ["p1.0"] },
    sereth: { name: "Sereth", text: "Blue greatcoat.", by: "author" },
  },
};

describe("who a line is about", () => {
  it("keys a character by the sheet, else the name as the prose gives it", () => {
    assert.equal(lookKey({ sheet: "maren-kest", name: "Maren" }), "maren-kest");
    assert.equal(lookKey({ name: "  The  Harbour Master " }), "the harbour master");
  });
});

describe("a derive laid over the look the chapter holds", () => {
  it("leaves the author's lines as they are, replaces Arke's, drops a derived character not found again and adds a new one", () => {
    const { look, kept } = mergeLook(
      LOOK,
      { place: { text: "Dawn." }, characters: [{ key: "sereth", name: "Sereth", text: "Something else." }, { key: "odile", name: "Odile", text: "Grey wool." }] },
      stamp,
    );
    assert.equal(kept, 1, "the author's line is counted as kept");
    assert.equal(look.characters["sereth"]!.text, "Blue greatcoat.", "the author's line stands over the derive");
    assert.equal(look.characters["sereth"]!.by, "author");
    assert.equal(look.characters["maren-kest"], undefined, "a derived character the new reading does not find is gone");
    assert.equal(look.characters["odile"]!.text, "Grey wool.");
    assert.equal(look.place!.text, "Dawn.", "Arke's place is replaced");
    assert.equal(look.chapterHash, "h1");
    assert.equal(look.at, LATER);
  });

  it("keeps an author's place, and an author's character the new reading never finds", () => {
    const held: AudiobookLook = { ...LOOK, place: { text: "My place.", by: "author" } };
    const { look, kept } = mergeLook(held, { place: { text: "Theirs." }, characters: [] }, stamp);
    assert.equal(look.place!.text, "My place.");
    assert.ok(look.characters["sereth"]);
    assert.equal(kept, 2);
  });

  it("reads a look from nothing", () => {
    const { look, kept } = mergeLook(null, { place: { text: "Dusk.", blocks: ["p0.0"] }, characters: [{ key: "a", name: "A", text: "Coat.", blocks: [] }] }, stamp);
    assert.equal(kept, 0);
    assert.deepEqual(look.characters["a"], { name: "A", text: "Coat." }, "an empty list of blocks is no field");
    assert.ok(AudiobookLookSchema.safeParse(look).success);
  });
});

describe("a line the author writes", () => {
  it("becomes the author's, keeping the blocks it was read from", () => {
    const next = editLook(LOOK, { kind: "character", key: "maren-kest" }, "  Her father's   jacket. ", stamp)!;
    assert.deepEqual(next.characters["maren-kest"], { name: "Maren", sheet: "maren-kest", text: "Her father's jacket.", blocks: ["p1.0"], by: "author" });
    assert.equal(next.at, LATER);
  });

  it("changes nothing when the words are the same, so a press in and out of a field is not an edit", () => {
    assert.equal(editLook(LOOK, { kind: "character", key: "maren-kest" }, "Oilskin coat.", stamp), null);
    assert.equal(editLook(LOOK, { kind: "place" }, "The flooded quarter, dusk.", stamp), null);
    assert.equal(editLook(LOOK, { kind: "character", key: "nobody" }, null, stamp), null);
  });

  it("takes a line away, or adds a character the look missed under the name it is given", () => {
    const gone = editLook(LOOK, { kind: "character", key: "maren-kest" }, null, stamp)!;
    assert.equal(gone.characters["maren-kest"], undefined);
    assert.equal(editLook(LOOK, { kind: "place" }, "", stamp)!.place, undefined);
    const added = editLook(LOOK, { kind: "character", key: "odile", name: "Odile", sheet: "odile" }, "Grey wool.", stamp)!;
    assert.deepEqual(added.characters["odile"], { name: "Odile", sheet: "odile", text: "Grey wool.", by: "author" });
    assert.equal(editLook(LOOK, { kind: "character", key: "odile" }, "Grey wool.", stamp), null, "a new character with no name is nobody");
  });

  it("starts a look where the chapter has none", () => {
    const first = editLook(null, { kind: "place" }, "Dusk.", stamp)!;
    assert.deepEqual(first, { chapterHash: "h1", at: LATER, characters: {}, place: { text: "Dusk.", by: "author" } });
  });

  it("holds a line to the bound", () => {
    const next = editLook(LOOK, { kind: "place" }, "x".repeat(900), stamp)!;
    assert.equal(next.place!.text.length, 400);
  });
});

describe("the look a picture was made under", () => {
  it("takes the place and then each person's line, leaving out a person the look holds nothing for", () => {
    assert.deepEqual(lookLinesFor(LOOK, ["sereth", "ghost", "maren-kest"]).map((line) => [line.label, line.text]), [["Place", "The flooded quarter, dusk."], ["Sereth", "Blue greatcoat."], ["Maren", "Oilskin coat."]]);
    assert.deepEqual(lookLinesFor(null, ["sereth"]), []);
  });

  it("marks a picture `look changed` only when the lines for the people in it have changed", () => {
    const made = pictureLookFor(LOOK, ["maren-kest"])!;
    assert.equal(pictureLookChanged(made, LOOK), false);
    const sereth = editLook(LOOK, { kind: "character", key: "sereth" }, "A different coat.", stamp)!;
    assert.equal(pictureLookChanged(made, sereth), false, "another character's coat is not this picture's");
    const maren = editLook(LOOK, { kind: "character", key: "maren-kest" }, "A red coat.", stamp)!;
    assert.equal(pictureLookChanged(made, maren), true);
    const place = editLook(LOOK, { kind: "place" }, "Dawn.", stamp)!;
    assert.equal(pictureLookChanged(made, place), true, "the place is in every picture");
    assert.equal(pictureLookChanged(undefined, maren), false, "a picture made with no look is never marked");
  });

  it("is the same digest whatever the whitespace", () => {
    assert.equal(lookDigest([{ key: "a", text: "A  coat" }]), lookDigest([{ key: "a", text: " A coat " }]));
    assert.notEqual(lookDigest([{ key: "a", text: "A coat" }]), lookDigest([{ key: "b", text: "A coat" }]));
  });

  it("rides on a picture and on the chapter's record, absent where there is none", () => {
    const picture = { file: "artifacts/a.png", source: "generated", textHash: "t", at: AT, look: pictureLookFor(LOOK, ["maren-kest"]) };
    assert.ok(AudiobookPictureSchema.safeParse(picture).success);
    const record = { schemaVersion: 1, chapterVersion: 1, hash: "h", updatedAt: AT, takes: {}, flags: {}, direction: {}, look: LOOK, pictures: { "p1.0": picture } };
    assert.ok(ChapterAudiobookSchema.safeParse(record).success);
    const { look: _look, ...without } = record;
    assert.ok(ChapterAudiobookSchema.safeParse(without).success, "a record with no look reads as before");
    assert.equal(ChapterAudiobookSchema.safeParse({ ...record, look: { ...LOOK, stray: true } }).success, false, "a field this build does not know is unreadable, which is why the world is raised");
  });
});
