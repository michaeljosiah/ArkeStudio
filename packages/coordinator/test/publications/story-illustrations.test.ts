import assert from "node:assert/strict";
import { readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { audiobookTextHash, DEFAULT_NARRATOR, type StoryPublicationSettings } from "@arke-studio/contracts";
import { writeIllustratedEpub } from "../../src/publications/story-epub.js";
import { manuscriptDocument } from "@arke-studio/contracts";
import { StoryPublicationService } from "../../src/publications/story.js";
import { planAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
import { openChapter } from "../../src/productions/ops.js";
import { ProseAuthoringService } from "../../src/application/prose-authoring.js";
import { zipEntry } from "../../src/world-chat/document-text.js";
import { WorldStore } from "../../src/world/store.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { closeOnCleanup, tempDir } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";

async function setup() {
  const dir = await makeTempWorld(), root = await tempDir("arke-illustrated-story-");
  const store = await WorldStore.open(dir); closeOnCleanup(() => store.close());
  const productionId = "the-ledger-of-nights", chapter = store.getBundle().productions.find(row => row.meta.id === productionId)!.chapters[0]!;
  const opened = await openChapter(store, productionId, chapter.id);
  await new ProseAuthoringService(store).save(productionId, chapter.file, "Maren found **the ledger**.\n\n***\n\nThe room was still.", { baseHash: opened.hash });
  const image = encodePng(solidImage(32, 24, [24, 48, 96, 255])); await writeFile(join(dir, "world-art.png"), image);
  const plan = await planAudiobook(store, productionId, chapter.id, { narrator: DEFAULT_NARRATOR });
  await updateAudiobook(store, productionId, plan.chapter, record => ({ ...record, pictures: Object.fromEntries([...plan.blocks].reverse().map(({ block }, index) => [block.key, {
    file: "world-art.png", source: "world" as const, textHash: audiobookTextHash(block.text), at: "2026-10-20T00:00:00Z",
    shot: { frame: `Harbour & ledger <${index}>`, inFrame: [], notInFrame: [], expressions: {}, details: [], checks: [] },
  }])) }));
  const settings: StoryPublicationSettings = { title: "The Ledger", author: "Writer", language: "en", label: "Illustrated", description: "", cover: null, chapterIds: [chapter.id], outputs: ["epub"], avoidEmDashes: false, includeIllustrations: true };
  return { dir, root, store, productionId, chapter, plan, settings, image, service: new StoryPublicationService(root) };
}
const text = (bytes: Uint8Array, name: string) => new TextDecoder().decode(zipEntry(bytes, "OEBPS/" + name)!);

it("captures attached pictures in manuscript order with exact prose, alt text and a world-independent preview", async () => {
  const h = await setup(), review = await h.service.review(h.store, h.productionId, h.settings);
  assert.deepEqual(review.blockers, []); assert.deepEqual(review.chapters[0]!.audioProblems, [], "illustrated books need no recordings");
  const preview = await h.service.preview(h.store, h.productionId, h.settings, review.fingerprint, () => {});
  assert.equal(preview.status, "preview", preview.error);
  const ready = await h.service.create(h.store, h.productionId, preview.id);
  const bytes = await readFile((await h.service.serve(ready.id, "story.epub"))!.path);
  assert.equal(bytes.readUInt16LE(8), 0, "mimetype is stored");
  assert.equal(bytes.readUInt16LE(28), 0, "mimetype has no local extra field");
  const chapter = text(bytes, "chapter-1.xhtml"), manifest = text(bytes, "package.opf");
  assert.equal((chapter.match(/<figure/g) ?? []).length, 3);
  assert.ok(chapter.indexOf("illustration-1.png") < chapter.indexOf("illustration-2.png"));
  assert.ok(chapter.indexOf("illustration-2.png") < chapter.indexOf("Maren found"));
  assert.ok(chapter.indexOf("illustration-3.png") > chapter.indexOf('class="break"'));
  assert.match(chapter, /Maren found <strong>the ledger<\/strong>\./);
  assert.match(chapter, /alt="Harbour &amp; ledger &lt;2&gt;"/);
  for (let index = 1; index <= 3; index++) {
    assert.match(manifest, new RegExp(`href="illustration-${index}\\.png" media-type="image/png"`));
    assert.deepEqual(Buffer.from(zipEntry(bytes, `OEBPS/illustration-${index}.png`)! ), Buffer.from(h.image));
  }
  const frozen = JSON.parse(await readFile(join(h.root, ready.id, "inputs.json"), "utf8"));
  assert.equal(frozen.media.length, 1, "the same input is captured only once");
  assert.equal(frozen.compiler.compilerVersion, "4");
  await rename(join(h.dir, "world-art.png"), join(h.dir, "removed-image.png"));
  await h.store.close();
  await rename(h.dir, join(h.root, "removed-source-world"));
  const savedEdition = await readFile(join(h.root, ready.id, "edition.json"));
  const independent = new StoryPublicationService(h.root);
  assert.deepEqual(await readFile((await independent.previewMedia(ready.id, "illustration-1.png"))!.path), Buffer.from(h.image));
  assert.equal(await independent.previewMedia(ready.id, "illustration-4.png"), null);
  assert.equal(await independent.previewMedia(ready.id, "../inputs.json"), null);
  assert.match((await independent.previewPage(ready.id, 0)).html, /illustration-1.png/);
  assert.deepEqual(await readFile((await independent.serve(ready.id, "story.epub"))!.path), bytes);
  assert.deepEqual(await readFile(join(h.root, ready.id, "edition.json")), savedEdition, "reading after source removal does not change the ready edition");
});

it("refuses missing and changed bindings only when illustrations are explicitly selected", async () => {
  const h = await setup();
  await updateAudiobook(h.store, h.productionId, h.plan.chapter, record => ({ ...record, pictures: { ...record.pictures, "p0.0": { ...record.pictures!["p0.0"]!, textHash: "text-v1:old" } } }));
  assert.ok((await h.service.review(h.store, h.productionId, h.settings)).blockers.some(row => row.includes("earlier text")));
  await rename(join(h.dir, "world-art.png"), join(h.dir, "gone.png"));
  const missing = await h.service.review(h.store, h.productionId, h.settings);
  assert.ok(missing.blockers.some(row => row.includes("picture title")));
  const plain = { ...h.settings, includeIllustrations: false };
  const review = await h.service.review(h.store, h.productionId, plain); assert.deepEqual(review.blockers, []);
  const edition = await h.service.preview(h.store, h.productionId, plain, review.fingerprint, () => {});
  assert.equal(edition.status, "preview", edition.error);
  const bytes = await readFile((await h.service.previewMedia(edition.id, "story.epub"))!.path);
  assert.doesNotMatch(text(bytes, "package.opf"), /illustration-/);
  assert.doesNotMatch(text(bytes, "chapter-1.xhtml"), /<figure/);
});

it("retries frozen illustrations after source changes and refuses stale Create or tampered capture", async () => {
  const h = await setup(), review = await h.service.review(h.store, h.productionId, h.settings);
  const cancelled = await h.service.preview(h.store, h.productionId, h.settings, review.fingerprint, edition => { if (edition.phase === "Preparing EPUB") h.service.cancel(edition.id); });
  assert.equal(cancelled.status, "cancelled");
  await writeFile(join(h.dir, "world-art.png"), encodePng(solidImage(32, 24, [255, 0, 0, 255])));
  const retry = await h.service.retry(cancelled.id, () => {}); assert.equal(retry.status, "preview", retry.error);
  const image = await h.service.previewMedia(retry.id, "illustration-1.png"); assert.deepEqual(await readFile(image!.path), Buffer.from(h.image));
  await assert.rejects(h.service.create(h.store, h.productionId, retry.id), /source changed/);
  await writeFile(image!.path, "damaged"); assert.equal(await h.service.previewMedia(retry.id, "illustration-1.png"), null);
});

it("refuses changed captured bytes during streaming and removes only its unfinished ZIP", async () => {
  const root = await tempDir("arke-epub-stream-"), image = encodePng(solidImage(4, 4, [20, 30, 40, 255]));
  await writeFile(join(root, "image.png"), image);
  const document = manuscriptDocument({ title: "Test", worldName: "", chapters: [{ title: "One", body: "The ledger opened." }] });
  const options = { identifier: "urn:uuid:00000000-0000-4000-8000-000000000001", language: "en", modified: "2026-10-20T00:00:00Z" };
  await assert.rejects(writeIllustratedEpub(document, options, [{ chapter: 0, paragraph: 0, file: "image.png", alt: "A ledger", mediaType: "image/png" }], [{ file: "image.png", sha256: "0".repeat(64), byteLength: image.length }], root, join(root, "story.epub"), new AbortController().signal), /changed|match|digest/i);
  assert.deepEqual(await readdir(root), ["image.png"]);
  const stop = new AbortController(); stop.abort();
  await assert.rejects(writeIllustratedEpub(document, options, [], [], root, join(root, "story.epub"), stop.signal));
  assert.deepEqual(await readdir(root), ["image.png"]);
});

it("refuses Create when a new invalid picture leaves the captured image list unchanged", async () => {
  const h = await setup(), review = await h.service.review(h.store, h.productionId, h.settings);
  const preview = await h.service.preview(h.store, h.productionId, h.settings, review.fingerprint, () => {});
  assert.equal(preview.status, "preview", preview.error);
  await updateAudiobook(h.store, h.productionId, h.plan.chapter, record => ({ ...record, pictures: { ...record.pictures,
    "p999.0": { file: "missing.png", source: "world", textHash: "text-v1:unknown", at: "2026-10-21T00:00:00Z" },
  } }));
  const changed = await h.service.review(h.store, h.productionId, h.settings);
  assert.equal(changed.fingerprint, review.fingerprint, "successful picture rows still match the captured edition");
  assert.ok(changed.blockers.some(row => row.includes("p999.0")));
  await assert.rejects(h.service.create(h.store, h.productionId, preview.id), /picture p999\.0 is missing/);
  assert.equal((await h.service.list()).find(row => row.id === preview.id)?.status, "preview");
});
