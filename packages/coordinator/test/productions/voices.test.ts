import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { voicedBlocks } from "@arke-studio/contracts";
import { castLines, mergeVoicePasses, readVoices, setVoicePin, verifyVoices, voicesPath, type RawVoices, type VoicesDeriverInput } from "../../src/productions/voices.js";
import { CAST_PARAGRAPHS_SCHEMA_VERSION, VOICE_PINS_SCHEMA_VERSION } from "../../src/world/commit.js";
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

  it("the same words said in several paragraphs are placed in each of them, in order (codex on PR 914)", () => {
    const body = "“No.”\n\n“No.”\n\n“No.”";
    const raw: RawVoices = { lines: ["A", "B", "C", "D"].map((speaker) => ({ speaker, quote: "“No.”" })) };
    const verified = verifyVoices(raw, body, body);
    assert.deepEqual(verified.lines.map((line) => [line.speaker, line.paragraph, line.occurrence]), [["A", 0, 0], ["B", 1, 0], ["C", 2, 0]]);
    assert.equal(verified.dropped, 1, "a fourth No the chapter does not hold");
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

describe("the author's corrections to the cast (design turn 155, SPEC-012 R-62..R-65)", () => {
  const worldSchema = async (dir: string) => (JSON.parse(await readFile(join(dir, "world.json"), "utf8")) as { schemaVersion: number }).schemaVersion;

  it("a pin is written beside the derived lines, raises the world first, and the read applies it", async () => {
    const { dir, store } = await open();
    await castLines(store, PRODUCTION, "neap", async () => ({ lines: [{ speaker: "maren-kest", quote: SPAN }] }));
    // A cast written now keeps each paragraph's hash (design turn 198), a field the builds before
    // it read as unreadable, so the cast itself raises the world past them.
    assert.equal(await worldSchema(dir), CAST_PARAGRAPHS_SCHEMA_VERSION, "a cast keeps its paragraphs' hashes, which raises the world");
    const body = (await openChapter(store, PRODUCTION, "neap")).body;
    const record = await setVoicePin(store, PRODUCTION, "neap", { paragraph: 0, occurrence: 0, quote: SPAN, narration: true });
    assert.deepEqual(record.pins, [{ paragraph: 0, occurrence: 0, quote: SPAN, narration: true }]);
    assert.ok((await worldSchema(dir)) >= VOICE_PINS_SCHEMA_VERSION, "raised before the first record with pins");
    assert.deepEqual(await readVoices(store, PRODUCTION, "01-neap"), record);
    assert.ok(!voicedBlocks(body, record).blocks.some((block) => block.sheet === "maren-kest"), "the span reads as narration now");
    const stamp = chapterOf(store, "neap").voices;
    assert.ok(stamp && !("unreadable" in stamp) && stamp.pins === 1, "the stamp counts the correction");

    // Choosing what the derivation said is no correction: the pin goes and the record keeps the old shape.
    const back = await setVoicePin(store, PRODUCTION, "neap", { paragraph: 0, occurrence: 0, quote: SPAN, speaker: "maren-kest", sheet: "maren-kest" });
    assert.equal(back.pins, undefined);
    const onDisk = JSON.parse(await readFile(join(dir, ...voicesPath(PRODUCTION, "01-neap").split("/")), "utf8"));
    assert.ok(!("pins" in onDisk), "a record with no pins is written without the field");
  });

  it("refuses in one clause: words not there, a character not in the cast, a cast the prose has moved under, no cast", async () => {
    const { store } = await open();
    await assert.rejects(() => setVoicePin(store, PRODUCTION, "neap", { paragraph: 0, occurrence: 0, quote: SPAN, narration: true }), /not cast/);
    await castLines(store, PRODUCTION, "neap", async () => ({ lines: [{ speaker: "maren-kest", quote: SPAN }] }));
    await assert.rejects(() => setVoicePin(store, PRODUCTION, "neap", { paragraph: 0, occurrence: 0, quote: "not in the chapter", narration: true }), /not there/);
    await assert.rejects(() => setVoicePin(store, PRODUCTION, "neap", { paragraph: 0, occurrence: 0, quote: SPAN, speaker: "Nobody", sheet: "nobody-at-all" }), /no such character/);
    // A cast from before paragraph hashes is stale whole once the prose moves under it, as before.
    const path = join(store.dir, ...voicesPath(PRODUCTION, "01-neap").split("/"));
    const { paragraphs: _paragraphs, ...legacy } = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify(legacy), "utf8");
    const live = await openChapter(store, PRODUCTION, "neap");
    await saveChapter(store, PRODUCTION, "01-neap", `${live.body}\n\nAnd one more line.`, { baseHash: live.hash });
    await assert.rejects(() => setVoicePin(store, PRODUCTION, "neap", { paragraph: 0, occurrence: 0, quote: SPAN, narration: true }), /cast moved/);
  });

  it("Cast again keeps every pin whose words stand, and drops and counts one whose words are gone", async () => {
    const { store } = await open();
    const derive = async () => ({ lines: [{ speaker: "maren-kest", quote: SPAN }] });
    await castLines(store, PRODUCTION, "neap", derive);
    await setVoicePin(store, PRODUCTION, "neap", { paragraph: 0, occurrence: 0, quote: SPAN, speaker: "Odile", });
    const again = await castLines(store, PRODUCTION, "neap", derive);
    assert.equal(again.record.pins?.length, 1, "the correction outlives a new cast");
    assert.equal(again.record.lost, undefined);

    const live = await openChapter(store, PRODUCTION, "neap");
    await saveChapter(store, PRODUCTION, "01-neap", live.body.replace(/\s+/g, " ").replace(SPAN, "kept by nobody at all"), { baseHash: live.hash });
    const moved = await castLines(store, PRODUCTION, "neap", async () => ({ lines: [] }));
    assert.equal(moved.record.pins, undefined, "a pin whose words are gone is not re-placed");
    assert.equal(moved.record.lost, 1, "and it is counted");
    const stamp = chapterOf(store, "neap").voices;
    assert.ok(stamp && !("unreadable" in stamp) && stamp.lost === 1);
  });
});

/**
 * Edited lines keep their speaker, and only edited paragraphs need casting (design turn 198,
 * SPEC-012 R-66..R-71), on the case that asked for it: "Na love or Juju", chapter 1, 2026-10-05.
 */
describe("an edit makes stale only the paragraphs it touches (design turn 198)", () => {
  const GOAT = [
    "Tunde was telling the goat story again.",
    "\"It is not possible,\" Ade said.",
    "\"The goat was in the boot.\"",
    "\"The goat was in the boot spiritually. Physically, he was in front.\"",
    "Ade laughed until his chest hurt.",
  ].join("\n\n");
  const EDITED = GOAT
    .replace("\"The goat was in the boot.\"", "\"The goat was in the boot, Tunde.\"")
    .replace("\"The goat was in the boot spiritually. Physically, he was in front.\"", "\"Ehn-ehn. The goat was in the boot spiritually,\" Tunde said. \"Physically, he was in front.\"");
  const FIRST: RawVoices = {
    lines: [
      { speaker: "Ade", quote: "\"It is not possible,\"" },
      { speaker: "maren-kest", quote: "\"The goat was in the boot.\"" },
      { speaker: "Tunde", quote: "\"The goat was in the boot spiritually. Physically, he was in front.\"" },
    ],
  };

  async function goatWorld() {
    const { dir, store } = await open();
    const live = await openChapter(store, PRODUCTION, "neap");
    await saveChapter(store, PRODUCTION, "01-neap", GOAT, { baseHash: live.hash });
    await castLines(store, PRODUCTION, "neap", async () => FIRST);
    const cast = await openChapter(store, PRODUCTION, "neap");
    await saveChapter(store, PRODUCTION, "01-neap", EDITED, { baseHash: cast.hash });
    return { dir, store };
  }
  const read = (body: string, record: Parameters<typeof voicedBlocks>[1]) =>
    voicedBlocks(body, record).blocks.map((block) => [block.text, block.speaker ?? null, block.kept === true]);

  it("keeps both edited lines' speakers, kept, and the new tag is narration", async () => {
    const { store } = await goatWorld();
    const record = await readVoices(store, PRODUCTION, "01-neap");
    assert.ok(record !== null && record !== "unreadable" && record.paragraphs !== undefined);
    assert.deepEqual(read(EDITED, record).slice(3), [
      ["\"The goat was in the boot, Tunde.\"", "maren-kest", true],
      ["\"Ehn-ehn. The goat was in the boot spiritually,\"", "Tunde", true],
      ["Tunde said.", null, false],
      ["\"Physically, he was in front.\"", "Tunde", true],
      ["Ade laughed until his chest hurt.", null, false],
    ]);
  });

  it("Cast 2 paragraphs sends the model those paragraphs with the chapter around them, and merges only their lines", async () => {
    const { store } = await goatWorld();
    const seen: VoicesDeriverInput[] = [];
    const cast = await castLines(store, PRODUCTION, "neap", async (input) => {
      seen.push(input);
      return {
        lines: [
          { speaker: "maren-kest", quote: "\"The goat was in the boot, Tunde.\"" },
          { speaker: "Tunde", quote: "\"Ehn-ehn. The goat was in the boot spiritually,\"" },
          { speaker: "Tunde", quote: "\"Physically, he was in front.\"" },
          // A line of an untouched paragraph is not this run's to place.
          { speaker: "Somebody", quote: "\"It is not possible,\"" },
        ],
      };
    }, undefined, "changed");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.edited, true);
    assert.equal(seen[0]!.body, EDITED.split("\n\n").slice(2, 4).join("\n\n"), "the two edited paragraphs alone");
    assert.ok(seen[0]!.context?.includes("Ade laughed"), "with the chapter around them as context");
    assert.equal(cast.lines, 3);
    assert.equal(cast.dropped, 1, "the line the model placed outside the edited paragraphs is not written");
    assert.deepEqual(cast.record.lines.map((line) => [line.paragraph, line.speaker, line.quote]), [
      [1, "Ade", "\"It is not possible,\""],
      [2, "maren-kest", "\"The goat was in the boot, Tunde.\""],
      [3, "Tunde", "\"Ehn-ehn. The goat was in the boot spiritually,\""],
      [3, "Tunde", "\"Physically, he was in front.\""],
    ]);
    assert.equal(cast.record.hash, (await openChapter(store, PRODUCTION, "neap")).bodyHash, "current again");
    assert.ok(read(EDITED, cast.record).every(([, , kept]) => kept === false), "cast, so nothing is kept any more");
  });

  it("gives a line to a speaker while paragraphs wait: on an untouched paragraph and on a kept line, never on uncast words of an edited one", async () => {
    const { store } = await goatWorld();
    // Untouched paragraph: narration given to Odile.
    const one = await setVoicePin(store, PRODUCTION, "neap", { paragraph: 1, occurrence: 0, quote: "Ade said.", speaker: "Odile" });
    assert.deepEqual(one.pins, [{ paragraph: 1, occurrence: 0, quote: "Ade said.", speaker: "Odile" }]);
    // A kept line: choosing its speaker is what checks it, so it is a pin and the mark goes.
    const kept = "\"The goat was in the boot, Tunde.\"";
    const two = await setVoicePin(store, PRODUCTION, "neap", { paragraph: 2, occurrence: 0, quote: kept, speaker: "maren-kest", sheet: "maren-kest" });
    assert.ok(two.pins?.some((pin) => pin.quote === kept && pin.sheet === "maren-kest"));
    const blocks = read(EDITED, two);
    assert.deepEqual(blocks.find(([text]) => text === kept), [kept, "maren-kest", false]);
    assert.deepEqual(blocks.find(([text]) => text === "\"Physically, he was in front.\""), ["\"Physically, he was in front.\"", "Tunde", true], "the other paragraph still waits, kept");
    // Narration in a paragraph left to cast waits for its cast.
    await assert.rejects(() => setVoicePin(store, PRODUCTION, "neap", { paragraph: 3, occurrence: 0, quote: "Tunde said.", speaker: "Odile" }), /paragraph to cast/);
  });

  it("a cast written before paragraph hashes is given them at open while current, and stamped by the save that edits it", async () => {
    const { ProseAuthoringService } = await import("../../src/application/prose-authoring.js");
    const { store } = await open();
    const live = await openChapter(store, PRODUCTION, "neap");
    await saveChapter(store, PRODUCTION, "01-neap", GOAT, { baseHash: live.hash });
    await castLines(store, PRODUCTION, "neap", async () => FIRST);
    const path = join(store.dir, ...voicesPath(PRODUCTION, "01-neap").split("/"));
    const { paragraphs: _paragraphs, ...legacy } = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify(legacy), "utf8");
    const service = new ProseAuthoringService(store);
    const opened = await service.open(PRODUCTION, "neap");
    assert.ok("voices" in opened && opened.voices?.paragraphs !== undefined, "derived on read: the chapter's hash proves the body is the one cast");
    assert.ok(!("paragraphs" in JSON.parse(await readFile(path, "utf8"))), "and nothing written by an open");
    await service.save(PRODUCTION, "01-neap", EDITED, { baseHash: opened.hash });
    const stamped = await readVoices(store, PRODUCTION, "01-neap");
    assert.ok(stamped !== null && stamped !== "unreadable" && stamped.paragraphs !== undefined, "stamped before the save moved the prose");
    assert.equal(read(EDITED, stamped)[3]![2], true, "so the edit keeps its speaker");
  });
});
