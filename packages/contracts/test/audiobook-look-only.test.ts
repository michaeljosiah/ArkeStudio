import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChapterAudiobookSchema } from "../src/audiobook.js";
import {
  MAIN_PHOTO_LOOK,
  PictureOwnLooksSchema,
  lookDigest,
  lookLinesFor,
  ownLookPicks,
  pictureLookChanged,
  pictureLookFor,
  pictureOwnLooks,
  type AudiobookLook,
} from "../src/audiobook-look.js";
import { ridingPicks, type PictureWho } from "../src/audiobook-illustrate.js";
import { ClientMessageSchema } from "../src/frames.js";
import { DomainEventSchema } from "../src/events.js";
import { kitLookLibrary, type ReferenceKit } from "../src/reference.js";

/**
 * Only this picture (design turn 193d, rule 8; SPEC-047 R-115, R-146): the looks chosen for one
 * picture alone, held on the block until made, stamped `only` on the picture, and never marked
 * `look changed` by the chapter's choice — the main photo among them.
 */

const AT = "2026-10-05T09:00:00.000Z";
const STORM = "tk_storm";
const HARBOUR = "tk_harbour";
const ULID = "01J00000000000000000000001";

const chapter = (lookId: string | undefined, text: string, reading?: string): AudiobookLook => ({
  chapterHash: "h1",
  at: AT,
  characters: { maren: { name: "Maren", sheet: "maren", text, ...(lookId !== undefined ? { lookId } : {}), ...(reading !== undefined ? { reading } : {}) } },
});
const kits: Array<Pick<ReferenceKit, "sheetId" | "looks">> = [
  {
    sheetId: "maren",
    looks: [
      { id: STORM, file: "takes/storm.png", kind: "costume", prompt: "Storm coat, hood up.", acceptedAt: AT, framing: "full-body" },
      { id: HARBOUR, file: "takes/harbour.png", kind: "costume", prompt: "Harbour coat, brass buttons.", acceptedAt: AT, framing: "full-body" },
      { id: "tk_pose", file: "takes/pose.png", kind: "pose-expression", prompt: "Laughing.", acceptedAt: AT },
    ],
  },
];

describe("the looks held for one picture (R-146)", () => {
  it("are bounded, and ride on the chapter's record", () => {
    assert.equal(PictureOwnLooksSchema.safeParse({ maren: HARBOUR, odile: MAIN_PHOTO_LOOK }).success, true);
    const crowd = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`p${index}`, STORM]));
    assert.equal(PictureOwnLooksSchema.safeParse(crowd).success, false, "no more people than a look holds");
    const record = { schemaVersion: 1, chapterVersion: 1, hash: "h", updatedAt: AT, takes: {}, flags: {}, direction: {}, ownLooks: { "p0.0": { maren: HARBOUR }, "p2.0": {} } };
    assert.deepEqual(ChapterAudiobookSchema.parse(record).ownLooks, record.ownLooks);
  });

  it("are what the block holds, else what its picture was made with alone; held empty stands over the picture's own", () => {
    const made = { hash: "x", who: ["maren", "odile"], looks: { maren: { lookId: HARBOUR, view: "full" as const, only: true as const }, odile: { lookId: STORM, view: "full" as const } } };
    assert.deepEqual(pictureOwnLooks(undefined, made), { maren: HARBOUR }, "only the picture's own look, not the chapter's that rode");
    assert.deepEqual(pictureOwnLooks({ maren: MAIN_PHOTO_LOOK }, made), { maren: MAIN_PHOTO_LOOK });
    assert.deepEqual(pictureOwnLooks({}, made), {});
    assert.deepEqual(pictureOwnLooks(undefined, undefined), {});
    assert.deepEqual(ownLookPicks({ maren: HARBOUR, odile: MAIN_PHOTO_LOOK }), { maren: { lookId: HARBOUR, view: "full", only: true }, odile: { lookId: MAIN_PHOTO_LOOK, view: "close", only: true } });
  });

  it("are stamped from who rode: a look of its own `only`, the main photo of its own under MAIN_PHOTO_LOOK, the chapter's as before", () => {
    const who: PictureWho[] = [
      { key: "maren", name: "Maren", sheet: "maren", kind: "character", reference: "references/maren/takes/harbour.png", carried: true, look: { lookId: HARBOUR, view: "full" }, only: true },
      { key: "odile", name: "Odile", sheet: "odile", kind: "character", reference: "references/odile/head-front.png", carried: true, only: true },
      { key: "sereth", name: "Sereth", sheet: "sereth", kind: "character", reference: "references/sereth/takes/coat.png", carried: true, look: { lookId: "tk_coat", view: "close" } },
      { key: "bray", name: "Bray", sheet: "bray", kind: "character", reference: "references/bray/head-front.png", carried: true },
      { key: "stair", name: "The stair", sheet: "stair", kind: "place", reference: "references/stair/view.png", carried: true, only: true },
    ];
    assert.deepEqual(ridingPicks(who), {
      maren: { lookId: HARBOUR, view: "full", only: true },
      odile: { lookId: MAIN_PHOTO_LOOK, view: "close", only: true },
      sereth: { lookId: "tk_coat", view: "close" },
    });
  });
});

describe("a picture made with a look of its own (R-115, R-146)", () => {
  const library = kitLookLibrary(kits, chapter(STORM, "Storm coat, hood up."));

  it("takes that look's own words, from the kit's costume looks only", () => {
    const lines = lookLinesFor(chapter(STORM, "Storm coat, hood up."), ["maren"], ownLookPicks({ maren: HARBOUR }), library);
    assert.deepEqual(lines, [{ label: "Maren", key: "maren", text: "Harbour coat, brass buttons.", lookId: HARBOUR, view: "full" }]);
    assert.equal(library("maren", "tk_pose"), undefined, "a pose is no look a picture wears");
    assert.equal(library("maren", "tk_gone"), undefined);
  });

  it("is never marked look changed by the chapter's choice changing, and is by that look's own line changing", () => {
    const made = pictureLookFor(chapter(STORM, "Storm coat, hood up."), ["maren"], { maren: { lookId: HARBOUR, view: "full", only: true } }, library)!;
    assert.deepEqual(made.looks, { maren: { lookId: HARBOUR, view: "full", only: true } });
    for (const now of [chapter(HARBOUR, "Harbour coat, brass buttons."), chapter(undefined, "Oilskin coat."), chapter(STORM, "A red coat.")]) {
      assert.equal(pictureLookChanged(made, now, kitLookLibrary(kits, now)), false);
    }
    const rewritten = [{ ...kits[0]!, looks: kits[0]!.looks!.map((look) => (look.id === HARBOUR ? { ...look, prompt: "Harbour coat, no buttons." } : look)) }];
    assert.equal(pictureLookChanged(made, chapter(STORM, "Storm coat, hood up."), kitLookLibrary(rewritten, chapter(STORM, "Storm coat, hood up."))), true);
    // A picture that followed the chapter is marked by the same change of choice.
    const following = pictureLookFor(chapter(STORM, "Storm coat, hood up."), ["maren"], { maren: { lookId: STORM, view: "full" } }, library)!;
    assert.equal(pictureLookChanged(following, chapter(HARBOUR, "Harbour coat, brass buttons."), library), true);
  });

  it("with the main photo takes the chapter's reading of the prose, and hashes as the main photo alone", () => {
    const pick = { maren: { lookId: MAIN_PHOTO_LOOK, view: "close" as const, only: true as const } };
    const lines = lookLinesFor(chapter(STORM, "Storm coat, hood up.", "Oilskin coat, dark with salt."), ["maren"], pick, library);
    assert.deepEqual(lines, [{ label: "Maren", key: "maren", text: "Oilskin coat, dark with salt.", main: true }]);
    assert.deepEqual(lookLinesFor(chapter(undefined, "Oilskin coat."), ["maren"], pick, library).map((line) => line.text), ["Oilskin coat."]);
    const made = pictureLookFor(chapter(STORM, "Storm coat, hood up."), ["maren"], pick, library)!;
    for (const now of [chapter(HARBOUR, "Harbour coat, brass buttons."), chapter(undefined, "Storm coat, hood up."), chapter(STORM, "Storm coat, hood up.", "A red coat.")]) {
      assert.equal(pictureLookChanged(made, now, library), false);
    }
    assert.notEqual(lookDigest([{ key: "maren", text: "x", main: true }]), lookDigest([{ key: "maren", text: "x" }]));
  });

  it("is stamped even where the chapter's look was never read", () => {
    const made = pictureLookFor(null, ["maren"], { maren: { lookId: HARBOUR, view: "close", only: true } }, kitLookLibrary(kits, null));
    assert.deepEqual(made?.looks, { maren: { lookId: HARBOUR, view: "close", only: true } });
    assert.equal(pictureLookChanged(made, null, kitLookLibrary(kits, null)), false);
    assert.equal(pictureLookFor(null, ["maren"], { maren: { lookId: HARBOUR, view: "full" } }), undefined, "with no look of its own, as before: nothing");
  });
});

describe("the frames (R-146)", () => {
  it("choose a look for one block's picture, make with the looks of its own, and ask for Update prompt", () => {
    const base = { worldId: ULID, productionId: "ledger", chapterFile: "04-her-own-hand" };
    assert.equal(ClientMessageSchema.safeParse({ kind: "choose-audiobook-look", ...base, key: "maren", lookId: null, block: "p0.0", only: true }).success, true);
    assert.equal(ClientMessageSchema.safeParse({ kind: "make-audiobook-picture", ...base, block: "p0.0", prompt: "Wide shot.", who: ["maren"], looks: { maren: MAIN_PHOTO_LOOK }, confirmedMicroUsd: 1, requestId: ULID }).success, true);
    const rewrite = { kind: "rewrite-audiobook-picture-prompt", ...base, block: "p0.0", prompt: "Wide shot.", changes: [{ key: "maren", from: STORM, to: HARBOUR }], requestId: ULID };
    assert.equal(ClientMessageSchema.safeParse(rewrite).success, true);
    assert.equal(ClientMessageSchema.safeParse({ ...rewrite, changes: [] }).success, false, "an Update prompt changes someone");
    const answer = { at: AT, type: "audiobook.picture-prompt", requestId: ULID, worldId: ULID, productionId: "ledger", chapterId: "04-her-own-hand", block: "p0.0" };
    assert.equal(DomainEventSchema.safeParse({ ...answer, prompt: "Wide shot." }).success, true);
    assert.equal(DomainEventSchema.safeParse({ ...answer, refused: "the writing service is not running" }).success, true);
  });
});
