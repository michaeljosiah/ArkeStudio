import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { voicedBlocks } from "@arke-studio/contracts";
import { castLines, mergeVoicePasses, readVoices, verifyVoices, voicesPath, type RawVoices, type VoicesDeriverInput } from "../../src/productions/voices.js";
import { openChapter, saveChapter } from "../../src/productions/ops.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The cast of lines (design turn 130, issue 912, SPEC-012 §2.4.2): cast by a press in
 * continuity's discipline, every line a verified span placed by paragraph and occurrence,
 * kept beside the chapter and keyed to the hash of the prose, never written into the world.
 */

const PRODUCTION = "the-ledger-of-nights";
const NOW = () => "2026-09-06T12:00:00.000Z";
// A span of the fixture's first chapter, quoted across the file's own line wrap.
const SPAN = "kept in a hand that changes every generation";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: NOW });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

const chapterOf = (store: WorldStore, id: string) =>
  store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!.chapters.find((c) => c.id === id)!;

describe("what the model said, held to the chapter (R-45)", () => {
  it("keeps only spoken spans of the pass, places them by paragraph and occurrence, tags speakers by exact id or a unique name, and counts the rest", () => {
    const body = "Maren counted the bells.\n\n“No,” said Maren. “No,” said Odile.\n\n“Six, and the tide not\nyet called,” she said.";
    const cast = [{ id: "maren-kest", name: "Maren Kest" }, { id: "odile-sarn", name: "Odile Sarn" }];
    const raw: RawVoices = {
      lines: [
        { speaker: "Maren Kest", quote: "“No,”" },
        { speaker: "odile-sarn", quote: "“No,”" },
        { speaker: "Perrin", quote: "“No,”" },
        { speaker: "maren-kest", quote: "“Six, and the tide not yet called,”" },
        { speaker: "Maren Kest", quote: "not in the chapter" },
        { speaker: "Maren Kest", quote: "x".repeat(601) },
      ],
    };
    const verified = verifyVoices(raw, body, body, cast);
    assert.deepEqual(verified.lines, [
      { speaker: "Maren Kest", sheet: "maren-kest", paragraph: 1, occurrence: 0, quote: "“No,”" },
      { speaker: "odile-sarn", sheet: "odile-sarn", paragraph: 1, occurrence: 1, quote: "“No,”" },
      { speaker: "maren-kest", sheet: "maren-kest", paragraph: 2, occurrence: 0, quote: "“Six, and the tide not yet called,”" },
    ]);
    assert.equal(verified.dropped, 3, "a third No the paragraph does not hold, a paraphrase, and a quote too long to be a line");

    // Passes carry their own lines forward so the next pass counts occurrences after them.
    const second = verifyVoices({ lines: [{ speaker: "Odile Sarn", quote: "“No,”" }] }, "“No,” said Maren. “No,” said Odile.", body, cast, verified.lines);
    assert.equal(second.lines.length, 0, "both occurrences are already spoken for");
    assert.equal(second.dropped, 1);

    const merged = mergeVoicePasses([verified, second], body);
    assert.equal(merged.lines.length, 3);
    assert.equal(merged.dropped, 4);
    assert.equal(merged.omitted, 0);
    assert.deepEqual(merged.lines.map((line) => `${line.paragraph}:${line.occurrence}`), ["1:0", "1:1", "2:0"], "in reading order");
  });

  it("the cap keeps the first four hundred lines in reading order and counts the rest as omitted", () => {
    const body = Array.from({ length: 450 }, (_, i) => `Line ${i} was said.`).join("\n\n");
    const pass = { lines: Array.from({ length: 450 }, (_, i) => ({ speaker: "Maren Kest", paragraph: i, occurrence: 0, quote: `Line ${i} was said.` })), dropped: 0 };
    const merged = mergeVoicePasses([pass], body);
    assert.equal(merged.lines.length, 400);
    assert.equal(merged.omitted, 50);
    assert.equal(merged.lines[399]!.paragraph, 399);
  });
});

describe("the blocks a voiced read is made of (R-46)", () => {
  it("splits a paragraph at its lines by the one rule both ends use, and a stale cast reads a line only where its words are held exactly as often as the cast says", () => {
    const record = {
      lines: [
        { speaker: "Maren Kest", sheet: "maren-kest", paragraph: 0, occurrence: 0, quote: "“No,”" },
        { speaker: "Odile Sarn", sheet: "odile-sarn", paragraph: 0, occurrence: 1, quote: "“No,”" },
      ],
    };
    const fresh = voicedBlocks("“No,” said Maren. “No,” said Odile.\n\nShe went.", record);
    assert.deepEqual(
      fresh.blocks.map((block) => [block.text, block.speaker ?? null]),
      [["“No,”", "Maren Kest"], ["said Maren.", null], ["“No,”", "Odile Sarn"], ["said Odile.", null], ["She went.", null]],
    );
    assert.equal(fresh.ambiguous, 0);
    // One of the two identical lines deleted (codex on turn 130): the survivor is either
    // speaker's, so neither is voiced, and both are counted.
    const moved = voicedBlocks("“No,” said Odile.\n\nShe went.", record);
    assert.deepEqual(moved.blocks.map((block) => block.speaker ?? null), [null, null], "narration, not the wrong voice");
    assert.equal(moved.ambiguous, 2);
    // No cast at all is a page of narration, one block per paragraph.
    assert.deepEqual(voicedBlocks("A.\n\nB.", null).blocks.map((block) => block.text), ["A.", "B."]);
  });
});

describe("cast by a press, kept beside the chapter, keyed to the prose (R-44, R-48)", () => {
  it("writes the record beside the chapter; the scanner carries the stamp; the open carries the lines; a save makes it stale by the hash", async () => {
    const { dir, store } = await open();
    const seen: VoicesDeriverInput[] = [];
    const deriver = async (input: VoicesDeriverInput): Promise<RawVoices> => {
      seen.push(input);
      return { lines: [{ speaker: "maren-kest", quote: SPAN }, { speaker: "Nobody", quote: "not in the chapter" }] };
    };
    const cast = await castLines(store, PRODUCTION, "neap", deriver);
    assert.equal(cast.lines, 1);
    assert.equal(cast.dropped, 1);
    assert.deepEqual(seen[0]!.pass, { index: 1, of: 1 });
    assert.ok(seen[0]!.cast.some((entry) => entry.id === "maren-kest"), "the cast is named as the world names it");

    const onDisk = JSON.parse(await readFile(join(dir, ...voicesPath(PRODUCTION, "01-neap").split("/")), "utf8"));
    assert.equal(onDisk.version, 4);
    assert.equal(onDisk.hash, (await openChapter(store, PRODUCTION, "neap")).bodyHash, "keyed to the prose read");
    assert.deepEqual(onDisk.lines[0], { speaker: "maren-kest", sheet: "maren-kest", paragraph: 0, occurrence: 0, quote: SPAN });

    const summary = chapterOf(store, "neap");
    assert.ok(summary.voices && !("unreadable" in summary.voices));
    assert.equal(summary.voices.lines, 1);
    assert.deepEqual(summary.voices.speakers, [{ speaker: "maren-kest", sheet: "maren-kest", lines: 1 }], "the bundle carries the stamp");
    assert.equal((summary.voices as { lines: unknown }).lines, 1, "and never the lines themselves");
    assert.deepEqual(await readVoices(store, PRODUCTION, "01-neap"), cast.record, "the lines come with the chapter");
    assert.equal(store.getBundle().externalEdits.length, 0, "the app writing a cast is not the world changing outside it");

    const live = await openChapter(store, PRODUCTION, "neap");
    await saveChapter(store, PRODUCTION, "01-neap", `${live.body}\n\nAnd one more line.`, { baseHash: live.hash });
    const moved = chapterOf(store, "neap");
    assert.ok(moved.voices && !("unreadable" in moved.voices));
    assert.notEqual(moved.voices.hash, moved.bodyHash, "stale, by the hash alone");
  });

  it("a stop or a failed pass leaves the last cast standing, and a file that cannot be read is said so", async () => {
    const { dir, store } = await open();
    const first = await castLines(store, PRODUCTION, "neap", async () => ({ lines: [{ speaker: "maren-kest", quote: SPAN }] }));
    const control = new AbortController();
    const stopping = castLines(store, PRODUCTION, "neap", (_input, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true })), control.signal);
    control.abort();
    await assert.rejects(stopping, /stopped/);
    assert.deepEqual(await readVoices(store, PRODUCTION, "01-neap"), first.record, "a stop writes nothing");
    await assert.rejects(() => castLines(store, PRODUCTION, "neap", async () => { throw new Error("the model did not answer with a voices record"); }), /did not answer/);
    assert.deepEqual(await readVoices(store, PRODUCTION, "01-neap"), first.record, "a failed pass writes nothing");

    const path = join(dir, ...voicesPath(PRODUCTION, "02-the-same-ink").split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{ not json", "utf8");
    await store.reload();
    assert.equal(await readVoices(store, PRODUCTION, "02-the-same-ink"), "unreadable");
    assert.deepEqual(chapterOf(store, "the-same-ink").voices, { unreadable: true });
  });
});
