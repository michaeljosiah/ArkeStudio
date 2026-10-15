import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChapterAudiobookSchema, initialAudioArrangement, newAudioClip, DEFAULT_NARRATOR, type AudioArrangementEdit } from "@arke-studio/contracts";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { openAudioStudio, editAudioStudio, stageAudioStudioProposal, decideAudioStudioProposal, audioStudioSnapshot } from "../../src/productions/audio-studio.js";
import { readAudioStudioSource } from "../../src/productions/audio-studio-source.js";
import { readStereoWav, resampleStereo, writeStereoWav } from "../../src/audio/stereo-wav.js";
import { AUDIO_STUDIO_SCHEMA_VERSION } from "../../src/world/commit.js";
import { planAudiobook, readAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
import { audiobookListening } from "../../src/productions/audiobook-listening.js";
import { exportAudiobookPlayer } from "../../src/productions/audiobook-export.js";
import type { WorldStore } from "../../src/world/store.js";
import { importAudioStudioMedia } from "../../src/productions/audio-studio-import.js";
import { fileArtifact } from "../../src/artifacts/filing.js";

const PRODUCTION = "the-ledger-of-nights", CHAPTER = "01-neap";
const addTrack: AudioArrangementEdit = { kind: "commands", label: "Add sound effects track", commands: [{ kind: "add-track", track: { id: "fx", name: "Sound effects", gainDb: -6, muted: false } }] };
async function fixture(run: (store: WorldStore, worldDir: string) => Promise<void>) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  try { await run(provider.openStore!()!, worldDir); } finally { await provider.close(); }
}
describe("Audio Studio durable authority", () => {
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
    const scope = { kind: "chapter" as const, chapterId: plan.chapter.id };
    const listening = await audiobookListening(store, PRODUCTION, { scope });
    const chapter = listening.chapters[0]!;
    assert.equal(chapter.state, "read"); assert.equal(chapter.blocks.length, state.passages.length);
    assert.equal(chapter.mix?.seconds, state.passages.length / 10);
    assert.deepEqual(chapter.audioStudio?.issues, []);
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
  it("decodes a real imported MP3 into the canonical stereo clock", { skip: process.env.ARKE_STORY_CODEC_SMOKE !== "1" }, () => fixture(async (_store, dir) => {
    const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
    const exec = promisify(execFile), input = join(dir, "artifacts", "import.wav"), file = "artifacts/import.mp3";
    const left = Float32Array.from({ length: 11025 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 44100) * .1);
    const right = Float32Array.from({ length: 11025 }, (_, i) => Math.sin(i * 2 * Math.PI * 880 / 44100) * .4);
    await writeFile(input, writeStereoWav({ rate: 44100, channels: 2, left, right }));
    await exec(process.env.ARKE_FFMPEG ?? "ffmpeg", ["-y", "-i", input, "-c:a", "libmp3lame", "-b:a", "192k", join(dir, file)], { windowsHide: true, timeout: 30000 });
    const decoded = await readAudioStudioSource(dir, file, { ffmpeg: { slateFont: "", run: async (args, _progress, signal) => { await exec(process.env.ARKE_FFMPEG ?? "ffmpeg", args, { signal, windowsHide: true, timeout: 30000 }); } } });
    assert.equal(decoded.source.samples, 12000); assert.equal(decoded.pcm.rate, 48000); assert.equal(decoded.pcm.channels, 2);
    const energy = (samples: Float32Array) => samples.reduce((total, sample) => total + sample * sample, 0);
    assert.ok(energy(decoded.pcm.right) > energy(decoded.pcm.left) * 10, "independent stereo channels survive import");
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
