import assert from "node:assert/strict";
import { readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { audiobookTextHash, DEFAULT_NARRATOR, pictureLookFor, STORY_EPUB_READING_PROFILE, type StoryPublicationSettings } from "@arke-studio/contracts";
import { inspectStoryImage } from "../../src/publications/story-illustrations.js";
import { writeIllustratedEpub } from "../../src/publications/story-epub.js";
import { manuscriptDocument } from "@arke-studio/contracts";
import { StoryPublicationService } from "../../src/publications/story.js";
import { planAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
import { setAudiobookPicture } from "../../src/productions/audiobook-listening.js";
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

it("requires explicit reading-size choice and host tools without changing original exports", async () => {
  const h = await setup(), original = await h.service.review(h.store, h.productionId, h.settings);
  const settings = { ...h.settings, epubImageSize: "reading" as const };
  const reading = await h.service.review(h.store, h.productionId, settings);
  assert.notEqual(reading.fingerprint, original.fingerprint);
  const unavailable = await h.service.preview(h.store, h.productionId, settings, reading.fingerprint, () => {});
  assert.equal(unavailable.status, "failed"); assert.match(unavailable.error!, /host’s image tools/);
  assert.deepEqual(await readFile(join(h.dir, "world-art.png")), Buffer.from(h.image));
  const originalPreview = await h.service.preview(h.store, h.productionId, h.settings, original.fingerprint, () => {});
  assert.equal(originalPreview.status, "preview", originalPreview.error);
});

it("does not deliver a partial reading edition when image conversion fails", async () => {
  const h = await setup(), service = new StoryPublicationService(h.root, { ffmpeg: { slateFont: "", identity: async () => "fixture-encoder",
    run: async args => { await writeFile(args.at(-1)!, "partial image"); throw new Error("Image encoder stopped"); } } });
  const settings = { ...h.settings, epubImageSize: "reading" as const }, review = await service.review(h.store, h.productionId, settings);
  const failed = await service.preview(h.store, h.productionId, settings, review.fingerprint, () => {});
  assert.equal(failed.status, "failed"); assert.match(failed.error!, /Image encoder stopped/); assert.deepEqual(failed.files, []);
  assert.equal(await service.serve(failed.id, "story.epub"), null);
  assert.equal((await readdir(join(h.root, failed.id, "inputs", "artifacts"))).some(file => file.includes(".tmp.")), false);
  assert.deepEqual(await readFile(join(h.dir, "world-art.png")), Buffer.from(h.image));
});

it("creates a smaller real reading EPUB with captured derivatives, exact placements and retry identity", { skip: process.env.ARKE_STORY_CODEC_SMOKE !== "1" }, async t => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const exec = promisify(execFile), command = process.env.ARKE_FFMPEG ?? "ffmpeg";
  const h = await setup(), noisy = solidImage(3072, 2048, [0, 0, 0, 255]);
  let seed = 1938;
  for (let i = 0; i < noisy.pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; if (i % 4 !== 3) noisy.pixels[i] = seed >>> 24; }
  await writeFile(join(h.root, "noise.png"), encodePng(noisy));
  await exec(command, ["-y", "-i", join(h.root, "noise.png"), "-pix_fmt", "rgb24", "-frames:v", "1", join(h.dir, "world-art.png")], { windowsHide: true, timeout: 60000 });
  const source = await readFile(join(h.dir, "world-art.png"));
  const originalSettings = { ...h.settings, cover: "world-art.png" };
  const originalReview = await h.service.review(h.store, h.productionId, originalSettings);
  const original = await h.service.preview(h.store, h.productionId, originalSettings, originalReview.fingerprint, () => {});
  assert.equal(original.status, "preview", original.error);
  const originalBytes = await readFile((await h.service.previewMedia(original.id, "story.epub"))!.path);
  const calls: string[][] = [];
  const identity = (await exec(command, ["-version"], { windowsHide: true })).stdout.split("\n")[0]!;
  const service = new StoryPublicationService(h.root, { ffmpeg: { slateFont: "", identity: async () => identity,
    run: async (args, _progress, signal) => { calls.push(args); await exec(command, args, { windowsHide: true, signal, timeout: 60000, maxBuffer: 4 * 1024 ** 2 }); } } });
  const settings = { ...originalSettings, epubImageSize: "reading" as const };
  const review = await service.review(h.store, h.productionId, settings);
  const cancelled = await service.preview(h.store, h.productionId, settings, review.fingerprint, edition => { if (edition.phase === "Preparing EPUB") service.cancel(edition.id); });
  assert.equal(cancelled.status, "cancelled", cancelled.error);
  assert.equal(calls.length, 1, "repeated placements and cover share one derivative");
  const frozen = JSON.parse(await readFile(join(h.root, cancelled.id, "inputs.json"), "utf8"));
  assert.deepEqual(frozen.epubImages.profile, STORY_EPUB_READING_PROFILE); assert.equal(frozen.epubImages.encoder, identity);
  assert.equal(frozen.compiler.compilerVersion, "5"); assert.equal(frozen.media.length, 2);
  const fitted = frozen.epubImages.images[0]; assert.equal(fitted.width, 2048); assert.equal(fitted.height, 1365);
  assert.ok(Math.abs(fitted.width / fitted.height - 1.5) < .001);
  const independent = new StoryPublicationService(h.root);
  const preview = await independent.retry(cancelled.id, () => {});
  assert.equal(preview.status, "preview", preview.error); assert.equal(calls.length, 1, "retry reuses captured rendition without an encoder");
  const ready = await independent.create(h.store, h.productionId, preview.id);
  const bytes = await readFile((await independent.serve(ready.id, "story.epub"))!.path);
  assert.ok(bytes.length < originalBytes.length / 2, `${bytes.length} should be smaller than original ${originalBytes.length}`);
  t.diagnostic(`Measured fixture EPUB: original ${originalBytes.length} bytes; reading ${bytes.length} bytes. This fixture is not the full story.`);
  assert.equal(ready.files[0]!.bytes, bytes.length);
  assert.equal(text(bytes, "chapter-1.xhtml"), text(originalBytes, "chapter-1.xhtml").replaceAll(".png", ".jpg"));
  assert.equal(text(bytes, "nav.xhtml"), text(originalBytes, "nav.xhtml"));
  assert.match(text(bytes, "package.opf"), /href="cover.jpg" media-type="image\/jpeg"/);
  const packed = Buffer.from(zipEntry(bytes, "OEBPS/illustration-1.jpg")!);
  assert.deepEqual(inspectStoryImage(packed), { width: 2048, height: 1365, mediaType: "image/jpeg" });
  assert.deepEqual(Buffer.from(zipEntry(bytes, "OEBPS/cover.jpg")!), packed);
  assert.deepEqual(await readFile((await independent.previewMedia(ready.id, "illustration-1.jpg"))!.path), packed);
  assert.deepEqual(await readFile((await independent.previewMedia(ready.id, "cover"))!.path), packed);
  assert.deepEqual(await readFile(join(h.dir, "world-art.png")), source, "world original unchanged");
  assert.deepEqual(await readFile(join(h.root, ready.id, "inputs", fitted.source)), source, "original capture retained");
  assert.deepEqual(await readFile((await h.service.previewMedia(original.id, "story.epub"))!.path), originalBytes, "existing edition unchanged");
  await writeFile(join(h.dir, "world-art.png"), h.image);
  assert.deepEqual(await readFile((await independent.previewMedia(ready.id, "illustration-1.jpg"))!.path), packed);
  await writeFile(join(h.root, ready.id, "inputs", fitted.file), "damaged");
  assert.equal(await independent.previewMedia(ready.id, "illustration-1.jpg"), null);
});

it("preserves alpha and avoids upscaling reading-size PNGs", { skip: process.env.ARKE_STORY_CODEC_SMOKE !== "1" }, async () => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const exec = promisify(execFile), command = process.env.ARKE_FFMPEG ?? "ffmpeg";
  const h = await setup();
  const transparent = encodePng(solidImage(32, 64, [24, 48, 96, 80])); await writeFile(join(h.dir, "world-art.png"), transparent);
  const service = new StoryPublicationService(h.root, { ffmpeg: { slateFont: "", identity: async () => "fixture-encoder",
    run: async (args, _progress, signal) => { await exec(command, args, { windowsHide: true, signal, timeout: 60000 }); } } });
  const settings = { ...h.settings, epubImageSize: "reading" as const }, review = await service.review(h.store, h.productionId, settings);
  const preview = await service.preview(h.store, h.productionId, settings, review.fingerprint, () => {});
  assert.equal(preview.status, "preview", preview.error);
  const fitted = await readFile((await service.previewMedia(preview.id, "illustration-1.png"))!.path);
  const { decodePng } = await import("../../src/references/png.js");
  const decoded = decodePng(fitted); assert.equal(decoded.width, 32); assert.equal(decoded.height, 64); assert.equal(decoded.pixels[3], 80);
});

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


it("publishes an explicitly reaffirmed retained picture and blocks a later look change", async () => {
  const h = await setup();
  const look = { chapterHash: "h", at: "2026-10-20T00:00:00Z", characters: { maren: { name: "Maren", text: "Grey coat." } } };
  await updateAudiobook(h.store, h.productionId, h.plan.chapter, record => ({ ...record, look: { ...look, characters: { maren: { name: "Maren", text: "Grey coat, marked cuffs." } } }, pictures: { ...record.pictures, "p0.0": { ...record.pictures!["p0.0"]!, look: pictureLookFor(look, ["maren"])! } } }));
  assert.ok((await h.service.review(h.store, h.productionId, h.settings)).blockers.some(row => row.includes("changed look")));
  const kept = await setAudiobookPicture(h.store, h.productionId, h.chapter.file, "p0.0", { file: "world-art.png", source: "world" });
  assert.equal(kept.pictures!["p0.0"]!.look!.hash, pictureLookFor(look, ["maren"])!.hash);
  const review = await h.service.review(h.store, h.productionId, h.settings); assert.deepEqual(review.blockers, []);
  const edition = await h.service.preview(h.store, h.productionId, h.settings, review.fingerprint, () => {});
  assert.equal(edition.status, "preview", edition.error);
  await updateAudiobook(h.store, h.productionId, h.plan.chapter, record => ({ ...record, look: { ...look, characters: { maren: { name: "Maren", text: "Red coat." } } } }));
  assert.ok((await h.service.review(h.store, h.productionId, h.settings)).blockers.some(row => row.includes("changed look")));
  await assert.rejects(h.service.create(h.store, h.productionId, edition.id), /changed look|source changed/);
});
