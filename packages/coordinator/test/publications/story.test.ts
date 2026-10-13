import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { StoryPublicationSettings } from "@arke-studio/contracts";
import { StoryPublicationService } from "../../src/publications/story.js";
import { readStoryPublication } from "../../src/publications/story-review.js";
import { openChapter } from "../../src/productions/ops.js";
import { ProseAuthoringService } from "../../src/application/prose-authoring.js";
import { zipEntry } from "../../src/world-chat/document-text.js";
import { WorldStore } from "../../src/world/store.js";
import { closeOnCleanup, tempDir } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";
async function setup() {
  const dir = await makeTempWorld(), root = await tempDir("arke-story-publications-");
  const store = await WorldStore.open(dir);
  closeOnCleanup(() => store.close());
  const production = store.getBundle().productions.find(row => row.meta.id === "the-ledger-of-nights")!;
  const chapter = production.chapters.find(row => (row.words ?? 0) > 0) ?? production.chapters[0]!;
  const opened = await openChapter(store, production.meta.id, chapter.id);
  await new ProseAuthoringService(store).save(production.meta.id, chapter.file, "Maren turned—she knew the voice.\n\nThe room was still.", { baseHash: opened.hash });
  const settings: StoryPublicationSettings = { title: "Salt & Light", author: "A. Writer", language: "en-GB", label: "Private first edition", description: "A story <for> friends", cover: null, chapterIds: [chapter.id], outputs: ["epub"], avoidEmDashes: false };
  return { store, dir, root, productionId: production.meta.id, chapter, settings, service: new StoryPublicationService(root) };
}
describe("private story publication", () => {
  it("creates the previewed EPUB with metadata, then serves that immutable edition after source edits", async () => {
    const h = await setup();
    const review = await h.service.review(h.store, h.productionId, h.settings);
    assert.deepEqual(review.blockers, []);
    const preview = await h.service.preview(h.store, h.productionId, h.settings, review.fingerprint, () => {});
    assert.equal(preview.status, "preview", preview.error);
    const ready = await h.service.create(h.store, h.productionId, preview.id);
    assert.equal(ready.status, "ready");
    const served = await h.service.serve(ready.id, "story.epub");
    assert.ok(served);
    const bytes = await readFile(served.path);
    const opf = new TextDecoder().decode(zipEntry(bytes, "OEBPS/package.opf")!);
    assert.match(opf, /<dc:creator>A. Writer<\/dc:creator>/);
    assert.match(opf, /Salt &amp; Light/);
    assert.match(opf, /en-GB/);
    assert.match(new TextDecoder().decode(zipEntry(bytes, "OEBPS/chapter-1.xhtml")!), /Maren turned—she knew the voice/);
    const current = await openChapter(h.store, h.productionId, h.chapter.id);
    await new ProseAuthoringService(h.store).save(h.productionId, h.chapter.file, "A different story.", { baseHash: current.hash });
    assert.equal((await h.service.list())[0]!.fingerprint, ready.fingerprint);
    assert.deepEqual(await readFile((await h.service.serve(ready.id, "story.epub"))!.path), bytes);
  });
  it("refuses source changes after preview and never relabels a damaged edition as ready", async () => {
    const h = await setup();
    const review = await h.service.review(h.store, h.productionId, h.settings);
    const preview = await h.service.preview(h.store, h.productionId, h.settings, review.fingerprint, () => {});
    assert.equal(preview.status, "preview", preview.error);
    const current = await openChapter(h.store, h.productionId, h.chapter.id);
    await new ProseAuthoringService(h.store).save(h.productionId, h.chapter.file, "Changed.", { baseHash: current.hash });
    await assert.rejects(h.service.create(h.store, h.productionId, preview.id), /source changed/);
    await writeFile(join(h.root, preview.id, "files", "story.epub"), "damaged");
    assert.equal(await h.service.serve(preview.id, "story.epub"), null);
    assert.match((await h.service.list())[0]!.error!, /missing or changed/);
  });
  it("keeps em-dash review optional, requires individual approval, and rejects a stale proposal", async () => {
    const h = await setup();
    assert.equal((await h.service.review(h.store, h.productionId, h.settings)).findings.length, 0);
    const settings = { ...h.settings, avoidEmDashes: true };
    const review = await h.service.review(h.store, h.productionId, settings), finding = review.findings[0]!;
    assert.ok(finding);
    const blocked = await h.service.preview(h.store, h.productionId, settings, review.fingerprint, () => {});
    assert.equal(blocked.status, "failed");
    assert.match(blocked.error!, /remaining style suggestions/);
    const kept = await h.service.decide(h.store, h.productionId, settings, finding, "keep", finding.before);
    assert.ok(kept.findings[0]!.kept);
    const before = await openChapter(h.store, h.productionId, h.chapter.id);
    assert.equal(before.hash, finding.baseHash, "Keep original writes no manuscript");
    await h.service.decide(h.store, h.productionId, settings, finding, "apply", "Maren turned. She knew the voice.");
    const after = await openChapter(h.store, h.productionId, h.chapter.id);
    assert.match(after.body, /Maren turned\. She knew the voice\./);
    assert.ok(after.versions.includes(before.version), "the ordinary undo history retains the approved source");
    await assert.rejects(h.service.decide(h.store, h.productionId, settings, finding, "apply", "Stale replacement."), /source changed/);
    assert.equal((await openChapter(h.store, h.productionId, h.chapter.id)).hash, after.hash);
  });
  it("does not skip missing narration, but permits an explicit book-only edition", async () => {
    const h = await setup(), settings = { ...h.settings, outputs: ["epub", "m4b"] as ("epub" | "m4b")[] };
    const review = await h.service.review(h.store, h.productionId, settings);
    assert.ok(review.chapters[0]!.audioProblems.length > 0);
    const preview = await h.service.preview(h.store, h.productionId, settings, review.fingerprint, () => {});
    assert.equal(preview.status, "failed");
    assert.ok(preview.files.length === 0);
    const book = await h.service.review(h.store, h.productionId, h.settings);
    assert.equal((await h.service.preview(h.store, h.productionId, h.settings, book.fingerprint, () => {})).status, "preview");
  });
  it("honours cancellation and keeps completed files independent of the source world", async () => {
    const h = await setup(), review = await h.service.review(h.store, h.productionId, h.settings);
    const cancelled = await h.service.preview(h.store, h.productionId, h.settings, review.fingerprint, edition => { if (edition.phase === "Capturing source") h.service.cancel(edition.id); });
    assert.equal(cancelled.status, "cancelled");
    const preview = await h.service.preview(h.store, h.productionId, h.settings, review.fingerprint, () => {});
    const ready = await h.service.create(h.store, h.productionId, preview.id);
    await h.store.close();
    await rename(h.dir, h.dir + "-moved");
    assert.ok(await new StoryPublicationService(h.root).serve(ready.id, "story.epub"));
  });
  it("uses the exact source selection and flags unsupported formatting as a blocker", async () => {
    const h = await setup();
    const opened = await openChapter(h.store, h.productionId, h.chapter.id);
    await new ProseAuthoringService(h.store).save(h.productionId, h.chapter.file, "# A heading\n\nText.", { baseHash: opened.hash });
    const result = await h.store.ownedRead(() => readStoryPublication(h.store, h.productionId, h.settings));
    assert.match(result.review.blockers.join(" "), /Headings/);
  });
});


async function narrate(h: Awaited<ReturnType<typeof setup>>) {
  const { DEFAULT_NARRATOR, audiobookTextHash } = await import("@arke-studio/contracts");
  const { planAudiobook, updateAudiobook } = await import("../../src/productions/audiobook.js");
  const { fileGeneratedArtifact } = await import("../../src/artifacts/filing.js");
  const { writeSpeechWav } = await import("../../src/audio/speech-wav.js");
  const plan = await planAudiobook(h.store, h.productionId, h.chapter.id, { narrator: DEFAULT_NARRATOR });
  const takes: import("@arke-studio/contracts").ChapterAudiobook["takes"] = {};
  for (const [index, row] of plan.blocks.entries()) {
    const sourcePath = join(h.root, "voice-" + index + ".wav");
    const samples = Float32Array.from({ length: 24000 }, (_, n) => 0.2 * Math.sin(2 * Math.PI * (220 + index * 110) * n / 24000));
    await writeFile(sourcePath, writeSpeechWav({ rate: 24000, samples }));
    const generation = { source: "audiobook" as const, productionId: h.productionId, chapterId: h.chapter.id, chapterVersion: plan.chapter.version,
      block: row.block.key, paragraph: row.block.paragraph, textHash: audiobookTextHash(row.block.text), provider: row.assigned.provider,
      model: row.assigned.model, voiceId: row.assigned.voiceId, parts: 1, characters: row.block.text.length, estimatedMicroUsd: 0, costMicroUsd: 0 };
    const artifact = await fileGeneratedArtifact(h.store, { sourcePath, generation, production: h.productionId,
      mediaProbe: { durationSec: async () => 1, info: async () => ({ durationSec: 1, hasAudio: true }) } });
    takes[row.block.key] = { artifactId: artifact.id, textHash: generation.textHash, reader: row.assigned, assigned: row.assigned,
      format: "wav", characters: generation.characters, parts: 1, estimatedMicroUsd: 0, costMicroUsd: 0, madeAt: new Date().toISOString() };
  }
  await updateAudiobook(h.store, h.productionId, plan.chapter, record => ({ ...record, takes }));
  await h.store.reload();
  return { plan, takes };
}
describe("publication narration identity", () => {
  it("flags only the recording whose spoken text changed, and undo restores its exact dependency", async () => {
    const h = await setup();
    await narrate(h);
    const settings = { ...h.settings, avoidEmDashes: true, outputs: ["epub", "m4b"] as ("epub" | "m4b")[] };
    const review = await h.service.review(h.store, h.productionId, settings);
    assert.deepEqual(review.blockers, []);
    assert.deepEqual(review.chapters[0]!.audioProblems, []);
    const finding = review.findings[0]!, before = await openChapter(h.store, h.productionId, h.chapter.id);
    await h.service.decide(h.store, h.productionId, settings, finding, "keep", finding.before);
    assert.deepEqual((await h.service.review(h.store, h.productionId, settings)).chapters[0]!.audioProblems, []);
    const changed = await h.service.decide(h.store, h.productionId, settings, finding, "apply", "Maren turned. She knew the voice.");
    assert.deepEqual(changed.chapters[0]!.audioProblems, ["Block p0.0: needs updating."]);
    await new ProseAuthoringService(h.store).restore(h.productionId, h.chapter.file, before.version);
    assert.deepEqual((await h.service.review(h.store, h.productionId, settings)).chapters[0]!.audioProblems, []);
  });
  it("keeps presentation-only spacing current without making new audio", async () => {
    const h = await setup(); await narrate(h);
    const before = await openChapter(h.store, h.productionId, h.chapter.id);
    await new ProseAuthoringService(h.store).save(h.productionId, h.chapter.file, before.body.replace("room", "  room"), { baseHash: before.hash });
    const review = await h.service.review(h.store, h.productionId, { ...h.settings, outputs: ["m4b"] });
    assert.deepEqual(review.chapters[0]!.audioProblems, []);
  });
  it("restores only the matching frozen file and never accepts another book", async () => {
    const h = await setup(), review = await h.service.review(h.store, h.productionId, h.settings);
    const preview = await h.service.preview(h.store, h.productionId, h.settings, review.fingerprint, () => {});
    await h.service.create(h.store, h.productionId, preview.id);
    const path = (await h.service.serve(preview.id, "story.epub"))!.path;
    const copy = join(h.root, "saved.epub"); await writeFile(copy, await readFile(path));
    await writeFile(path, "damaged");
    const wrong = join(h.root, "wrong.epub"); await writeFile(wrong, "another book");
    await assert.rejects(h.service.restoreFile(preview.id, "story.epub", wrong), /hash or length/);
    assert.equal(await h.service.serve(preview.id, "story.epub"), null);
    await h.service.restoreFile(preview.id, "story.epub", copy);
    assert.ok(await h.service.serve(preview.id, "story.epub"));
    assert.equal((await h.service.list())[0]!.status, "ready");
  });
  it("refuses replaced media bytes even though the take record still says made", async () => {
    const h = await setup(); const { takes } = await narrate(h);
    const artifact = h.store.getBundle().artifacts.find(row => row.id === takes["p0.0"]!.artifactId)!;
    await writeFile(join(h.dir, "artifacts", artifact.file), "changed");
    const settings = { ...h.settings, outputs: ["m4b"] as ("epub" | "m4b")[] };
    const review = await h.service.review(h.store, h.productionId, settings);
    assert.match(review.blockers.join(" "), /changed or unreadable/);
  });
  it("retries a failed encoder against captured inputs and verifies both outputs before completion", async () => {
    const h = await setup(); await narrate(h);
    let fail = true, duration = 0, encoded = 0;
    const service = new StoryPublicationService(h.root, {
      ffmpeg: { slateFont: "", run: async args => {
        encoded++; if (fail) throw new Error("Disk full");
        const metaFile = args[args.indexOf("-map") - 1]!;
        const text = await readFile(metaFile, "utf8");
        duration = Math.max(...[...text.matchAll(/^END=(\d+)$/gm)].map(match => Number(match[1]) / 1000));
        assert.ok(args.includes("aac")); assert.ok(args.includes("-map_chapters"));
        await writeFile(args.at(-1)!, "encoded audiobook");
      } },
      probe: { durationSec: async () => duration, info: async () => ({ durationSec: duration, hasAudio: true }) },
    });
    const settings = { ...h.settings, outputs: ["epub", "m4b"] as ("epub" | "m4b")[] };
    const review = await service.review(h.store, h.productionId, settings);
    const failed = await service.preview(h.store, h.productionId, settings, review.fingerprint, () => {});
    assert.equal(failed.status, "failed", failed.error); assert.match(failed.error!, /Disk full/);
    assert.equal(await service.serve(failed.id, "story.epub"), null, "a partial build is not deliverable");
    fail = false;
    const preview = await service.retry(failed.id, () => {});
    assert.equal(preview.status, "preview", preview.error); assert.equal(preview.id, failed.id);
    assert.deepEqual(preview.files.map(file => file.format), ["epub", "m4b"]);
    assert.equal((await service.create(h.store, h.productionId, preview.id)).status, "ready");
    const attempts = encoded;
    await service.retry(preview.id, () => {}); assert.equal(encoded, attempts, "a completed edition is never rebuilt");
  });
});


it("writes a real AAC M4B with ordered chapters, author and cover", { skip: process.env.ARKE_STORY_CODEC_SMOKE !== "1" }, async () => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const probe = async (path: string) => JSON.parse((await exec(process.env.ARKE_FFPROBE ?? "ffprobe", ["-v", "error", "-show_streams", "-show_chapters", "-show_format", "-of", "json", path], { windowsHide: true, timeout: 30000 })).stdout);
  const h = await setup(); await narrate(h);
  const second = h.store.getBundle().productions.find(row => row.meta.id === h.productionId)!.chapters.find(row => row.id !== h.chapter.id)!;
  const opened = await openChapter(h.store, h.productionId, second.id);
  await new ProseAuthoringService(h.store).save(h.productionId, second.file, "A second chapter, with *emphasis*.\n\n***\n\nThe ending.", { baseHash: opened.hash });
  await narrate({ ...h, chapter: second });
  await exec(process.env.ARKE_FFMPEG ?? "ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=32x48", "-frames:v", "1", join(h.dir, "world-art.png")], { windowsHide: true, timeout: 30000 });
  const service = new StoryPublicationService(h.root, {
    ffmpeg: { slateFont: "", run: async (args, _progress, signal) => { await exec(process.env.ARKE_FFMPEG ?? "ffmpeg", args, { signal, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); } },
    probe: { durationSec: async path => Number((await probe(path)).format.duration), info: async path => { const read = await probe(path); return { durationSec: Number(read.format.duration), hasAudio: read.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio") }; } },
  });
  const settings = { ...h.settings, outputs: ["epub", "m4b"] as ("epub" | "m4b")[], chapterIds: [second.id, h.chapter.id], cover: "world-art.png" };
  const review = await service.review(h.store, h.productionId, settings);
  assert.deepEqual(review.blockers, []); assert.deepEqual(review.chapters.flatMap(row => row.audioProblems), []);
  const preview = await service.preview(h.store, h.productionId, settings, review.fingerprint, () => {});
  assert.equal(preview.status, "preview", preview.error);
  const audio = await service.serve(preview.id, "story.m4b"); assert.ok(audio);
  const info = await probe(audio.path);
  assert.equal(info.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio").codec_name, "aac");
  assert.equal(info.chapters.length, 2);
  assert.deepEqual(info.chapters.map((chapter: { tags: { title: string } }) => chapter.tags.title), review.chapters.map(chapter => chapter.title), "input selection never changes manuscript order");
  assert.equal(info.format.tags.title, settings.title);
  assert.equal(info.format.tags.artist, settings.author);
  assert.ok(info.streams.some((stream: { disposition: { attached_pic: number } }) => stream.disposition.attached_pic === 1));
  const page = await service.previewPage(preview.id, 1);
  assert.match(page.html, /<em>emphasis<\/em>/);
  const epub = await service.serve(preview.id, "story.epub"); assert.ok(epub);
  const epubBytes = await readFile(epub.path);
  assert.ok(zipEntry(epubBytes, "OEBPS/cover.png"));
  assert.equal((await service.create(h.store, h.productionId, preview.id)).status, "ready");
  if (process.env.ARKE_STORY_SMOKE_OUTPUT) {
    const { copyFile, mkdir } = await import("node:fs/promises");
    await mkdir(process.env.ARKE_STORY_SMOKE_OUTPUT, { recursive: true });
    await copyFile(epub.path, join(process.env.ARKE_STORY_SMOKE_OUTPUT, "story.epub"));
    await copyFile(audio.path, join(process.env.ARKE_STORY_SMOKE_OUTPUT, "story.m4b"));
    await writeFile(join(process.env.ARKE_STORY_SMOKE_OUTPUT, "ffprobe.json"), JSON.stringify(info, null, 2));
  }
});

