import assert from "node:assert/strict";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AudiobookReader } from "@arke-studio/contracts";
import { hashAudioFile, type AudioMediaTools } from "../../src/audio/media-tools.js";
import { exportScript, lineId, matchFiles, parseLineId, scriptManifestPath, speakerLines } from "../../src/productions/audiobook-lines.js";
import { openChapter, saveChapter } from "../../src/productions/ops.js";
import { writeScriptPdf } from "../../src/productions/script-pdf.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup, tempDir } from "../tmp.js";

/**
 * A recorded speaker's lines out and back (design turn 155d, SPEC-047 R-39): each line by an id
 * the audiobook already keys a block by, a script of them as a PDF under exports/, and returned
 * files matched by the id in their names — refused in one clause when they name no line of the
 * speaker's, or a line whose words changed since the script.
 */

const PRODUCTION = "the-ledger-of-nights";
const NOW = () => "2026-09-26T09:00:00.000Z";
const NARRATOR: AudiobookReader = { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", label: "George" };

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: NOW });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

function fakeTools(): AudioMediaTools {
  const technical = { container: "wav", codec: "pcm_s16le", sampleFormat: "s16", sampleRateHz: 48_000, channels: 1, bitDepth: 16, durationSec: 2, sizeBytes: 40 };
  return {
    probe: async ({ absolutePath }) => ({ sourceHash: (await hashAudioFile(absolutePath, new AbortController().signal)).hash, technical, hasAudio: true }),
    preparePcmWav: async ({ sourcePath, destinationPath }) => {
      await copyFile(sourcePath, destinationPath);
      return { outputHash: (await hashAudioFile(destinationPath, new AbortController().signal)).hash, technical, toolVersion: "fake" };
    },
    analyze: async ({ expectedHash }) => ({ status: "unavailable", sourceHash: expectedHash, analyzerId: "arke-pcm-qc", analyzerVersion: 1, policyVersion: 1, reason: "not-configured" }),
  };
}

describe("a line's id (R-39)", () => {
  it("is the chapter's order, the paragraph from 1 and the block's place in it, and reads back from a file name", () => {
    assert.equal(lineId(7, "p10.0"), "07-011-1");
    assert.equal(lineId(12, "title"), "12-000-1");
    assert.deepEqual(parseLineId("07-011-1.wav"), { id: "07-011-1", chapterOrder: 7, blockKey: "p10.0" });
    assert.deepEqual(parseLineId("odile take 07-011-2 final.mp3"), { id: "07-011-2", chapterOrder: 7, blockKey: "p10.1" });
    assert.deepEqual(parseLineId("01-000-1.wav"), { id: "01-000-1", chapterOrder: 1, blockKey: "title" });
    assert.equal(parseLineId("take-final.wav"), null);
    assert.equal(parseLineId("01-000-2.wav"), null, "a title has one place");
  });
});

describe("the script, out (R-39)", () => {
  it("writes the narrator's lines as a PDF under exports/ and keeps the words it asked for", async () => {
    const { dir, store } = await open();
    const found = await speakerLines(store, PRODUCTION, "narrator", NARRATOR);
    assert.ok(found.lines.length > 1, "the narrator has the titles and the narration");
    assert.equal(found.lines[0]!.id.endsWith("-000-1"), true, "a chapter's title comes first");
    const made = await exportScript(store, PRODUCTION, "narrator", { scope: "all", label: "Narrator", narrator: NARRATOR, exportId: "01J9SCRIPT00000000000ABCDEF", now: NOW });
    assert.match(made.output, /^exports\/the-ledger-of-nights-narrator-lines-20260926090000-abcdef\.pdf$/);
    const pdf = await readFile(join(dir, ...made.output.split("/")));
    assert.equal(pdf.subarray(0, 8).toString("latin1"), "%PDF-1.4");
    assert.match(pdf.toString("latin1"), /%%EOF\n$/);
    assert.match(pdf.toString("latin1"), new RegExp(found.lines[0]!.id), "each line carries its id");
    const manifest = JSON.parse(await readFile(join(dir, ...scriptManifestPath(PRODUCTION, "narrator").split("/")), "utf8")) as { lines: Record<string, { textHash: string }> };
    assert.equal(Object.keys(manifest.lines).length, found.lines.length, "every line's words, whatever the scope");
  });

  it("the PDF writer pages long scripts, and a character WinAnsi lacks becomes ? rather than vanishing", () => {
    const runs = Array.from({ length: 200 }, (_, i) => ({ text: `“Line ${i}” — said, … 雪`, style: "line" as const }));
    const pdf = writeScriptPdf(runs, { title: "t" }).toString("latin1");
    assert.ok(/\/Count ([2-9]|\d{2,})/.test(pdf), "more than one page");
    assert.ok(pdf.includes("\\223Line 0\\224 \\227 said, \\205 ?"), "curly quotes, dash and ellipsis in WinAnsi, the rest as ?");
  });
});

describe("files back (R-39)", () => {
  it("matches each file by the id in its name, and refuses in one clause what cannot be kept", async () => {
    const { store } = await open();
    const found = await speakerLines(store, PRODUCTION, "narrator", NARRATOR);
    await exportScript(store, PRODUCTION, "narrator", { scope: "all", label: "Narrator", narrator: NARRATOR, exportId: "01J9SCRIPT00000000000ABCDEF", now: NOW });
    const folder = await tempDir("lines-back");
    const first = found.lines.find((line) => !line.id.endsWith("-000-1"))!;
    const files = [`${first.id}.wav`, "take-final.wav", "99-001-1.wav", `copy ${first.id}.wav`];
    for (const name of files) await writeFile(join(folder, name), `RIFF fake ${name}`);
    const deps = { tools: fakeTools(), transcribe: null, narrator: NARRATOR, signal: new AbortController().signal };
    const matched = await matchFiles(store, PRODUCTION, "narrator", files.map((name) => join(folder, name)), deps);
    assert.deepEqual(
      matched.map((row) => [row.file, row.refused ?? "staged"]),
      [[`${first.id}.wav`, "staged"], ["take-final.wav", "no line id"], ["99-001-1.wav", "not one of these lines"], [`copy ${first.id}.wav`, "another file has this id"]],
    );
    assert.equal(matched[0]!.staged?.block, first.block);

    // The words changed since the script: the file is refused rather than kept against new words.
    const chapter = store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!.chapters.find((c) => c.id === first.chapterId)!;
    const live = await openChapter(store, PRODUCTION, chapter.id);
    const folded = live.body.replace(/\s+/g, " ");
    const words = first.text.replace(/\s+/g, " ");
    assert.ok(folded.includes(words), "the line is in the saved prose");
    await saveChapter(store, PRODUCTION, chapter.file, folded.replace(words, `${words} And more.`), { baseHash: live.hash });
    const again = await matchFiles(store, PRODUCTION, "narrator", [join(folder, `${first.id}.wav`)], deps);
    assert.equal(again[0]!.refused, "words changed");
  });
});
