import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChapterAudiobookSchema, audiobookTextHash, initialAudioArrangement, newAudioClip, DEFAULT_NARRATOR, type AudioArrangementEdit } from "@arke-studio/contracts";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { openAudioStudio, editAudioStudio, stageAudioStudioProposal, decideAudioStudioProposal, audioStudioSnapshot } from "../../src/productions/audio-studio.js";
import { readAudioStudioSource } from "../../src/productions/audio-studio-source.js";
import { readStereoWav, resampleStereo, writeStereoWav } from "../../src/audio/stereo-wav.js";
import { AUDIO_STUDIO_SCHEMA_VERSION } from "../../src/world/commit.js";
import { planAudiobook, readAudiobook, updateAudiobook, writeAudiobookBook } from "../../src/productions/audiobook.js";
import { audiobookListening } from "../../src/productions/audiobook-listening.js";
import { exportAudiobookPlayer } from "../../src/productions/audiobook-export.js";
import type { WorldStore } from "../../src/world/store.js";
import { importAudioStudioMedia } from "../../src/productions/audio-studio-import.js";
import { fileArtifact, fileGeneratedArtifact } from "../../src/artifacts/filing.js";

const PRODUCTION = "the-ledger-of-nights", CHAPTER = "01-neap";
const addTrack: AudioArrangementEdit = { kind: "commands", label: "Add sound effects track", commands: [{ kind: "add-track", track: { id: "fx", name: "Sound effects", gainDb: -6, muted: false } }] };
async function fixture(run: (store: WorldStore, worldDir: string) => Promise<void>) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  try { await run(provider.openStore!()!, worldDir); } finally { await provider.close(); }
}
describe("Audio Studio durable authority", () => {
  it("refuses an oversized valid legacy recovery record without changing its bytes", () => fixture(async (store, dir) => {
    const plan = await planAudiobook(store, PRODUCTION, CHAPTER, { narrator: DEFAULT_NARRATOR });
    const timing = { artifactId: `ar_${WORLD_ID}`, audioHash: `sha256:${"a".repeat(64)}`, textHash: "words", engine: { id: "test", version: "1", model: "test" }, seconds: 19000, at: store.now(),
      words: Array.from({ length: 19000 }, (_, i) => ({ text: "x".repeat(500), startSec: i, endSec: i + 1, probability: 1 })) };
    await updateAudiobook(store, PRODUCTION, plan.chapter, current => ({ ...current, wordTiming: { first: timing, second: timing } }));
    const path = join(dir, "productions", PRODUCTION, ".audiobook", "chapters", `${CHAPTER}.json`), original = await readFile(path, "utf8");
    assert.ok(original.length > 16 * 1024 * 1024); assert.notEqual(await readAudiobook(store, PRODUCTION, CHAPTER), "unreadable");
    const opened = await openAudioStudio(store, PRODUCTION, CHAPTER);
    await assert.rejects(editAudioStudio(store, PRODUCTION, CHAPTER, opened.base, addTrack), /recovery record/);
    assert.equal(await readFile(path, "utf8"), original);
  }));
  it("preserves takes made by the book's selected narrator during migration", () => fixture(async (store, dir) => {
    const narrator = { ...DEFAULT_NARRATOR, voiceId: "af_heart", label: "Heart" };
    await writeAudiobookBook(store, PRODUCTION, { schemaVersion: 1, reading: "narrator", narrator });
    const plan = await planAudiobook(store, PRODUCTION, CHAPTER, { narrator }), row = plan.blocks[0]!;
    const sourcePath = join(dir, "heart.wav"), samples = new Float32Array(4800).fill(.1);
    await writeFile(sourcePath, writeStereoWav({ rate: 48000, channels: 2, left: samples, right: samples }));
    const textHash = audiobookTextHash(row.block.text);
    const artifact = await fileGeneratedArtifact(store, { sourcePath, production: PRODUCTION,
      generation: { source: "audiobook", productionId: PRODUCTION, chapterId: plan.chapter.id, chapterVersion: plan.chapter.version,
        block: row.block.key, paragraph: row.block.paragraph, textHash, provider: narrator.provider, model: narrator.model, voiceId: narrator.voiceId,
        parts: 1, characters: row.block.text.length, estimatedMicroUsd: 0, costMicroUsd: 0 },
      mediaProbe: { durationSec: async () => .1, info: async () => ({ durationSec: .1, hasAudio: true }) } });
    await updateAudiobook(store, PRODUCTION, plan.chapter, current => ({ ...current, takes: { [row.block.key]: {
      artifactId: artifact.id, textHash, reader: narrator, assigned: narrator, format: "wav", parts: 1, characters: row.block.text.length,
      estimatedMicroUsd: 0, costMicroUsd: 0, madeAt: store.now(),
    } } }));
    await store.reload();
    const opened = await openAudioStudio(store, PRODUCTION, CHAPTER);
    assert.ok(opened.state.clips.some(clip => clip.source?.artifactId === artifact.id));
    const saved = await editAudioStudio(store, PRODUCTION, CHAPTER, opened.base, addTrack);
    assert.ok(saved.arrangement?.current.clips.some(clip => clip.source?.artifactId === artifact.id));
    const legacy = JSON.parse(saved.arrangement!.legacy);
    // Restore the pre-migration record, then replace bytes precisely at the write boundary.
    await writeFile(join(dir, "productions", PRODUCTION, ".audiobook", "chapters", `${CHAPTER}.json`), JSON.stringify(legacy));
    const again = await openAudioStudio(store, PRODUCTION, CHAPTER), ensure = store.ensureSchemaVersion.bind(store);
    store.ensureSchemaVersion = async (version, reason) => {
      if (version === AUDIO_STUDIO_SCHEMA_VERSION) await writeFile(join(dir, "artifacts", artifact.file), "replaced during migration");
      await ensure(version, reason);
    };
    await assert.rejects(editAudioStudio(store, PRODUCTION, CHAPTER, again.base, addTrack), /source changed while saving/);
    assert.deepEqual(await readAudiobook(store, PRODUCTION, CHAPTER), legacy, "the rejected migration preserves its readable original record");
  }));
  it("resolves a no-op proposal without migrating or adding an Undo step", () => fixture(async store => {
    for (const migrated of [false, true]) {
      let opened = await openAudioStudio(store, PRODUCTION, CHAPTER);
      if (migrated) { await editAudioStudio(store, PRODUCTION, CHAPTER, opened.base, addTrack); opened = await openAudioStudio(store, PRODUCTION, CHAPTER); }
      const proposal = await stageAudioStudioProposal(store, PRODUCTION, CHAPTER, `noop-${migrated}`, { base: opened.base, summary: "Keep master level", commands: [{ kind: "set-master", master: opened.state.master }] });
      const applied = await decideAudioStudioProposal(store, PRODUCTION, CHAPTER, proposal.id, 1, "apply");
      assert.deepEqual(applied.arrangement ?? null, opened.saved);
      assert.equal(applied.audioStudioProposals?.at(-1)?.status, "applied");
      assert.equal(applied.audioStudioProposals?.at(-1)?.resultRevision, opened.saved?.revision ?? 0);
    }
  }));
  it("stages without migrating, keeps decisions across revisions, and applies an exact version with one Undo", () => fixture(async store => {
    assert.equal(addTrack.kind, "commands"); if (addTrack.kind !== "commands") return;
    const opened = await openAudioStudio(store, PRODUCTION, CHAPTER);
    const input = { base: opened.base, summary: "Add effects", commands: addTrack.commands };
    const family = await stageAudioStudioProposal(store, PRODUCTION, CHAPTER, "suggestion-1", input);
    const staged = await audioStudioSnapshot(store, PRODUCTION, CHAPTER);
    assert.equal(staged.revision, 0); assert.deepEqual(staged.state, opened.state);
    assert.equal(staged.base, family.versions[0]!.base);
    await decideAudioStudioProposal(store, PRODUCTION, CHAPTER, family.id, 1, "keep");
    const kept = await audioStudioSnapshot(store, PRODUCTION, CHAPTER);
    assert.equal(kept.base, staged.base); assert.equal(kept.proposals?.[0]?.status, "kept");
    await assert.rejects(stageAudioStudioProposal(store, PRODUCTION, CHAPTER, "suggestion-2", { ...input, base: kept.base, family: { id: family.id, version: 1 } }), /Keep Current/);
    await assert.rejects(decideAudioStudioProposal(store, PRODUCTION, CHAPTER, family.id, 1, "apply"), /already decided/);
    const fresh = await stageAudioStudioProposal(store, PRODUCTION, CHAPTER, "suggestion-3", { ...input, base: kept.base });
    const revised = await stageAudioStudioProposal(store, PRODUCTION, CHAPTER, "suggestion-4", { ...input, base: kept.base, summary: "Effects lane", family: { id: fresh.id, version: 1 } });
    assert.equal(revised.versions.length, 2);
    await assert.rejects(decideAudioStudioProposal(store, PRODUCTION, CHAPTER, fresh.id, 1, "apply"), /changed/);
    const applied = await decideAudioStudioProposal(store, PRODUCTION, CHAPTER, fresh.id, 2, "apply");
    assert.equal(applied.arrangement?.undo.length, 1); assert.equal(applied.arrangement?.current.tracks.at(-1)?.id, "fx");
    assert.equal(applied.audioStudioProposals?.at(-1)?.status, "applied");
    const current = await openAudioStudio(store, PRODUCTION, CHAPTER);
    const undone = await editAudioStudio(store, PRODUCTION, CHAPTER, current.base, { kind: "undo" });
    assert.deepEqual(undone.arrangement?.current, opened.state);
    assert.equal(undone.audioStudioProposals?.at(-1)?.status, "applied", "Undo does not reopen a decided proposal");
  }));
  it("refuses stale proposal application and model protection or omission acknowledgements", () => fixture(async store => {
    if (addTrack.kind !== "commands") return;
    const opened = await openAudioStudio(store, PRODUCTION, CHAPTER);
    const staged = await stageAudioStudioProposal(store, PRODUCTION, CHAPTER, "suggestion-1", { base: opened.base, summary: "Effects", commands: addTrack.commands });
    const current = await openAudioStudio(store, PRODUCTION, CHAPTER);
    await editAudioStudio(store, PRODUCTION, CHAPTER, current.base, { kind: "commands", label: "Master", commands: [{ kind: "set-master", master: { targetLufs: -20, ceilingDb: -1 } }] });
    await assert.rejects(decideAudioStudioProposal(store, PRODUCTION, CHAPTER, staged.id, 1, "apply"), /changed since/);
    const fresh = await openAudioStudio(store, PRODUCTION, CHAPTER);
    await assert.rejects(stageAudioStudioProposal(store, PRODUCTION, CHAPTER, "release", { base: fresh.base, summary: "Release", commands: [{ kind: "protect-clip", id: "voice", protected: false }] }), /cannot release/);
    await assert.rejects(stageAudioStudioProposal(store, PRODUCTION, CHAPTER, "omit", { base: fresh.base, summary: "Omit", commands: [{ kind: "omit-passage", id: fresh.state.passages[0]!.id, label: "Missing", acknowledged: true }] }), /cannot release/);
  }));
  it("files imports before placement and keeps stale and partly failed imports recoverable", () => fixture(async (store, dir) => {
    const opened = await openAudioStudio(store, PRODUCTION, CHAPTER);
    const beforeArtifacts = store.getBundle().artifacts;
    const image = join(dir, "not-a-sound.png"); await writeFile(image, "image bytes");
    const rejected = await importAudioStudioMedia(store, [image], { productionId: PRODUCTION, chapterFile: CHAPTER, base: opened.base, destination: "library" }, { abandoned: () => false });
    assert.match(rejected[0]!.reason, /supported audio/);
    assert.deepEqual(store.getBundle().artifacts, beforeArtifacts, "a rejected non-audio import never reaches Library");
    const file = join(dir, "import-studio.wav"), pcm = new Float32Array(4800).fill(.1);
    await writeFile(file, writeStereoWav({ rate: 48000, channels: 2, left: pcm, right: pcm }));
    await editAudioStudio(store, PRODUCTION, CHAPTER, opened.base, addTrack);
    const failures = await importAudioStudioMedia(store, [null, file], { productionId: PRODUCTION, chapterFile: CHAPTER, base: opened.base, destination: { trackId: "fx", at: 12001 } }, { abandoned: () => false });
    assert.equal(failures.length, 2); assert.match(failures.find(entry => entry.index === 1)!.reason, /Saved to Library; placement was not applied/);
    const filed = store.getBundle().artifacts.find(artifact => artifact.kind === "audio" && artifact.production === PRODUCTION && artifact.file.includes("import-studio"));
    assert.ok(filed, "stale placement leaves the file in the production Library");
    const refreshed = await openAudioStudio(store, PRODUCTION, CHAPTER);
    assert.equal(refreshed.state.clips.length, opened.state.clips.length);
    const recovered = await importAudioStudioMedia(store, [file], { productionId: PRODUCTION, chapterFile: CHAPTER, base: refreshed.base, destination: { trackId: "fx", at: 12001 } }, { abandoned: () => false });
    assert.deepEqual(recovered, []);
    const placed = await openAudioStudio(store, PRODUCTION, CHAPTER);
    assert.deepEqual(placed.state.clips.at(-1)?.placement, { kind: "fixed", at: 12001 });
    assert.equal(placed.state.clips.at(-1)?.source?.samples, 4800);
  }));
  it("derives without writing, migrates with one undoable edit, and preserves recovery across reopen", () => fixture(async store => {
    const before = await readAudiobook(store, PRODUCTION, CHAPTER);
    const opened = await openAudioStudio(store, PRODUCTION, CHAPTER);
    assert.equal(opened.saved, null);
    assert.deepEqual(await readAudiobook(store, PRODUCTION, CHAPTER), before);
    const saved = await editAudioStudio(store, PRODUCTION, CHAPTER, opened.base, addTrack);
    assert.equal(store.getBundle().meta.schemaVersion, AUDIO_STUDIO_SCHEMA_VERSION);
    assert.equal(saved.arrangement?.current.tracks.at(-1)?.id, "fx");
    assert.equal(saved.arrangement?.undo.length, 1);
    assert.ok(ChapterAudiobookSchema.safeParse(JSON.parse(saved.arrangement!.legacy)).success);
    const reopened = await openAudioStudio(store, PRODUCTION, CHAPTER);
    assert.deepEqual(reopened.saved, saved.arrangement);
    const undone = await editAudioStudio(store, PRODUCTION, CHAPTER, reopened.base, { kind: "undo" });
    assert.deepEqual(undone.arrangement?.current, opened.state);
    assert.equal(undone.arrangement?.revision, 3);
    assert.equal(undone.arrangement?.legacy, saved.arrangement?.legacy);
    const again = await openAudioStudio(store, PRODUCTION, CHAPTER);
    const redone = await editAudioStudio(store, PRODUCTION, CHAPTER, again.base, { kind: "redo" });
    assert.deepEqual(redone.arrangement?.current, saved.arrangement?.current);
  }));
  it("serializes two reviews so a stale edit cannot erase the winner", () => fixture(async store => {
    const opened = await openAudioStudio(store, PRODUCTION, CHAPTER);
    const results = await Promise.allSettled([
      editAudioStudio(store, PRODUCTION, CHAPTER, opened.base, addTrack),
      editAudioStudio(store, PRODUCTION, CHAPTER, opened.base, addTrack),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const record = await readAudiobook(store, PRODUCTION, CHAPTER);
    assert.ok(record && record !== "unreadable");
    assert.equal(record.arrangement?.undo.length, 1);
  }));
  it("refuses manuscript changes and unreadable records without replacing them", () => fixture(async (store, dir) => {
    const opened = await openAudioStudio(store, PRODUCTION, CHAPTER);
    const chapter = join(dir, "productions", PRODUCTION, "chapters", `${CHAPTER}.md`);
    await writeFile(chapter, `${await readFile(chapter, "utf8")}\nA new line.\n`);
    await assert.rejects(editAudioStudio(store, PRODUCTION, CHAPTER, opened.base, addTrack), /changed since/);
    const folder = join(dir, "productions", PRODUCTION, ".audiobook", "chapters");
    await mkdir(folder, { recursive: true });
    const file = join(folder, `${CHAPTER}.json`);
    await writeFile(file, "{damaged}");
    await assert.rejects(openAudioStudio(store, PRODUCTION, CHAPTER), /unreadable/);
    await assert.rejects(editAudioStudio(store, PRODUCTION, CHAPTER, opened.base, addTrack), /unreadable/);
    assert.equal(await readFile(file, "utf8"), "{damaged}");
  }));
  it("commits none of an invalid command batch", () => fixture(async store => {
    const opened = await openAudioStudio(store, PRODUCTION, CHAPTER);
    const before = await readAudiobook(store, PRODUCTION, CHAPTER);
    await assert.rejects(editAudioStudio(store, PRODUCTION, CHAPTER, opened.base, { kind: "commands", label: "Invalid", commands: [...(addTrack.kind === "commands" ? addTrack.commands : []), { kind: "remove-clip", id: "gone" }] }), /no longer exists/);
    assert.deepEqual(await readAudiobook(store, PRODUCTION, CHAPTER), before);
  }));
  it("Listen and the exported player use the arrangement despite absent legacy takes, and changed sources block delivery", () => fixture(async (store, dir) => {
    const opened = await openAudioStudio(store, PRODUCTION, CHAPTER);
    let file = "artifacts/studio-narration.wav";
    const samples = Float32Array.from({ length: 4800 }, (_, i) => 0.1 * Math.sin(i / 13));
    await writeFile(join(dir, file), writeStereoWav({ rate: 48000, channels: 2, left: samples, right: samples }));
    const filed = await fileArtifact(store, { sourcePath: join(dir, file), production: PRODUCTION });
    assert.ok(filed.outcome === "filed" || filed.outcome === "deduplicated"); file = `artifacts/${filed.artifact.file}`;
    const { source } = await readAudioStudioSource(dir, file);
    const state = opened.state;
    state.clips = state.passages.map((passage, i) => ({ ...newAudioClip(`voice-${i}`, state.tracks[0]!.id, source, source.samples),
      role: "speech" as const, passageId: passage.id, placement: { kind: "sequence" as const, offset: 0 } }));
    const plan = await planAudiobook(store, PRODUCTION, CHAPTER, { narrator: DEFAULT_NARRATOR });
    await updateAudiobook(store, PRODUCTION, plan.chapter, current => ({ ...current, arrangement: initialAudioArrangement(state, JSON.stringify(current)) }));
    await store.reload();
    const summary = store.getBundle().productions.find(production => production.meta.id === PRODUCTION)!.chapters.find(chapter => chapter.id === plan.chapter.id)!.audiobook;
    assert.ok(summary && "takes" in summary && summary.takes === 0 && summary.arranged === true, "the scanned summary exposes imported arrangements to Listen");
    const scope = { kind: "chapter" as const, chapterId: plan.chapter.id };
    const listening = await audiobookListening(store, PRODUCTION, { scope });
    const chapter = listening.chapters[0]!;
    assert.equal(chapter.state, "read"); assert.equal(chapter.blocks.length, state.passages.length);
    assert.equal(chapter.mix?.seconds, state.passages.length / 10);
    assert.deepEqual(chapter.audioStudio?.issues, []);
    const firstText = plan.blocks[0]!.block.text, tokens = firstText.trim().split(/\s+/);
    const timing = { artifactId: filed.artifact.id, audioHash: source.hash, textHash: audiobookTextHash(firstText), engine: { id: "whisper.cpp/dtw-word-boundaries-v1", version: "1", model: "fixture" }, seconds: .1, at: store.now(),
      words: tokens.map((text, i) => ({ text, startSec: i * 40 / 48000, endSec: (i * 40 + 20) / 48000, probability: 1 })) };
    await updateAudiobook(store, PRODUCTION, plan.chapter, current => ({ ...current, wordTiming: { first: timing } }));
    const trim = async (sourceIn: number, sourceOut = 4800) => {
      const current = await openAudioStudio(store, PRODUCTION, CHAPTER);
      await editAudioStudio(store, PRODUCTION, CHAPTER, current.base, { kind: "commands", label: "Trim voice", commands: [{ kind: "set-clip", id: "voice-0", changes: { sourceIn, sourceOut } }] });
      return (await audiobookListening(store, PRODUCTION, { scope })).chapters[0]!.blocks[0]!;
    };
    assert.ok((await trim(0)).words?.length);
    const cutHead = await trim(1); assert.equal(cutHead.words, undefined); assert.match(cutHead.wordTimingReason!, /cuts through a word/);
    const cutTail = await trim(0, 10); assert.equal(cutTail.words, undefined); assert.match(cutTail.wordTimingReason!, /cuts through a word/);
    assert.ok((await trim(20)).words?.length, "a trim on a word boundary keeps exact remaining timings");
    await trim(0);
    const incomplete = await openAudioStudio(store, PRODUCTION, "02-the-same-ink");
    await editAudioStudio(store, PRODUCTION, "02-the-same-ink", incomplete.base, addTrack);
    const wholeBook = await audiobookListening(store, PRODUCTION, { finalAudio: true });
    assert.equal(wholeBook.chapters.find(entry => entry.chapterId === plan.chapter.id)?.state, "read");
    const incompleteId = store.getBundle().productions.find(production => production.meta.id === PRODUCTION)!.chapters.find(entry => entry.file === "02-the-same-ink")!.id;
    assert.equal(wholeBook.chapters.find(entry => entry.chapterId === incompleteId)?.state, "not read");
    await assert.rejects(audiobookListening(store, PRODUCTION, { finalAudio: true, scope: { kind: "chapter", chapterId: incompleteId } }), /needs attention|no arranged audio/);
    const bookExport = await exportAudiobookPlayer(store, PRODUCTION, { clock: () => "2026-10-15T12:00:00.000Z" });
    assert.ok(bookExport.ok); assert.deepEqual(bookExport.chapterIds, [plan.chapter.id]);
    const exported = await exportAudiobookPlayer(store, PRODUCTION, { scope, clock: () => "2026-10-15T12:00:00.000Z" });
    assert.equal(exported.ok, true);
    if (exported.ok) assert.deepEqual(await readFile(join(dir, exported.dir, "media", `chapter-${String(chapter.order).padStart(2, "0")}.wav`)), await readFile(join(dir, chapter.mix!.file)));
    const repeatAt = state.passages.length * 4800 + 12001;
    const held = await openAudioStudio(store, PRODUCTION, CHAPTER);
    await editAudioStudio(store, PRODUCTION, CHAPTER, held.base, { kind: "commands", label: "Repeat first passage", commands: [{ kind: "duplicate-clip", id: "voice-0", nextId: "repeated-voice", at: repeatAt }] });
    const repeated = await audiobookListening(store, PRODUCTION, { scope });
    const last = repeated.chapters[0]!.blocks.at(-1)!;
    assert.equal(last.at, repeatAt / 48000); assert.match(last.key, /repeat:repeated-voice/);
    assert.equal(repeated.chapters[0]!.mix!.seconds, (repeatAt + 4800) / 48000);
    await writeFile(join(dir, file), "replaced source");
    const draft = await audiobookListening(store, PRODUCTION, { scope });
    assert.equal(draft.chapters[0]?.state, "part");
    assert.ok(draft.chapters[0]?.audioStudio?.issues.length);
    await assert.rejects(exportAudiobookPlayer(store, PRODUCTION, { scope, clock: () => "2026-10-15T12:00:00.000Z" }), /needs attention/);
  }));
});

describe("Audio Studio source decoding", () => {
  it("uses a band-limited host conversion for high-rate WAV while retaining original source metadata", { skip: process.env.ARKE_STORY_CODEC_SMOKE !== "1" }, () => fixture(async (_store, dir) => {
    const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
    const exec = promisify(execFile), file = "artifacts/high-rate.wav";
    const left = Float32Array.from({ length: 24000 }, (_, i) => .2 * Math.sin(i * 2 * Math.PI * 30000 / 96000));
    const right = Float32Array.from({ length: 24000 }, (_, i) => .2 * Math.sin(i * 2 * Math.PI * 10000 / 96000));
    await writeFile(join(dir, file), writeStereoWav({ rate: 96000, channels: 2, left, right }));
    await assert.rejects(readAudioStudioSource(dir, file), /needs FFmpeg/);
    const decoded = await readAudioStudioSource(dir, file, { ffmpeg: { slateFont: "", run: async (args, _progress, signal) => { await exec(process.env.ARKE_FFMPEG ?? "ffmpeg", args, { signal, windowsHide: true, timeout: 30000 }); } } });
    assert.equal(decoded.source.rate, 96000); assert.equal(decoded.source.channels, 2); assert.equal(decoded.pcm.rate, 48000);
    const energy = (samples: Float32Array) => samples.subarray(1000, -1000).reduce((sum, sample) => sum + sample * sample, 0);
    assert.ok(energy(decoded.pcm.left) < energy(decoded.pcm.right) / 1000, "ultrasonic energy does not alias into the audible band");
  }));
  it("decodes a real imported MP3 into the canonical stereo clock", { skip: process.env.ARKE_STORY_CODEC_SMOKE !== "1" }, () => fixture(async (_store, dir) => {
    const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
    const exec = promisify(execFile), input = join(dir, "artifacts", "import.wav"), file = "artifacts/import.mp3";
    const left = Float32Array.from({ length: 11025 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 44100) * .1);
    const right = Float32Array.from({ length: 11025 }, (_, i) => Math.sin(i * 2 * Math.PI * 880 / 44100) * .4);
    await writeFile(input, writeStereoWav({ rate: 44100, channels: 2, left, right }));
    await exec(process.env.ARKE_FFMPEG ?? "ffmpeg", ["-y", "-i", input, "-c:a", "libmp3lame", "-b:a", "192k", join(dir, file)], { windowsHide: true, timeout: 30000 });
    const decoded = await readAudioStudioSource(dir, file, { ffmpeg: { slateFont: "", run: async (args, _progress, signal) => { await exec(process.env.ARKE_FFMPEG ?? "ffmpeg", args, { signal, windowsHide: true, timeout: 30000 }); } } });
    assert.equal(decoded.source.samples, 12000); assert.equal(decoded.pcm.rate, 48000); assert.equal(decoded.pcm.channels, 2);
    assert.equal(decoded.source.rate, 44100); assert.equal(decoded.source.channels, 2);
    const energy = (samples: Float32Array) => samples.reduce((total, sample) => total + sample * sample, 0);
    assert.ok(energy(decoded.pcm.right) > energy(decoded.pcm.left) * 10, "independent stereo channels survive import");
    const mono = "artifacts/mono.mp3";
    await exec(process.env.ARKE_FFMPEG ?? "ffmpeg", ["-y", "-i", input, "-ac", "1", "-c:a", "libmp3lame", join(dir, mono)], { windowsHide: true, timeout: 30000 });
    const original = await readAudioStudioSource(dir, mono, { ffmpeg: { slateFont: "", run: async (args, _progress, signal) => { await exec(process.env.ARKE_FFMPEG ?? "ffmpeg", args, { signal, windowsHide: true, timeout: 30000 }); } } });
    assert.equal(original.source.rate, 44100); assert.equal(original.source.channels, 1); assert.equal(original.pcm.rate, 48000);
    assert.deepEqual(original.pcm.left, original.pcm.right);
  }));
  it("preserves independent stereo channels and canonical sample counts", () => {
    const left = Float32Array.from([0.25, 0.5, -0.25, -0.5]), right = Float32Array.from([-0.5, -0.25, 0.5, 0.25]);
    const wav = writeStereoWav({ rate: 24000, channels: 2, left, right });
    const read = readStereoWav(wav);
    assert.deepEqual(read.left, left); assert.deepEqual(read.right, right);
    const canonical = resampleStereo(read, 48000);
    assert.equal(canonical.left.length, 8); assert.equal(canonical.right[0], -0.5);
    assert.throws(() => readStereoWav(wav, 8), /memory limit/);
  });
  it("pins exact source bytes and refuses replacements and traversal", () => fixture(async (_store, dir) => {
    const file = "artifacts/studio-tone.wav", path = join(dir, file);
    const samples = new Float32Array(24000).fill(0.1);
    await writeFile(path, writeStereoWav({ rate: 24000, channels: 1, left: samples, right: samples }));
    const first = await readAudioStudioSource(dir, file);
    assert.equal(first.source.samples, 48000);
    assert.equal(first.source.rate, 24000);
    samples[100] = 0.2;
    await writeFile(path, writeStereoWav({ rate: 24000, channels: 1, left: samples, right: samples }));
    await assert.rejects(readAudioStudioSource(dir, file, { expectedHash: first.source.hash }), /changed/);
    await assert.rejects(readAudioStudioSource(dir, "artifacts/../world.yaml"), /world|available/);
  }));
});
