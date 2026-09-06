import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  chapterPasses,
  continuityPath,
  deriveContinuity,
  mergePasses,
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

    const many = verifyContinuity({ characters: [{ character: "maren-kest", knows: ["Maren", "stood", "on the", "Vigil", "at", "slack", "water"] }] }, body);
    assert.equal(many.characters[0]!.knows.length, 6, "six lines is the cap");
    assert.equal(many.cut, 1, "the seventh is counted, never silent (codex, round four)");
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
      },
    ]);
    assert.deepEqual(merged, {
      characters: [
        { character: "maren-kest", present: true, where: "b", placed: "pb", knows: ["one", "two"] },
        { character: "odile-sarn", present: true, knows: [] },
      ],
      dropped: 1,
      omitted: 1,
      cut: 0,
    });
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
    assert.equal(onDisk.hash, (await openChapter(store, PRODUCTION, "neap")).hash, "keyed to the bytes read");
    assert.equal(onDisk.characters[0].knows[0], KNOWS);
    assert.equal(onDisk.passes, 1);

    const summary = chapterOf(store, "neap");
    assert.ok(summary.continuity && !("unreadable" in summary.continuity));
    assert.deepEqual(summary.continuity.placed, [{ character: "maren-kest", where: "the-vigil" }], "the bundle carries the placings");
    assert.equal((summary.continuity as { characters?: unknown }).characters, undefined, "and never the lines");
    assert.equal(summary.continuity.hash, summary.hash, "fresh: the record's hash is the summary's");
    assert.deepEqual(await readContinuity(store, PRODUCTION, "01-neap"), derived.record, "the lines come with the chapter");
    assert.ok(store.getBundle().externalEdits.length === 0, "the app writing a record is not the world changing outside it");

    // A direct save keeps the version and moves the hash: the hash decides staleness.
    const live = await openChapter(store, PRODUCTION, "neap");
    await saveChapter(store, PRODUCTION, "01-neap", `${live.body}\n\nAnd one more line.`, { baseHash: live.hash });
    const moved = chapterOf(store, "neap");
    assert.equal(moved.version, 4);
    assert.ok(moved.continuity && !("unreadable" in moved.continuity));
    assert.notEqual(moved.continuity.hash, moved.hash, "stale, by the hash alone");
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
