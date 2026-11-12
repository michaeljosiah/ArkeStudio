import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AudiobookCreditsSchema,
  audiobookCreditFacts,
  audiobookCreditMissing,
  audiobookCreditWarning,
  audiobookCreditWords,
  draftAudiobookCredit,
  foldAudiobookCredits,
} from "../src/audiobook-credits.js";
import { ListeningChapterSchema, type ListeningChapter } from "../src/audiobook-listening.js";

const defaults = { title: "Na love or Juju", author: "Michael Josiah", voiceLabel: "Nigerian Woman 2", year: 2026 };

describe("audiobook credits (design turn 252, SPEC-047 R-210 – R-213)", () => {
  it("drafts ACX's shape from the details, naming the narrator the author gives", () => {
    const facts = audiobookCreditFacts({ narrator: "Ife Balogun" }, defaults);
    assert.equal(draftAudiobookCredit("opening", facts), "Na love or Juju. Written by Michael Josiah. Narrated by Ife Balogun.");
    assert.equal(
      draftAudiobookCredit("closing", facts),
      "You have been listening to Na love or Juju, written by Michael Josiah, narrated by Ife Balogun. Copyright 2026 Michael Josiah. The End.",
    );
  });

  it("names the narrator's voice where the author named no one, and never says how it was made", () => {
    const facts = audiobookCreditFacts({}, defaults);
    assert.equal(facts.narrator, "Nigerian Woman 2");
    for (const key of ["opening", "closing"] as const) assert.doesNotMatch(draftAudiobookCredit(key, facts), /\bAI\b/);
  });

  it("drops a clause whose detail is empty rather than speaking a gap", () => {
    const facts = audiobookCreditFacts({ author: "", copyright: "" }, { ...defaults, voiceLabel: null });
    assert.equal(draftAudiobookCredit("opening", facts), "Na love or Juju.");
    assert.equal(draftAudiobookCredit("closing", facts), "You have been listening to Na love or Juju. The End.");
  });

  it("keeps the author's own words, and redrafts only words never written over", () => {
    const credits = AudiobookCreditsSchema.parse({ schemaVersion: 1, updatedAt: "2026-10-31T12:00:00.000Z", words: { closing: "The End of Na love or Juju." } });
    const facts = audiobookCreditFacts({ narrator: "Ife Balogun" }, defaults);
    assert.deepEqual(audiobookCreditWords(credits, "closing", facts), { words: "The End of Na love or Juju.", edited: true });
    assert.equal(audiobookCreditWords(credits, "opening", facts).edited, false);
  });

  it("says which name a credit no longer carries (R-212)", () => {
    const facts = audiobookCreditFacts({ narrator: "Ife Balogun" }, defaults);
    assert.deepEqual(audiobookCreditMissing("Na love or Juju, by Michael Josiah.", facts), ["narrator"]);
    assert.equal(audiobookCreditWarning(["narrator"]), "names no narrator");
    assert.equal(audiobookCreditWarning(["title", "author"]), "names no title or author");
    assert.deepEqual(audiobookCreditMissing(draftAudiobookCredit("closing", facts), facts), []);
    // Every credit names a narrator, as ACX asks: one with none to name warns too.
    assert.deepEqual(audiobookCreditMissing("Na love or Juju.", audiobookCreditFacts({ author: "" }, { ...defaults, voiceLabel: null })), ["narrator"]);
  });
});

describe("the credits folded into an edition (SPEC-047 R-218, SPEC-058 R-94)", () => {
  const chapter = (chapterId: string, order: number): ListeningChapter => ({
    chapterId,
    order,
    title: `Chapter ${order}`,
    state: "read",
    seconds: 10,
    blocks: [
      { key: "p1", number: 1, file: `artifacts/${chapterId}-1.wav`, at: 0, seconds: 4, sentences: [{ at: 0, text: "First." }], words: [{ text: "First.", startSec: 0.2, endSec: 0.9, probability: 0.9 }] },
      { key: "p2", number: 2, file: `artifacts/${chapterId}-2.wav`, at: 5, seconds: 5, sentences: [{ at: 5, text: "Second." }] },
    ],
    gaps: [{ at: 4, from: 1, to: 2 }],
    pictures: [{ key: "p1", number: 1, file: `pictures/${chapterId}.png`, at: 0, seconds: 10 }],
    opening: null,
  });
  const credit = (key: "opening" | "closing", seconds: number) => ({ key, text: `${key} words`, file: `artifacts/${key}.wav`, seconds, artifactId: `take-${key}` });

  it("moves everything in the first chapter by the opening and adds the closing after the last chapter's words", () => {
    const { chapters, audio } = foldAudiobookCredits([chapter("one", 1), chapter("two", 2)], { opening: credit("opening", 3), closing: credit("closing", 6) }, "art/cover.png");
    const [first, last] = chapters;
    assert.equal(first!.seconds, 13);
    assert.deepEqual(first!.blocks.map((block) => [block.key, block.number, block.at]), [["opening", 1, 0], ["p1", 2, 3], ["p2", 3, 8]]);
    assert.deepEqual(first!.blocks[1]!.sentences, [{ at: 3, text: "First." }]);
    assert.deepEqual(first!.blocks[1]!.words!.map((word) => [word.startSec, word.endSec]), [[3.2, 3.9]]);
    assert.deepEqual(first!.gaps, [{ at: 7, from: 1, to: 2 }]);
    assert.deepEqual(first!.pictures.map((picture) => [picture.key, picture.number, picture.file, picture.at]), [["credits-opening", 1, "art/cover.png", 0], ["p1", 2, "pictures/one.png", 3]]);
    assert.equal(last!.seconds, 16);
    assert.deepEqual(last!.blocks.at(-1), { key: "closing", number: 3, file: "artifacts/closing.wav", artifactId: "take-closing", at: 10, seconds: 6, sentences: [{ at: 10, text: "closing words" }] });
    assert.deepEqual(last!.pictures.at(-1), { key: "credits-closing", number: 2, file: "art/cover.png", at: 10, seconds: 6 });
    assert.deepEqual(Object.fromEntries(audio), { one: { before: "artifacts/opening.wav" }, two: { after: "artifacts/closing.wav" } });
    // A package reads as it did: the folded chapters are still listening chapters.
    for (const folded of chapters) ListeningChapterSchema.parse(folded);
  });

  it("puts both credits around a book of one chapter, and adds no picture to a part", () => {
    const { chapters, audio } = foldAudiobookCredits([chapter("one", 1)], { opening: credit("opening", 3), closing: credit("closing", 6) }, null);
    assert.deepEqual(chapters[0]!.blocks.map((block) => block.key), ["opening", "p1", "p2", "closing"]);
    assert.equal(chapters[0]!.blocks.at(-1)!.at, 13);
    assert.deepEqual(chapters[0]!.pictures.map((picture) => picture.key), ["p1"]);
    assert.deepEqual(audio.get("one"), { before: "artifacts/opening.wav", after: "artifacts/closing.wav" });
  });

  it("leaves a book without credits as it was", () => {
    const book = [chapter("one", 1)];
    const { chapters, audio } = foldAudiobookCredits(book, {}, "art/cover.png");
    assert.deepEqual(chapters, book);
    assert.equal(audio.size, 0);
  });
});
