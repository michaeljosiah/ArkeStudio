import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChapterAudiobookSchema } from "../src/audiobook.js";
import {
  AudiobookLookSchema,
  PictureLookSchema,
  chooseLook,
  cutMoodClothing,
  editLook,
  frameWord,
  lookViewFor,
  lookDigest,
  lookLinesFor,
  lookNeedsChoiceBoundary,
  mergeLook,
  pictureLookChanged,
  pictureLookFor,
  pictureMood,
  type AudiobookLook,
} from "../src/audiobook-look.js";
import { CharacterLookSchema, ReferenceKitSchema, chapterLooksOf, lookClothing, lookName, lookOlderFace, type ReferenceKit } from "../src/reference.js";

/**
 * Looks per character (design turn 193, SPEC-047 R-112..R-117): a kit look chosen by pointer, the
 * mood line, the look a picture rode, and the choice carried into a later chapter.
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

const CHOSEN: AudiobookLook = {
  ...LOOK,
  characters: {
    ...LOOK.characters,
    "maren-kest": { name: "Maren", sheet: "maren-kest", text: "Storm coat, hood up; two braids.", blocks: ["p1.0"], lookId: "tk_storm", reading: "Oilskin coat.", conflicts: [{ kind: "chapter", part: "Hood", a: "down", b: "up" }] },
  },
};

describe("a look chosen for a character", () => {
  it("makes the character's line the look's own words and keeps what the chapter said beside it", () => {
    const next = chooseLook(LOOK, { key: "maren-kest" }, { lookId: "tk_storm", text: "Storm coat, hood up; two braids." }, stamp)!;
    assert.deepEqual(next.characters["maren-kest"], { name: "Maren", sheet: "maren-kest", text: "Storm coat, hood up; two braids.", blocks: ["p1.0"], lookId: "tk_storm", reading: "Oilskin coat." });
    assert.equal(next.at, LATER);
    assert.ok(AudiobookLookSchema.safeParse(next).success);
  });

  it("changes nothing when the same look is chosen again, and goes back to the chapter's words when it is taken away", () => {
    assert.equal(chooseLook(CHOSEN, { key: "maren-kest" }, { lookId: "tk_storm", text: "Storm coat, hood up; two braids." }, stamp), null);
    const away = chooseLook(CHOSEN, { key: "maren-kest" }, null, stamp)!;
    assert.deepEqual(away.characters["maren-kest"], { name: "Maren", sheet: "maren-kest", text: "Oilskin coat.", blocks: ["p1.0"] });
    assert.equal(chooseLook(LOOK, { key: "maren-kest" }, null, stamp), null, "no choice, nothing to take away");
  });

  it("chooses a look for a character the chapter held no line for, under the name it is given", () => {
    assert.equal(chooseLook(LOOK, { key: "odile" }, { lookId: "tk_grey", text: "Grey wool." }, stamp), null, "nobody without a name");
    const next = chooseLook(LOOK, { key: "odile", name: "Odile", sheet: "odile" }, { lookId: "tk_grey", text: "Grey wool." }, stamp)!;
    assert.deepEqual(next.characters["odile"], { name: "Odile", sheet: "odile", text: "Grey wool.", lookId: "tk_grey" });
  });

  it("is the chapter's own choice once made here, though it was carried in", () => {
    const carried: AudiobookLook = { ...LOOK, characters: { ...LOOK.characters, "maren-kest": { name: "Maren", sheet: "maren-kest", text: "Storm coat.", lookId: "tk_storm", from: "03-the-stair" } } };
    const next = chooseLook(carried, { key: "maren-kest" }, { lookId: "tk_storm", text: "Storm coat." }, stamp)!;
    assert.equal(next.characters["maren-kest"]!.from, undefined);
    assert.equal(next.characters["maren-kest"]!.lookId, "tk_storm");
  });

  it("stays through an edit of its line, which is then the author's", () => {
    const next = editLook(CHOSEN, { kind: "character", key: "maren-kest" }, "Storm coat, hood down.", stamp)!;
    assert.equal(next.characters["maren-kest"]!.lookId, "tk_storm");
    assert.equal(next.characters["maren-kest"]!.by, "author");
    assert.equal(next.characters["maren-kest"]!.reading, "Oilskin coat.");
  });
});

describe("a derive over a look that has a choice", () => {
  it("never undoes a choice and keeps the chapter's own reading beside it", () => {
    const { look, kept } = mergeLook(CHOSEN, { characters: [{ key: "maren-kest", name: "Maren", text: "A yellow slicker, hood down.", conflicts: [{ kind: "chapter", part: "Hood", a: "down", b: "up" }] }] }, stamp);
    const maren = look.characters["maren-kest"]!;
    assert.equal(maren.lookId, "tk_storm");
    assert.equal(maren.text, "Storm coat, hood up; two braids.");
    assert.equal(maren.reading, "A yellow slicker, hood down.");
    assert.deepEqual(maren.conflicts, [{ kind: "chapter", part: "Hood", a: "down", b: "up" }]);
    assert.equal(kept, 2, "the choice and the author's Sereth");
  });

  it("keeps a chosen character the new reading does not find, as it keeps an author's", () => {
    const { look } = mergeLook(CHOSEN, { characters: [] }, stamp);
    assert.equal(look.characters["maren-kest"]!.lookId, "tk_storm");
  });

  it("starts a character with the look most recently chosen in an earlier chapter, from that chapter", () => {
    const carried = { "maren-kest": { name: "Maren", sheet: "maren-kest", lookId: "tk_storm", text: "Storm coat, hood up.", from: "03-the-stair" } };
    const { look } = mergeLook(null, { characters: [{ key: "maren-kest", name: "Maren", sheet: "maren-kest", text: "Her father's jacket.", blocks: ["p2.0"] }] }, stamp, carried);
    assert.deepEqual(look.characters["maren-kest"], { name: "Maren", sheet: "maren-kest", text: "Storm coat, hood up.", blocks: ["p2.0"], lookId: "tk_storm", from: "03-the-stair", reading: "Her father's jacket." });
  });

  it("carries a look to a person the chapter names though its reading found no clothing for them", () => {
    const carried = { odile: { name: "Odile", sheet: "odile", lookId: "tk_grey", text: "Grey wool.", from: "01-the-lamp" } };
    const { look } = mergeLook(null, { characters: [] }, stamp, carried);
    assert.deepEqual(look.characters["odile"], { name: "Odile", sheet: "odile", text: "Grey wool.", lookId: "tk_grey", from: "01-the-lamp" });
  });

  it("is carried only to a character the look held nothing for, so a choice of no look survives a derive again", () => {
    const carried = { "maren-kest": { name: "Maren", sheet: "maren-kest", lookId: "tk_storm", text: "Storm coat.", from: "03-the-stair" } };
    const none = chooseLook(CHOSEN, { key: "maren-kest" }, null, stamp)!;
    assert.equal(none.characters["maren-kest"]!.lookId, undefined);
    const again = mergeLook(none, { characters: [{ key: "maren-kest", name: "Maren", text: "Oilskin coat." }] }, stamp, carried).look;
    assert.equal(again.characters["maren-kest"]!.lookId, undefined, "the author chose the main photo; Derive again leaves it");
    const first = mergeLook(LOOK, { characters: [{ key: "ghost", name: "Ghost", text: "A sheet." }] }, stamp, { ghost: { name: "Ghost", lookId: "tk_g", text: "A sheet.", from: "01-the-lamp" } }).look;
    assert.equal(first.characters["ghost"]!.lookId, "tk_g", "a character the look never held does start with it");
  });

  it("is not carried over a choice the chapter already holds", () => {
    const carried = { "maren-kest": { name: "Maren", sheet: "maren-kest", lookId: "tk_other", text: "Another coat.", from: "01-the-lamp" } };
    const { look } = mergeLook(CHOSEN, { characters: [{ key: "maren-kest", name: "Maren", text: "x" }] }, stamp, carried);
    assert.equal(look.characters["maren-kest"]!.lookId, "tk_storm");
  });
});

describe("the mood line", () => {
  it("is read once, and an author's mood stands over a derive", () => {
    const first = mergeLook(null, { mood: { text: "Teal water; fine grain." }, characters: [] }, stamp).look;
    assert.deepEqual(first.mood, { text: "Teal water; fine grain." });
    const mine = editLook(first, { kind: "mood" }, "Amber lamplight, long lens.", stamp)!;
    assert.deepEqual(mine.mood, { text: "Amber lamplight, long lens.", by: "author" });
    const again = mergeLook(mine, { mood: { text: "Something else." }, characters: [] }, stamp);
    assert.equal(again.look.mood!.text, "Amber lamplight, long lens.");
    assert.equal(again.kept, 1);
  });

  it("is left as it was by a derive that reads none, and can be taken away", () => {
    const first = mergeLook(null, { mood: { text: "Teal water." }, characters: [] }, stamp).look;
    assert.equal(mergeLook(first, { characters: [] }, stamp).look.mood!.text, "Teal water.");
    assert.equal(editLook(first, { kind: "mood" }, null, stamp)!.mood, undefined);
    assert.equal(editLook(first, { kind: "mood" }, "Teal water.", stamp), null);
  });
});

describe("the look a picture rode", () => {
  const RODE = { "maren-kest": { lookId: "tk_storm", view: "full" as const } };
  const library = (key: string, lookId: string) => (key === "maren-kest" && lookId === "tk_harbour" ? { text: "Harbour coat, bare head." } : undefined);

  it("keeps who rode which look and which of its images, and none where the main photo rode", () => {
    const made = pictureLookFor(CHOSEN, ["maren-kest", "sereth"], RODE)!;
    assert.deepEqual(made.looks, RODE);
    assert.equal(pictureLookFor(LOOK, ["maren-kest"])!.looks, undefined, "no look chosen, no pick");
    assert.ok(PictureLookSchema.safeParse(made).success);
  });

  it("hashes as 191 did where no look was chosen, so a picture made before looks is not marked by their arrival in the schema", () => {
    assert.equal(lookDigest([{ key: "a", text: "A coat" }]), lookDigest([{ key: "a", text: "A coat", lookId: undefined }]));
    assert.notEqual(lookDigest([{ key: "a", text: "A coat" }]), lookDigest([{ key: "a", text: "A coat", lookId: "tk_1", view: "full" }]));
    assert.notEqual(lookDigest([{ key: "a", text: "A coat", lookId: "tk_1", view: "full" }]), lookDigest([{ key: "a", text: "A coat", lookId: "tk_1", view: "close" }]));
  });

  it("is marked `look changed` when the chapter chooses another look for the person", () => {
    const made = pictureLookFor(CHOSEN, ["maren-kest"], RODE)!;
    assert.equal(pictureLookChanged(made, CHOSEN), false);
    const other = chooseLook(CHOSEN, { key: "maren-kest" }, { lookId: "tk_harbour", text: "Harbour coat, bare head." }, stamp)!;
    assert.equal(pictureLookChanged(made, other), true);
  });

  it("is marked when a person it was made with no look for is given one", () => {
    const made = pictureLookFor(LOOK, ["maren-kest"])!;
    assert.equal(pictureLookChanged(made, CHOSEN), true);
  });

  it("is never marked by the chapter's choice when the look was chosen for this picture alone, only by that look's own line", () => {
    const only = { "maren-kest": { lookId: "tk_harbour", view: "full" as const, only: true as const } };
    const made = pictureLookFor(CHOSEN, ["maren-kest"], only, library)!;
    assert.equal(made.looks!["maren-kest"]!.only, true);
    assert.equal(pictureLookChanged(made, CHOSEN, library), false);
    const another = chooseLook(CHOSEN, { key: "maren-kest" }, { lookId: "tk_third", text: "A third coat." }, stamp)!;
    assert.equal(pictureLookChanged(made, another, library), false, "the chapter changing its choice does not reach it");
    const edited = (_key: string, lookId: string) => (lookId === "tk_harbour" ? { text: "Harbour coat with a red scarf." } : undefined);
    assert.equal(pictureLookChanged(made, CHOSEN, edited), true, "the look's own line changed");
    assert.equal(pictureLookChanged(made, CHOSEN, () => undefined), true, "the look is gone");
  });

  it("takes the override's own words for the prompt, and the chapter's line for everyone else", () => {
    const only = { "maren-kest": { lookId: "tk_harbour", view: "full" as const, only: true as const } };
    const lines = lookLinesFor(CHOSEN, ["maren-kest", "sereth"], only, library);
    assert.deepEqual(lines.map((line) => [line.label, line.text]), [["Place", "The flooded quarter, dusk."], ["Maren", "Harbour coat, bare head."], ["Sereth", "Blue greatcoat."]]);
  });

  it("rides on a picture and on the chapter's record, which a build before it cannot read", () => {
    const made = pictureLookFor(CHOSEN, ["maren-kest"], RODE)!;
    const picture = { file: "artifacts/a.png", source: "generated", textHash: "t", at: AT, look: made };
    const record = { schemaVersion: 1, chapterVersion: 1, hash: "h", updatedAt: AT, takes: {}, flags: {}, direction: {}, look: { ...CHOSEN, mood: { text: "Teal water." } }, pictures: { "p1.0": picture } };
    assert.ok(ChapterAudiobookSchema.safeParse(record).success);
    assert.equal(lookNeedsChoiceBoundary({ look: record.look, pictures: { "p1.0": { look: made } } }), true);
    assert.equal(lookNeedsChoiceBoundary({ look: LOOK, pictures: { "p1.0": { look: pictureLookFor(LOOK, ["maren-kest"]) } } }), false, "a record in turn 191's shape needs no more than schema 49");
    assert.equal(lookNeedsChoiceBoundary({ look: { ...LOOK, mood: { text: "Teal." } } }), true);
    assert.equal(lookNeedsChoiceBoundary({ look: LOOK, pictures: { a: { look: made } } }), true);
  });
});

describe("a kit look made for a chapter", () => {
  const kit = (mainFile: string | undefined, photoFile = "mains/new.png"): ReferenceKit => ({
    sheetId: "maren-kest",
    mainPhoto: { file: photoFile, source: "generated" },
    tiles: [],
    compilations: [],
    looks: [
      { id: "tk_a", file: "takes/tk_a/a.png", kind: "costume", prompt: "Storm coat.", acceptedAt: AT, framing: "full-body", ...(mainFile !== undefined ? { mainFile } : {}), closeFile: "takes/tk_b/b.png", closeTakeId: "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G3" },
      { id: "tk_old", file: "takes/tk_old/o.png", kind: "costume", prompt: "Old coat.", acceptedAt: "2026-09-01T09:00:00.000Z" },
      { id: "tk_pose", file: "takes/tk_pose/p.png", kind: "pose-expression", prompt: "Laughing.", acceptedAt: AT },
    ],
  });

  it("reads with its framing, its main photo and its close view, and as it was without them", () => {
    assert.ok(ReferenceKitSchema.safeParse(kit("mains/new.png")).success);
    const bare = kit(undefined);
    const looks = bare.looks!.map(({ framing: _f, mainFile: _m, closeFile: _c, closeTakeId: _t, ...rest }) => rest);
    assert.ok(ReferenceKitSchema.safeParse({ ...bare, looks }).success);
    assert.equal(CharacterLookSchema.safeParse({ ...bare.looks![0], stray: 1 }).success, false);
  });

  it("is marked older face when the main photo is no longer the one it was made from, never when it recorded none", () => {
    assert.equal(lookOlderFace(kit("mains/new.png"), kit("mains/new.png").looks![0]!), false);
    assert.equal(lookOlderFace(kit("mains/old.png"), kit("mains/old.png").looks![0]!), true);
    assert.equal(lookOlderFace(kit(undefined), kit(undefined).looks![0]!), false);
  });

  it("is offered to a chapter when it is a costume, newest first, whether or not it was made for chapters", () => {
    assert.deepEqual(chapterLooksOf(kit("mains/new.png")).map((look) => look.id), ["tk_a", "tk_old"]);
    assert.deepEqual(chapterLooksOf(null), []);
  });
});

describe("a look's clothing line", () => {
  // The three looks the Cast page made on Na Love or Juju before turn 193: exploration prompts, not clothing lines.
  const ADE = "OUTFIT FOR THIS LOOK, overriding any clothing named earlier in this prompt. Full-length standing figure, head to shoes fully in frame, plain dark neutral studio backdrop, even soft light. Ade wears an unstructured soft cream linen shirt open at the collar with the sleeves pushed just above the wrist, a steel watch on his wrist, slim dark trousers and black leather lace-up shoes, a phone in one hand. No agbada, no kaftan, no embroidery, no lace. Upright, relaxed stance, hands natural, looking at the camera.";
  const TUNDE = "OUTFIT FOR THIS LOOK, overriding any clothing named earlier in this prompt. Full-length standing figure, head to shoes fully in frame, plain dark neutral studio backdrop, even soft light. Tunde, shorter than Ade, thick through the chest and shoulders with a belly he is at peace with, wears a washed navy polo shirt with the collar open, faded blue jeans, clean white trainers and a good steel watch. No agbada, no kaftan, no embroidery, no lace. Easy, weighty stance, one hand in a pocket, looking at the camera.";
  const IFE = "OUTFIT AND HAIR FOR THIS LOOK, overriding any clothing or hair named earlier in this prompt or shown in the references. The second reference is Ife's character sheet: take her build and proportions from the standing figure in it, exactly, and her face from the first reference; ignore that figure's clothing, hair and backdrop. Full-length standing figure facing the camera, head to shoes fully in frame, plain dark neutral studio backdrop, even soft light. She wears long knotless braids gathered off her neck in a low twist (not straight hair), a low-backed cream-gold silk slip dress, bare shoulders, heavy old-gold hoop earrings and stacked old-gold bangles, gold strappy heeled sandals, a small structured gold clutch in one hand and a phone in the other. Poised, one foot slightly forward, looking at the camera.";

  it("keeps what a Cast page look says is worn and drops what it told the image model", () => {
    assert.equal(lookClothing({ prompt: ADE }), "Ade wears an unstructured soft cream linen shirt open at the collar with the sleeves pushed just above the wrist, a steel watch on his wrist, slim dark trousers and black leather lace-up shoes, a phone in one hand.");
    assert.match(lookClothing({ prompt: TUNDE }), /^Tunde, shorter than Ade, .* wears a washed navy polo shirt .* steel watch\.$/);
    const ife = lookClothing({ prompt: IFE });
    assert.match(ife, /^She wears long knotless braids .* phone in the other\.$/);
    for (const line of [lookClothing({ prompt: ADE }), lookClothing({ prompt: TUNDE }), ife]) assert.doesNotMatch(line, /OUTFIT|reference|backdrop|camera|agbada/);
  });

  it("is the prompt itself for a look made for a chapter, which was made from that line", () => {
    assert.equal(lookClothing({ prompt: "Storm coat, hood up; two braids.", framing: "full-body" }), "Storm coat, hood up; two braids.");
    assert.equal(lookClothing({ prompt: "Grey wool coat. No jewellery." }), "Grey wool coat. No jewellery.".replace(" No jewellery.", ""), "a plain line keeps its sentences bar a bare negative");
  });

  it("uses an authored name separately from the exact prompt, and a date for legacy looks", () => {
    assert.equal(lookName({ prompt: "A long generation prompt.", name: "Storm coat" }), "Storm coat");
    assert.match(lookName({ prompt: "A long generation prompt.", acceptedAt: AT }), /^Look · 3 Oct, /);
    assert.equal(lookName({ prompt: "A long generation prompt." }), "Look");
  });
});

describe("the Mood line (design turn 193, rule 9)", () => {
  // Na Love or Juju's art direction as the world holds it: the agbada that dressed every man in chapter 1.
  const ART = "Lagos at night, shot close and handheld. Sodium orange from streetlamps, the cold blue-green of a generator-lit compound, deep unlit shadow between them — light that comes from inside the frame, never from a lamp we cannot see. Warm dark skin held in low key, sweat and gold and lace-trimmed agbada catching the little light there is.";

  it("cuts every clause that names clothing, hair or an ornament, keeps the light, and counts what went", () => {
    const { text, cut } = cutMoodClothing(ART);
    assert.doesNotMatch(text, /agbada|lace/);
    assert.match(text, /Sodium orange from streetlamps/);
    assert.match(text, /Warm dark skin held in low key\./);
    assert.equal(cut, 1);
    assert.deepEqual(cutMoodClothing("Teal water, amber lamplight; fine grain, a long lens."), { text: "Teal water, amber lamplight, fine grain, a long lens.", cut: 0 });
    assert.deepEqual(cutMoodClothing("Everyone in white kaftans."), { text: "", cut: 1 });
  });

  it("is the chapter's own line when it has one, else the art direction with its clothing cut", () => {
    assert.equal(pictureMood({ mood: { text: "Purple club light, warm gold, fine grain." } }, ART), "Purple club light, warm gold, fine grain.");
    const fallback = pictureMood({}, ART)!;
    assert.doesNotMatch(fallback, /agbada/);
    assert.match(fallback, /^Lagos at night/);
    assert.equal(pictureMood(null, undefined), undefined);
  });
});
describe("the frame word (design turn 193, rule 11)", () => {
  it("reads the readable word from a frame's first clause, and the close view follows it", () => {
    const cases: Array<[string, string | null, "full" | "close"]> = [
      ["Extreme close-up, Ife's eyes", "Extreme close-up", "close"],
      ["Medium two-shot across the table", "Two-shot", "close"],
      ["Medium close-up · the key", "Medium close-up", "close"],
      ["Close-up on her face", "Close-up", "close"],
      ["Wide shot from behind Maren", "Wide", "full"],
      ["Medium wide, the room", "Medium wide", "full"],
      ["Establishing, the quarter", "Establishing", "full"],
      ["Detail, her fingers on his forearm", "Detail", "full"],
      ["Over the shoulder", "Over the shoulder", "full"],
      ["Medium", "Medium", "full"],
      ["A picture of her", null, "full"],
    ];
    for (const [frame, word, view] of cases) {
      assert.equal(frameWord(frame), word, frame);
      assert.equal(lookViewFor(frame), view, frame);
    }
  });
});