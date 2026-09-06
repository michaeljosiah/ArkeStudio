import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { exportManuscript, importManuscript, manuscriptOf, readDocxDocument, readManuscript, writeDocx, writeEpub } from "../../src/productions/manuscript.js";
import { openChapter, saveChapter } from "../../src/productions/ops.js";
import { writeZip } from "../../src/productions/zip.js";
import { extractDocxText, zipEntry } from "../../src/world-chat/document-text.js";
import { CHAPTER_SOURCE_SCHEMA_VERSION } from "../../src/world/commit.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * A manuscript out and in (design turn 131, issue 915, SPEC-012 §2.4.3): two zips written by
 * hand and read back by the reader that already opens them; the export landing whole under
 * exports/; the import shown before anything is written and appended in one commit.
 */

const PRODUCTION = "the-ledger-of-nights";
const NOW = () => "2026-09-06T12:00:00.000Z";
const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: NOW });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

describe("a zip written by hand (R-52)", () => {
  it("round-trips through the reader, stored and deflated, and the reader refuses an entry whose bytes do not add up", () => {
    const text = new TextEncoder().encode("The ledger of the Vigil is kept in a hand that changes every generation. ".repeat(40));
    const zip = writeZip([
      { name: "mimetype", data: new TextEncoder().encode("application/epub+zip"), stored: true },
      { name: "word/document.xml", data: text },
    ]);
    assert.equal(utf8(zip.subarray(30, 38)), "mimetype", "the stored entry is first, its name at byte thirty");
    assert.equal(utf8(zipEntry(zip, "mimetype")!), "application/epub+zip");
    assert.deepEqual(zipEntry(zip, "word/document.xml"), text, "deflated on the way in, the same bytes on the way out");
    assert.equal(zipEntry(zip, "missing"), null);
    // One bit flipped inside a stored entry: the archive's own checksum says so (codex on PR 916).
    const damaged = new Uint8Array(zip);
    damaged[40] = damaged[40]! ^ 0x01; // inside the stored bytes, past the thirty-byte header and the eight-byte name
    assert.throws(() => zipEntry(damaged, "mimetype"), /checksum/);
  });
});

describe("the manuscript out (R-49)", () => {
  it("a .docx the flat reader reads back with its headings, its emphasis and its breaks in place", () => {
    const doc = {
      title: "The ledger of nights",
      subtitle: "The Undersong",
      leftOut: 0,
      words: 9,
      chapters: [
        { title: "Neap", words: 5, blocks: [{ kind: "paragraph" as const, runs: [{ text: "Maren counted the " }, { text: "bells", italic: true as const }, { text: "." }] }, { kind: "break" as const }, { kind: "paragraph" as const, runs: [{ text: "Six & seven <bells>.", bold: true as const }] }] },
      ],
    };
    const bytes = writeDocx(doc);
    const flat = extractDocxText(bytes);
    assert.ok(flat.ok);
    assert.match(flat.text, /The ledger of nights\nThe Undersong\nNeap\nMaren counted the bells\.\n\* \* \*\nSix & seven <bells>\./);
    const read = readDocxDocument(bytes);
    assert.ok(read.ok);
    const styled = read.document.paragraphs.map((paragraph) => [paragraph.style ?? null, paragraph.runs.map((run) => run.text).join("")]);
    assert.deepEqual(styled, [["Title", "The ledger of nights"], ["Subtitle", "The Undersong"], ["Heading1", "Neap"], [null, "Maren counted the bells."], ["SceneBreak", "* * *"], [null, "Six & seven <bells>."]]);
    assert.deepEqual(read.document.paragraphs[3]!.runs[1], { text: "bells", italic: true });
    assert.deepEqual(read.document.paragraphs[5]!.runs[0], { text: "Six & seven <bells>.", bold: true });
    // And back in as chapters: the same words, the same marks.
    const again = readManuscript(bytes, "out.docx").read;
    assert.ok(again.ok);
    assert.deepEqual(again.chapters.map((chapter) => [chapter.title, chapter.body]), [["Neap", "Maren counted the *bells*.\n\n***\n\n**Six & seven <bells>.**"]]);
    assert.equal(again.leftOut, 2, "the title page's two lines stand above the chapters");
  });

  it("an EPUB with mimetype first and stored, a package that names every chapter, the language, and the one modified stamp", () => {
    const doc = { title: "The ledger of nights", subtitle: "The Undersong", leftOut: 0, words: 2, chapters: [{ title: "Neap", words: 1, blocks: [{ kind: "paragraph" as const, runs: [{ text: "Bells." }] }] }, { title: "Slack water", words: 1, blocks: [{ kind: "paragraph" as const, runs: [{ text: "Cold." }] }] }] };
    const bytes = writeEpub(doc, { identifier: "urn:arke:w:p", language: "en-GB", modified: NOW() });
    assert.equal(utf8(bytes.subarray(30, 38)), "mimetype");
    assert.equal(bytes[8], 0, "stored, not deflated");
    assert.equal(utf8(zipEntry(bytes, "mimetype")!), "application/epub+zip");
    const opf = utf8(zipEntry(bytes, "OEBPS/package.opf")!);
    assert.match(opf, /<dc:identifier id="pub-id">urn:arke:w:p<\/dc:identifier>/);
    assert.match(opf, /<dc:language>en-GB<\/dc:language>/);
    assert.equal((opf.match(/dcterms:modified/g) ?? []).length, 1);
    assert.match(opf, /<meta property="dcterms:modified">2026-09-06T12:00:00Z<\/meta>/);
    assert.match(opf, /href="chapter-2.xhtml"/);
    assert.match(utf8(zipEntry(bytes, "OEBPS/nav.xhtml")!), /Slack water/);
    assert.match(utf8(zipEntry(bytes, "OEBPS/chapter-1.xhtml")!), /<h1>Neap<\/h1>/);
  });

  it("lands whole under exports/ with the export id in its name, and a production with no prose has nothing to export", async () => {
    const { dir, store } = await open();
    const doc = await manuscriptOf(store, PRODUCTION);
    assert.ok(doc.chapters.length > 0);
    const all = store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!.chapters.length;
    assert.equal(doc.chapters.length + doc.leftOut, all, "every chapter is in, or counted out");
    const made = await exportManuscript(store, PRODUCTION, "docx", { exportId: "ms_01J8F3K2QW", language: "en", now: NOW });
    assert.match(made.output, /^exports\/the-ledger-of-nights-20260906120000-f3k2qw\.docx$/, "the id's random tail, not its clock");
    const info = await stat(join(dir, ...made.output.split("/")));
    assert.ok(info.size > 0);
    const back = readManuscript(new Uint8Array(await readFile(join(dir, ...made.output.split("/")))), "back.docx").read;
    assert.ok(back.ok);
    assert.equal(back.chapters.length, made.chapters);
    await assert.rejects(exportManuscript(store, "saltlight", "epub", { exportId: "ms_x", language: "en", now: NOW }), /nothing to export|not in this world/);
  });
});

describe("the manuscript in (R-50)", () => {
  it("appends the chapters after the last in one commit, each a draft at v1 with source, raising the boundary; the first save drops source", async () => {
    const { dir, store } = await open();
    const before = store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!.chapters;
    const highest = Math.max(...before.map((c) => c.order));
    const bytes = writeDocx({
      title: "Draft 3",
      subtitle: "",
      leftOut: 0,
      words: 4,
      chapters: [
        { title: "The keeping of the ledger", words: 2, blocks: [{ kind: "paragraph", runs: [{ text: "Kept ", italic: true }, { text: "well." }] }] },
        { title: "Neap", words: 2, blocks: [{ kind: "paragraph", runs: [{ text: "Again, the same title as a chapter there is." }] }] },
      ],
    });
    const read = readManuscript(bytes, "Draft 3.docx").read;
    assert.ok(read.ok);
    const made = await importManuscript(store, PRODUCTION, read, NOW);
    assert.equal(made.after, highest);
    assert.equal(made.created.length, 2);
    const after = store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!.chapters;
    assert.equal(after.length, before.length + 2);
    const added = after.filter((c) => c.source === "Draft 3.docx").sort((a, b) => a.order - b.order);
    assert.deepEqual(added.map((c) => [c.title, c.order, c.status, c.version]), [["The keeping of the ledger", highest + 1, "draft", 1], ["Neap", highest + 2, "draft", 1]]);
    assert.notEqual(added[1]!.id, "neap", "a title the production already has gets a stem of its own");
    assert.deepEqual(before.map((c) => [c.file, c.order, c.version]), after.filter((c) => c.source === undefined).map((c) => [c.file, c.order, c.version]), "nothing existing moved");
    const opened = await openChapter(store, PRODUCTION, added[0]!.id);
    assert.equal(opened.body.trim(), "*Kept* well.");
    assert.equal((await readWorldMeta(dir)).schemaVersion, CHAPTER_SOURCE_SCHEMA_VERSION, "the field's boundary");
    // The first save from the editor makes the chapter the author's: the mark comes off.
    await saveChapter(store, PRODUCTION, added[0]!.file, "Kept well, and then some.", { baseHash: opened.hash });
    const saved = store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!.chapters.find((c) => c.id === added[0]!.id)!;
    assert.equal(saved.source, undefined);
    assert.equal(saved.version, 1, "a direct save keeps the version");
  });

  it("through the coordinator: the host's picker, the read shown with nothing written, then the import; a file that cannot be read is refused", async () => {
    const { root, worldDir } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: NOW });
    await provider.loadWorld(WORLD_ID);
    const events: DomainEvent[] = [];
    const good = join(root, "Draft 3.docx");
    const bad = join(root, "broken.docx");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(good, writeDocx({ title: "Draft 3", subtitle: "", leftOut: 0, words: 1, chapters: [{ title: "A called tide", words: 1, blocks: [{ kind: "paragraph", runs: [{ text: "Called." }] }] }] }));
    await writeFile(bad, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    let picked = good;
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      observeEvent: (event) => events.push(event),
      pickFiles: async () => [picked],
    });
    const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
    try {
      const request = "01J8F3K2QW9VZX4N7M0RTYB6H2";
      await send({ kind: "pick-manuscript", worldId: WORLD_ID, productionId: PRODUCTION, requestId: request });
      const read = events.find((e) => e.type === "manuscript.read-result" && e.requestId === request);
      assert.ok(read && read.type === "manuscript.read-result");
      assert.equal(read.fileName, "Draft 3.docx");
      assert.deepEqual(read.chapters, [{ title: "A called tide", words: 1 }]);
      assert.equal(read.headingLevel, "Heading 1");
      assert.equal(read.leftOut, 1, "the title line stands above the chapters; the empty subtitle counts for nothing");
      assert.ok((read.after ?? 0) > 0);
      const chaptersDir = join(worldDir, "productions", PRODUCTION, "chapters");
      const beforeCount = (await import("node:fs/promises").then((fs) => fs.readdir(chaptersDir))).length;
      await send({ kind: "import-manuscript", worldId: WORLD_ID, productionId: PRODUCTION, requestId: request });
      const imported = events.find((e) => e.type === "manuscript.import-result" && e.requestId === request);
      assert.ok(imported && imported.type === "manuscript.import-result");
      assert.equal(imported.created, 1);
      const afterCount = (await import("node:fs/promises").then((fs) => fs.readdir(chaptersDir))).length;
      assert.equal(afterCount, beforeCount + 1);
      // The same request again is no longer waiting.
      await send({ kind: "import-manuscript", worldId: WORLD_ID, productionId: PRODUCTION, requestId: request });
      const again = events.filter((e) => e.type === "manuscript.import-result" && e.requestId === request).at(-1);
      assert.ok(again && again.type === "manuscript.import-result" && again.reason !== undefined);

      picked = bad;
      const refusedRequest = "01J8F3K2QW9VZX4N7M0RTYB6H3";
      await send({ kind: "pick-manuscript", worldId: WORLD_ID, productionId: PRODUCTION, requestId: refusedRequest });
      const refused = events.find((e) => e.type === "manuscript.read-result" && e.requestId === refusedRequest);
      assert.ok(refused && refused.type === "manuscript.read-result");
      assert.match(refused.reason ?? "", /could not be opened/);
      assert.equal((await import("node:fs/promises").then((fs) => fs.readdir(chaptersDir))).length, afterCount, "a refusal writes nothing");

      // The export through the coordinator lands and reports, with the delivered path.
      await send({ kind: "export-manuscript", worldId: WORLD_ID, productionId: PRODUCTION, format: "epub", language: "en" });
      const progress = events.filter((e) => e.type === "export.progress" && e.exportId.startsWith("ms_"));
      assert.deepEqual(progress.map((e) => e.type === "export.progress" && e.status), ["running", "done"]);
      const done = progress.at(-1);
      assert.ok(done && done.type === "export.progress" && done.output?.startsWith("exports/") && done.output.endsWith(".epub"));
    } finally {
      await provider.close();
    }
  });
});
