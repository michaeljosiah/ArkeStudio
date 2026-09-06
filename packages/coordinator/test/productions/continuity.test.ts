import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  chapterPasses,
  continuityPath,
  deriveContinuity,
  mergePasses,
  passTail,
  readContinuity,
  verifyContinuity,
  type ContinuityDeriverInput,
  type RawContinuity,
} from "../../src/productions/continuity.js";
import { openChapter, saveChapter } from "../../src/productions/ops.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Continuity after a chapter (design turn 129, issue 901, SPEC-012 §2.4.1): derived by a press
 * in extraction's discipline, every line and placing a verified span of the chapter, kept beside
 * the chapter and keyed to the bytes it read, never written into the world.
 */

const PRODUCTION = "the-ledger-of-nights";
const NOW = () => "2026-09-06T12:00:00.000Z";
// Spans of the fixture's first chapter, quoted across the file's own line wraps.
const PLACED = "Maren has the 1820 volume open on the rail desk";
const KNOWS = "You do not read the ledger; you check it";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: NOW });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

const chapterOf = (store: WorldStore, id: string) =>
  store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!.chapters.find((c) => c.id === id)!;

describe("what the model said, held to the chapter (R-40)", () => {
  it("keeps only what quotes the chapter, drops and counts the rest, and counts what the cap cut", () => {
    const body = "Maren stood on the Vigil at slack water.\n\nOdile found her there an hour later, still\nholding the rope.";
    const raw: RawContinuity = {
      characters: [
        {
          character: "maren-kest",
          where: "the-vigil",
          placed: "Maren stood on the Vigil",
          knows: ["still holding the rope", "a paraphrase that is not there", "still  holding the rope"],
        },
        { character: "odile-sarn", where: "Below the harbour", placed: "nowhere in the text", knows: [] },
        ...Array.from({ length: 12 }, (_, i) => ({ character: `guest-${i}`, knows: [] })),
      ],
    };
    const verified = verifyContinuity(raw, body);
    assert.equal(verified.characters.length, 12, "twelve is the cap");
    assert.deepEqual(verified.characters[0], {
      character: "maren-kest",
      present: true,
      where: "the-vigil",
      placed: "Maren stood on the Vigil",
      knows: ["still holding the rope"],
    });
    assert.equal(verified.characters[1]!.where, undefined, "a placing with no words of the chapter behind it takes where with it");
    assert.equal(verified.dropped, 2, "one paraphrase and one unevidenced placing, counted");
    assert.equal(verified.omitted, 2, "two characters over the cap, counted");
    assert.equal(verified.cut, 0);

    // A name is tagged with its sheet by id or by name, and a departure is evidenced like a
    // placing (codex, round five).
    const cast = [{ id: "maren-kest", name: "Maren Kest" }, { id: "odile-sarn", name: "Odile Sarn" }];
    const tagged = verifyContinuity(
      {
        characters: [
          { character: "Maren Kest", where: "the-vigil", placed: "Maren stood on the Vigil", knows: [] },
          { character: "odile-sarn", present: false, placed: "Odile found her there an hour later", knows: [] },
          { character: "Perrin", present: false, placed: "nowhere in the text", knows: [] },
          { character: "the-chorister", knows: [] },
        ],
      },
      body,
      cast,
    );
    assert.equal(tagged.characters[0]!.sheet, "maren-kest", "matched by name");
    assert.deepEqual(tagged.characters[1], { character: "odile-sarn", sheet: "odile-sarn", present: false, placed: "Odile found her there an hour later", knows: [] });
    assert.equal(tagged.characters.length, 4);
    assert.equal(tagged.dropped, 1);
    assert.deepEqual(tagged.characters[2], { character: "Perrin", present: true, unsure: true, knows: [] }, "a departure with no words behind it is dropped, and leaves them unsure (round seven)");
    assert.equal(tagged.characters[3]!.sheet, undefined, "a slug-shaped name the cast does not know is a name");

    // Entries naming one character are one character before the cap (codex on PR 907), and a
    // name two sheets carry is nobody's tag.
    const twice = verifyContinuity(
      {
        characters: [
          { character: "Maren Kest", where: "the-vigil", placed: "Maren stood on the Vigil", knows: ["still holding the rope"] },
          { character: "maren-kest", knows: ["at slack water"] },
          ...Array.from({ length: 11 }, (_, i) => ({ character: `guest-${i}`, knows: [] })),
        ],
      },
      body,
      cast,
    );
    assert.equal(twice.characters.length, 12);
    assert.deepEqual(twice.characters[0]!.knows, ["still holding the rope", "at slack water"], "folded into one");
    assert.equal(twice.omitted, 0, "twelve distinct characters is not over the cap");
    const shared = verifyContinuity(
      { characters: [{ character: "Odile Sarn", knows: [] }] },
      body,
      [...cast, { id: "odile-sarn-2", name: "Odile Sarn" }],
    );
    assert.equal(shared.characters[0]!.sheet, undefined, "two sheets with one name: a guess, so no tag");

    const many = verifyContinuity({ characters: [{ character: "maren-kest", knows: ["Maren", "stood", "on the", "Vigil", "at", "slack", "water"] }] }, body);
    assert.equal(many.characters[0]!.knows.length, 6, "six lines is the cap");
    assert.equal(many.cut, 1, "the seventh is counted, never silent (codex, round four)");
    const mixed = verifyContinuity({ characters: [{ character: "maren-kest", knows: ["Maren", "stood", "on the", "Vigil", "at", "slack", "not in the chapter"] }] }, body);
    assert.equal(mixed.cut, 1, "a seventh line is cut whether or not it verifies (codex on PR 907)");
    assert.equal(mixed.dropped, 0);
    assert.deepEqual(verified.beyond, ["guest-10", "guest-11"], "who the cap left out, by name");
  });

  it("reads a long chapter in passes of whole paragraphs, splits only a paragraph that cannot fit, and unions the passes (R-41)", () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `Paragraph ${i} ${"x".repeat(30)}.`);
    const passes = chapterPasses(paragraphs.join("\n\n"), 100);
    assert.ok(passes.length > 1, "longer than one pass");
    assert.deepEqual(passes.flatMap((pass) => pass.split("\n\n")), paragraphs, "every paragraph, whole, in order");
    assert.deepEqual(chapterPasses("short", 100), ["short"]);

    // Pasted prose with no blank lines (codex, round four): split at sentence ends, never mid-sentence.
    const oversized = "One sentence here. ".repeat(20).trim();
    const pieces = chapterPasses(oversized, 60);
    assert.ok(pieces.length > 1);
    assert.ok(pieces.every((piece) => piece.length <= 60));
    assert.ok(pieces.every((piece) => piece.endsWith(".")), "split at sentence ends");
    assert.equal(pieces.join(" "), oversized, "nothing lost");

    const merged = mergePasses([
      { characters: [{ character: "maren-kest", present: true, where: "a", placed: "pa", knows: ["one"] }], dropped: 1, omitted: 0, cut: 0 },
      {
        characters: [
          { character: "maren-kest", present: true, where: "b", placed: "pb", knows: ["two", "one"] },
          { character: "odile-sarn", present: true, knows: [] },
        ],
        dropped: 0,
        omitted: 1,
        cut: 0,
        beyond: ["perrin-tallow"],
      },
      { characters: [{ character: "maren-kest", present: false, placed: "she left", knows: [] }], dropped: 0, omitted: 1, cut: 0, beyond: ["perrin-tallow"] },
      // Spoken of again with no place given: the departure stands (codex on PR 907).
      { characters: [{ character: "maren-kest", present: true, knows: ["three"] }], dropped: 0, omitted: 0, cut: 0 },
    ]);
    const unsureLater = mergePasses([
      { characters: [{ character: "maren-kest", present: true, where: "a", placed: "pa", knows: [] }], dropped: 0, omitted: 0, cut: 0 },
      { characters: [{ character: "maren-kest", present: true, unsure: true, knows: [] }], dropped: 1, omitted: 0, cut: 0 },
    ]);
    assert.deepEqual(unsureLater.characters[0], { character: "maren-kest", present: true, unsure: true, knows: [] }, "a dropped claim in a later pass leaves them unsure, the earlier place gone (round seven)");
    assert.deepEqual(merged, {
      characters: [
        { character: "maren-kest", present: false, placed: "she left", knows: ["one", "two", "three"] },
        { character: "odile-sarn", present: true, knows: [] },
      ],
      dropped: 1,
      omitted: 1,
      cut: 0,
      beyond: ["perrin-tallow"],
    });
    // A character one pass's cap left out and another pass fitted in is not omitted at all.
    const fitted = mergePasses([
      { characters: [], dropped: 0, omitted: 1, cut: 0, beyond: ["odile-sarn"] },
      { characters: [{ character: "odile-sarn", present: true, knows: [] }], dropped: 0, omitted: 0, cut: 0 },
    ]);
    assert.equal(fitted.omitted, 0, "omitted is who the record lacks, counted once (codex on PR 907)");
    assert.equal(passTail("one\n\ntwo\n\nthree"), "three", "the tail of a pass is its last paragraph");
  });
});

describe("derived by a press, kept beside the chapter, keyed to the bytes (R-38, R-39, R-42)", () => {
  it("writes the record beside the chapter; the scanner carries the stamp and placings, the open carries the lines", async () => {
    const { dir, store } = await open();
    const seen: ContinuityDeriverInput[] = [];
    const deriver = async (input: ContinuityDeriverInput): Promise<RawContinuity> => {
      seen.push(input);
      return { characters: [{ character: "maren-kest", where: "the-vigil", placed: PLACED, knows: [KNOWS, "not a line of the chapter"] }] };
    };
    const derived = await deriveContinuity(store, PRODUCTION, "neap", deriver);
    assert.equal(derived.placed, 1);
    assert.equal(derived.dropped, 1);
    assert.deepEqual(seen[0]!.pass, { index: 1, of: 1 });
    assert.ok(seen[0]!.cast.some((entry) => entry.id === "maren-kest" && entry.name === "Maren Kest"), "the cast is named as the world names it");

    const onDisk = JSON.parse(await readFile(join(dir, ...continuityPath(PRODUCTION, "01-neap").split("/")), "utf8"));
    assert.equal(onDisk.version, 4);
    assert.equal(onDisk.hash, (await openChapter(store, PRODUCTION, "neap")).bodyHash, "keyed to the prose read, not the file");
    assert.equal(seen[0]!.context, undefined, "one pass carries no context");
    assert.equal(onDisk.characters[0].sheet, "maren-kest", "tagged with the sheet the cast names");
    assert.equal(onDisk.characters[0].knows[0], KNOWS);
    assert.equal(onDisk.passes, 1);

    const summary = chapterOf(store, "neap");
    assert.ok(summary.continuity && !("unreadable" in summary.continuity));
    assert.deepEqual(summary.continuity.placed, [{ character: "maren-kest", sheet: "maren-kest", present: true, where: "the-vigil" }], "the bundle carries the placings");
    assert.equal((summary.continuity as { characters?: unknown }).characters, undefined, "and never the lines");
    assert.equal(summary.continuity.hash, summary.bodyHash, "fresh: the record's hash is the summary's body hash");
    assert.notEqual(summary.bodyHash, summary.hash, "which is not the file's");
    assert.deepEqual(await readContinuity(store, PRODUCTION, "01-neap"), derived.record, "the lines come with the chapter");
    assert.ok(store.getBundle().externalEdits.length === 0, "the app writing a record is not the world changing outside it");

    // A direct save keeps the version and moves the hash: the hash decides staleness.
    const live = await openChapter(store, PRODUCTION, "neap");
    await saveChapter(store, PRODUCTION, "01-neap", `${live.body}\n\nAnd one more line.`, { baseHash: live.hash });
    const moved = chapterOf(store, "neap");
    assert.equal(moved.version, 4);
    assert.ok(moved.continuity && !("unreadable" in moved.continuity));
    assert.notEqual(moved.continuity.hash, moved.bodyHash, "stale, by the hash alone");
  });

  it("a stop, or a pass that fails, leaves the last record standing; a record that cannot be read is said so, never treated as absent", async () => {
    const { dir, store } = await open();
    const first = await deriveContinuity(store, PRODUCTION, "neap", async () => ({ characters: [{ character: "maren-kest", where: "the-vigil", placed: PLACED, knows: [] }] }));

    const control = new AbortController();
    const stopping = deriveContinuity(store, PRODUCTION, "neap", (_input, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true })), control.signal);
    control.abort();
    await assert.rejects(stopping, /stopped/);
    assert.deepEqual(await readContinuity(store, PRODUCTION, "01-neap"), first.record, "a stop writes nothing");

    await assert.rejects(
      () => deriveContinuity(store, PRODUCTION, "neap", async () => { throw new Error("the model did not answer with a continuity record"); }),
      /did not answer/,
    );
    assert.deepEqual(await readContinuity(store, PRODUCTION, "01-neap"), first.record, "a failed pass fails the run and writes nothing");

    // A file that is there but cannot be read (codex, round four).
    const path = join(dir, ...continuityPath(PRODUCTION, "02-the-same-ink").split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{ not json", "utf8");
    await store.reload();
    assert.equal(await readContinuity(store, PRODUCTION, "02-the-same-ink"), "unreadable");
    assert.deepEqual(chapterOf(store, "the-same-ink").continuity, { unreadable: true }, "the summary says so rather than inviting a first run");
    assert.equal(await readContinuity(store, PRODUCTION, "03-nothing-wrong-with-it"), null, "and no file is no record");
  });
});
