import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChapterAudiobookSchema, initialAudioArrangement, newAudioClip, DEFAULT_NARRATOR, type AudioArrangementEdit } from "@arke-studio/contracts";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { openAudioStudio, editAudioStudio } from "../../src/productions/audio-studio.js";
import { readAudioStudioSource } from "../../src/productions/audio-studio-source.js";
import { readStereoWav, resampleStereo, writeStereoWav } from "../../src/audio/stereo-wav.js";
import { AUDIO_STUDIO_SCHEMA_VERSION } from "../../src/world/commit.js";
import { planAudiobook, readAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
import { audiobookListening } from "../../src/productions/audiobook-listening.js";
import { exportAudiobookPlayer } from "../../src/productions/audiobook-export.js";
import type { WorldStore } from "../../src/world/store.js";

const PRODUCTION = "the-ledger-of-nights", CHAPTER = "01-neap";
const addTrack: AudioArrangementEdit = { kind: "commands", label: "Add sound effects track", commands: [{ kind: "add-track", track: { id: "fx", name: "Sound effects", gainDb: -6, muted: false } }] };
async function fixture(run: (store: WorldStore, worldDir: string) => Promise<void>) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  try { await run(provider.openStore!()!, worldDir); } finally { await provider.close(); }
}
describe("Audio Studio durable authority", () => {
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
    const file = "artifacts/studio-narration.wav", samples = Float32Array.from({ length: 4800 }, (_, i) => 0.1 * Math.sin(i / 13));
    await writeFile(join(dir, file), writeStereoWav({ rate: 48000, channels: 2, left: samples, right: samples }));
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
    await writeFile(join(dir, file), "replaced source");
    const draft = await audiobookListening(store, PRODUCTION, { scope });
    assert.equal(draft.chapters[0]?.state, "part");
    assert.ok(draft.chapters[0]?.audioStudio?.issues.length);
    await assert.rejects(exportAudiobookPlayer(store, PRODUCTION, { scope, clock: () => "2026-10-15T12:00:00.000Z" }), /needs attention/);
  }));
});

describe("Audio Studio source decoding", () => {
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
