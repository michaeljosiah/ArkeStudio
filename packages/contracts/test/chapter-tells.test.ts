import assert from "node:assert/strict";
import { it } from "node:test";
import { verifiedTells, tellStretches, crowded, readTells, tellsPerThousand, tellsByKind, TELL_KINDS, TELL_LINE, TELL_KIND_LINE, type TellDraft } from "../src/chapter-tells.js";
import { ChapterReviewSchema, ReviewAnswerSchema, chapterReviewSummary } from "../src/chapter-review.js";

// Paragraphs of numbered words, each closed so none is inside another ("w10" is in "w100";
// "w10x" is not): a quote names exactly one place.
const word = (n: number) => `w${n}x`;
const chapter = (paragraphs: number, words: number) => Array.from({ length: paragraphs }, (_, p) =>
  Array.from({ length: words }, (_, w) => word(p * words + w)).join(" ")).join("\n\n");

it("places only exact quotations, at every occurrence when every occurrence is tagged", () => {
  const body = "He stopped. She looked up.\n\nHe stopped. Then nothing.";
  const drafts: TellDraft[] = [
    { kind: "pivot", quote: "He stopped." },
    { kind: "pivot", quote: "He stopped." },
    { kind: "pivot", quote: "He stopped." },
    { kind: "pivot", quote: "She looked  up." },
    { kind: "metaphor", quote: "an invented figure" },
    { kind: "pivot", quote: "  " },
  ];
  const { tells, unplaced, repeated, ambiguous } = verifiedTells(body, drafts);
  assert.deepEqual(tells.map((t) => t.start), [0, body.lastIndexOf("He stopped.")]);
  assert.equal(unplaced, 3, "a paraphrase, an invention and blank space are not in the chapter");
  assert.equal(repeated, 1, "a third tag for a line that occurs twice repeats one already placed");
  assert.equal(ambiguous, 0);
});

it("does not guess which of two identical lines a single tag meant", () => {
  // The first "He stopped." is sequential action; the reviewer tagged only one of the two.
  const body = "He stopped. He turned the key.\n\nShe was there.\n\nHe stopped.";
  const { tells, ambiguous, unplaced } = verifiedTells(body, [{ kind: "pivot", quote: "He stopped." }, { kind: "pivot", quote: "She was there.\n\nHe stopped." }]);
  assert.equal(ambiguous, 1, "dropped and counted, never anchored to the first occurrence");
  assert.equal(unplaced, 0);
  assert.deepEqual(tells.map((t) => t.start), [body.indexOf("She was there.")], "a quotation long enough to be unique is placed");
});

it("counts one tell tagged twice once, and two kinds at one place twice", () => {
  const body = "Not dramatically, not with the tidy violence of lust, but with the dull click of a lock turning.";
  const { tells, merged } = verifiedTells(body, [
    { kind: "notxy", quote: "Not dramatically, not with the tidy violence of lust" },
    { kind: "notxy", quote: "Not dramatically, not with the tidy violence of lust, but with the dull click" },
    { kind: "metaphor", quote: "the dull click of a lock turning" },
  ]);
  assert.equal(merged, 1, "two tags of one kind beginning at one place are one tell");
  assert.deepEqual(tells.map((t) => t.kind), ["notxy", "metaphor"]);
  assert.equal(tells[0]!.quote, "Not dramatically, not with the tidy violence of lust, but with the dull click", "the longer span is kept");
});

it("keeps a tell that begins inside a lengthened quotation of the same kind", () => {
  // Codex on PR 1956: a repeated simile lengthened forward to be unique runs into a separate
  // personification. Both are metaphors, and both count.
  const body = "He ran like a dog. Then he ran like a dog in the rain, the sky weeping on his back.";
  const { tells, merged } = verifiedTells(body, [
    { kind: "metaphor", quote: "like a dog in the rain, the sky weeping" },
    { kind: "metaphor", quote: "the sky weeping on his back" },
  ]);
  assert.equal(merged, 0);
  assert.deepEqual(tells.map((t) => t.start), [body.indexOf("like a dog in"), body.indexOf("the sky")]);
});

it("records whether a tell sits inside spoken words", () => {
  const body = "“You have a flight,” Tunde said, as if the night owed him one.";
  const { tells } = verifiedTells(body, [{ kind: "three", quote: "You have a flight" }, { kind: "metaphor", quote: "as if the night owed him one" }]);
  assert.deepEqual(tells.map((t) => t.inDialogue), [true, false]);
});

it("starts a stretch at each tell, running to the chapter's end at most", () => {
  const body = chapter(20, 50);
  const { tells } = verifiedTells(body, [{ kind: "pivot", quote: word(10) }, { kind: "metaphor", quote: word(60) }, { kind: "three", quote: `${word(60)} ${word(61)}` }, { kind: "list", quote: word(900) }]);
  const stretches = tellStretches(body, tells);
  assert.deepEqual(stretches.map((s) => s.start), [body.indexOf(word(10)), body.indexOf(word(60)), body.indexOf(word(900))], "two tells beginning in one word share its stretch");
  assert.equal(stretches[0]!.words, 450);
  assert.equal(stretches[0]!.count, 3, "a tell belongs to the stretch it begins in");
  assert.deepEqual([stretches[2]!.words, stretches[2]!.end], [100, body.length]);
  const short = chapter(3, 40);
  assert.equal(tellStretches(short, verifiedTells(short, [{ kind: "pivot", quote: word(0) }]).tells)[0]!.words, 120, "a chapter under 450 words is one stretch of all of it");
  assert.deepEqual(tellStretches(body, []), []);
  assert.deepEqual(tellStretches("", []), []);
});

it("reads the tail of a paragraph longer than a stretch", () => {
  // One 1,000-word paragraph, as a chapter written with single line breaks splits.
  const body = Array.from({ length: 1000 }, (_, w) => word(w)).join(" ");
  const drafts: TellDraft[] = Array.from({ length: 8 }, (_, i) => ({ kind: (["three", "list", "pivot", "notxy"] as const)[i % 4]!, quote: word(880 + i * 10) }));
  const reading = readTells(body, drafts);
  assert.equal(reading.passages.length, 1, "eight tells in words 880..950 are found");
  assert.equal(reading.passages[0]!.densest.count, 8);
});

it("finds a run that falls between any two sampled starts", () => {
  // Codex on PR 1956: one tell at word 140 and seven at 500..580 fit in 450 words that neither a
  // window from word 0 nor one from word 150 holds.
  const body = Array.from({ length: 1000 }, (_, w) => word(w)).join(" ");
  const kinds = ["three", "list", "metaphor", "notxy", "pivot", "shorthand", "three", "list"] as const;
  const at = [140, 500, 510, 520, 540, 560, 570, 580];
  const reading = readTells(body, at.map((n, i) => ({ kind: kinds[i]!, quote: word(n) })));
  assert.equal(reading.passages.length, 1);
  assert.equal(reading.passages[0]!.densest.count, 8);
  assert.equal(reading.passages[0]!.start, body.indexOf(word(140)));
});

it("finds exactly the densest 450 words that checking every word would", () => {
  // Every word as a start is the definition; starting only at tells must agree with it.
  let seed = 1952;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const body = chapter(30, 70);
  const total = 30 * 70;
  for (let trial = 0; trial < 60; trial++) {
    const n = 4 + Math.floor(next() * 30);
    const drafts: TellDraft[] = [...new Set(Array.from({ length: n }, () => Math.floor(next() * total)))]
      .map((w) => ({ kind: TELL_KINDS[Math.floor(next() * TELL_KINDS.length)]!, quote: word(w) }));
    const { tells } = verifiedTells(body, drafts);
    const offsets = [...body.matchAll(/\S+/g)].map((m) => m.index);
    let densest = 0;
    for (let from = 0; from < offsets.length; from++) {
      const end = offsets[Math.min(offsets.length - 1, from + 449)]! + word(Math.min(offsets.length - 1, from + 449)).length;
      densest = Math.max(densest, tells.filter((t) => t.start >= offsets[from]! && t.start < end).length);
    }
    assert.equal(Math.max(0, ...tellStretches(body, tells).map((s) => s.count)), densest, `trial ${trial}`);
  }
});

it("is crowded at the line, or at the kind line for one kind", () => {
  const byKind = { three: 0, list: 0, metaphor: 0, notxy: 0, pivot: 0, shorthand: 0 };
  assert.equal(crowded({ count: TELL_LINE - 1, byKind: { ...byKind, metaphor: 3, pivot: 2, three: 2 } }), false);
  assert.equal(crowded({ count: TELL_LINE, byKind: { ...byKind, metaphor: 3, pivot: 3, three: 2 } }), true);
  assert.equal(crowded({ count: TELL_KIND_LINE, byKind: { ...byKind, metaphor: TELL_KIND_LINE } }), true, "four metaphors stack");
});

it("finds a crowded run that straddles two fixed blocks", () => {
  const body = chapter(20, 50);
  // Ten tells in words 400..499: five either side of the strip's 450-word boundary.
  const drafts: TellDraft[] = Array.from({ length: 10 }, (_, i) => ({ kind: (["three", "list", "pivot", "notxy", "shorthand"] as const)[i % 5]!, quote: word(400 + i * 10) }));
  const reading = readTells(body, drafts);
  assert.deepEqual(reading.strip.slice(0, 2).map((bar) => bar.count), [5, 5], "neither fixed block reaches the line");
  assert.equal(reading.passages.length, 1, "every stretch from paragraph 1 to 8 holds all ten, and they merge");
  assert.equal(reading.passages[0]!.densest.count, 10);
  assert.deepEqual([reading.passages[0]!.start, reading.passages[0]!.end], [body.indexOf(word(400)), body.indexOf(word(490)) + word(490).length],
    "the passage spans its tells, not the 800 words of stretches that contain them");
  assert.deepEqual(reading.strip.slice(0, 3).map((bar) => bar.crowded), [true, true, false]);
});

it("merges overlapping crowded stretches into one passage reporting its densest", () => {
  const body = chapter(40, 50);
  const dense = (from: number, n: number, kind: TellDraft["kind"] = "metaphor") => Array.from({ length: n }, (_, i) => ({ kind, quote: word(from + i * 5) }));
  const reading = readTells(body, [...dense(100, 9, "pivot"), ...dense(300, 3, "three"), ...dense(1500, 4)]);
  assert.equal(reading.passages.length, 2);
  assert.deepEqual(reading.passages.map((p) => p.id), ["p1", "p2"]);
  assert.equal(reading.passages[0]!.densest.count, 12, "the densest 450 words hold both runs");
  assert.equal(reading.passages[1]!.densest.byKind.metaphor, 4, "four of one kind is crowded on its own");
  assert.ok(reading.passages[0]!.end <= reading.passages[1]!.start);
  assert.equal(reading.strip.reduce((sum, bar) => sum + bar.count, 0), reading.tells.length, "the strip's bars add up to every tell");
});

it("marks nothing when the tells are spread out", () => {
  const body = chapter(40, 50);
  // One every 100 words, the kinds taking turns. Every 100 words of one kind would be four or
  // five in any 450, which is the kind line doing its job.
  const kinds = ["metaphor", "three", "pivot", "list", "notxy", "shorthand"] as const;
  const spread = Array.from({ length: 19 }, (_, i) => ({ kind: kinds[i % kinds.length]!, quote: word(i * 100) }));
  const reading = readTells(body, spread);
  assert.equal(reading.passages.length, 0);
  assert.equal(reading.strip.some((bar) => bar.crowded), false);
  assert.equal(tellsPerThousand(reading), 10);
  assert.equal(tellsByKind(reading.tells).metaphor, 4);
});

it("pins the reading in the review and summarises it for chat", () => {
  const body = chapter(4, 50);
  const tells = readTells(body, [{ kind: "pivot", quote: word(3) }]);
  const review = { worldId: "world", productionId: "book", chapterId: "one", schemaVersion: 1, requestId: "r", id: "11111111-1111-4111-a111-111111111111", title: "One",
    createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z", status: "complete", sourceHash: "s", contextHash: "c", body, images: [], tasks: [], facts: [], findings: [],
    checks: [], rejectedFindings: 0, stale: false, staleReasons: [], audioListened: false };
  assert.equal(ChapterReviewSchema.safeParse(review).success, true, "a review from before turn 232 still reads");
  const pinned = ChapterReviewSchema.parse({ ...review, tells });
  assert.equal(pinned.tells?.line, TELL_LINE);
  assert.match(chapterReviewSummary(pinned), /AI tells: 0 crowded passages \(line 8 in 450 words\)/);
  assert.equal(ReviewAnswerSchema.safeParse({ facts: [], findings: [], tells: [{ kind: "simile", quote: "x" }] }).success, false, "only the six kinds");
});
