import assert from "node:assert/strict";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { audiobookBlockState, type AudioQcAnalysis, type AudiobookReader } from "@arke-studio/contracts";
import { hashAudioFile, type AudioMediaTools } from "../../src/audio/media-tools.js";
import { readAudioRights } from "../../src/audio/rights.js";
import { keepRecording, RecordedTakeRefusal, stageRecording } from "../../src/productions/audiobook-recorded.js";
import { planAudiobook, readAudiobook, readAudiobookBook, writeAudiobookBook } from "../../src/productions/audiobook.js";
import { openChapter, saveChapter } from "../../src/productions/ops.js";
import { RECORDED_TAKE_SCHEMA_VERSION } from "../../src/world/commit.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup, tempDir } from "../tmp.js";

/**
 * A take a person recorded (design turn 155c, SPEC-047 R-34..R-36): chosen on this machine,
 * prepared and checked by the audio foundation, kept under the rights given once, filed as the
 * block's take and current while its words are, whatever reads the book.
 */

const PRODUCTION = "the-ledger-of-nights";
const NOW = () => "2026-09-25T12:00:00.000Z";
const NARRATOR: AudiobookReader = { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", label: "George" };
const OTHER: AudiobookReader = { provider: "elevenlabs", model: "eleven_v3", voiceId: "anna", label: "Anna" };

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: NOW });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

/** The foundation's tools with ffmpeg left out: the prepared file is the chosen one, and the checks say what the test needs. */
function fakeTools(input: { hasAudio?: boolean; durationSec?: number; qc?: (hash: string) => AudioQcAnalysis } = {}): AudioMediaTools {
  const technical = { container: "wav", codec: "pcm_s16le", sampleFormat: "s16", sampleRateHz: 48_000, channels: 1, bitDepth: 16, durationSec: input.durationSec ?? 3.8, sizeBytes: 44 };
  return {
    probe: async ({ absolutePath }) => ({ sourceHash: (await hashAudioFile(absolutePath, new AbortController().signal)).hash, technical, hasAudio: input.hasAudio ?? true }),
    preparePcmWav: async ({ sourcePath, destinationPath }) => {
      await copyFile(sourcePath, destinationPath);
      return { outputHash: (await hashAudioFile(destinationPath, new AbortController().signal)).hash, technical, toolVersion: "fake" };
    },
    analyze: async ({ expectedHash }) =>
      input.qc?.(expectedHash) ?? { status: "unavailable", sourceHash: expectedHash, analyzerId: "arke-pcm-qc", analyzerVersion: 1, policyVersion: 1, reason: "not-configured" },
  };
}

async function recording(name = "07-011-1.wav", bytes = "RIFF....WAVEfmt fake recording") {
  const dir = await tempDir("recorded-take");
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

async function firstLine(store: WorldStore) {
  const plan = await planAudiobook(store, PRODUCTION, "neap", { narrator: NARRATOR });
  return plan.blocks.find((planned) => planned.block.key !== "title")!.block;
}

describe("a take a person recorded (SPEC-047 R-34..R-36)", () => {
  it("is prepared and checked, kept under the rights, filed as the block's take, and current whoever reads the book", async () => {
    const { dir, store } = await open();
    const block = await firstLine(store);
    const deps = { tools: fakeTools(), transcribe: async () => block.text, narrator: NARRATOR, signal: new AbortController().signal };
    const staged = await stageRecording(store, deps, { productionId: PRODUCTION, chapterId: "neap", block: block.key, sourcePath: await recording() });
    assert.equal(staged.file, "07-011-1.wav");
    assert.equal(staged.words.status, "compared");
    assert.ok(staged.words.status === "compared" && staged.words.result === "exact", "the words heard are the block's");

    const record = await keepRecording(store, staged, { basis: "authorized", performer: "Idris Oke", narrator: NARRATOR, ackId: "ack_test", now: NOW });
    const take = record.takes[block.key]!;
    assert.equal(take.source, "recorded");
    assert.deepEqual(take.recording, { acknowledgementId: "ack_test", performer: "Idris Oke", warnings: ["checks unavailable · not-configured"], words: "match" });
    assert.deepEqual(await readAudiobook(store, PRODUCTION, "01-neap"), record);

    const world = JSON.parse(await readFile(join(dir, "world.json"), "utf8")) as { schemaVersion: number };
    assert.equal(world.schemaVersion, RECORDED_TAKE_SCHEMA_VERSION, "raised before a recorded take is written");
    const rights = await readAudioRights(store);
    assert.deepEqual(rights.map((event) => event.action === "acknowledge" && event.scopes), [["recorded-take"]]);
    const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === take.artifactId)!;
    assert.ok(artifact.generation?.source === "audiobook" && artifact.generation.recording?.acknowledgementId === "ack_test");

    // No reader and no direction made it (R-34): made under the narrator, made under another voice.
    assert.equal(audiobookBlockState(block, record, NARRATOR), "made");
    assert.equal(audiobookBlockState(block, record, OTHER), "made");
    // Changed words make it stale.
    assert.equal(audiobookBlockState({ ...block, text: `${block.text} And more.` }, record, NARRATOR), "stale");
  });

  it("refuses what cannot be a take in one clause, and keeps nothing for words that changed since", async () => {
    const { store } = await open();
    const block = await firstLine(store);
    const deps = (tools: AudioMediaTools) => ({ tools, transcribe: null, narrator: NARRATOR, signal: new AbortController().signal });
    const stage = (tools: AudioMediaTools, path: Promise<string>) => path.then((sourcePath) => stageRecording(store, deps(tools), { productionId: PRODUCTION, chapterId: "neap", block: block.key, sourcePath }));
    await assert.rejects(stage(fakeTools(), recording("notes.txt")), (err) => err instanceof RecordedTakeRefusal && /not a WAV/.test(err.message));
    await assert.rejects(stage(fakeTools({ hasAudio: false }), recording()), /no audio/);
    await assert.rejects(stage(fakeTools({ durationSec: 601 }), recording()), /longer than 10 minutes/);

    const staged = await stage(fakeTools(), recording());
    assert.equal(staged.words.status, "unavailable", "no transcriber: the words are unchecked, not refused");
    const live = await openChapter(store, PRODUCTION, "neap");
    await saveChapter(store, PRODUCTION, "01-neap", live.body.replace(block.text.slice(0, 20), "Entirely other words"), { baseHash: live.hash });
    await assert.rejects(keepRecording(store, staged, { basis: "self", narrator: NARRATOR, ackId: "ack_late", now: NOW }), /words changed/);
    assert.deepEqual(await readAudioRights(store), [], "nothing acknowledged for a take not kept");
  });
});

describe("a speaker a person records (SPEC-047 R-37, R-38)", () => {
  it("the narrator recorded: every narration block waits on a recording, and a current recording makes it", async () => {
    const { store } = await open();
    await writeAudiobookBook(store, PRODUCTION, { schemaVersion: 1, reading: "narrator", recorded: ["narrator"] });
    const plan = await planAudiobook(store, PRODUCTION, "neap", { narrator: NARRATOR });
    assert.ok(plan.blocks.length > 1);
    assert.ok(plan.blocks.every((planned) => planned.state === "awaiting" && planned.recorded === true), "the title and narration wait on the narrator's recording");

    const block = plan.blocks.find((planned) => planned.block.key !== "title")!.block;
    const deps = { tools: fakeTools(), transcribe: null, narrator: NARRATOR, signal: new AbortController().signal };
    const staged = await stageRecording(store, deps, { productionId: PRODUCTION, chapterId: "neap", block: block.key, sourcePath: await recording() });
    await keepRecording(store, staged, { basis: "self", narrator: NARRATOR, ackId: "ack_narrator", now: NOW });
    const after = await planAudiobook(store, PRODUCTION, "neap", { narrator: NARRATOR });
    assert.equal(after.blocks.find((planned) => planned.block.key === block.key)!.state, "made");
    assert.equal(after.blocks.filter((planned) => planned.state === "awaiting").length, plan.blocks.length - 1);
  });

  it("the book record keeps its reading and its recorded speakers apart: neither write drops the other", async () => {
    const { store } = await open();
    await writeAudiobookBook(store, PRODUCTION, { schemaVersion: 1, reading: "cast", recorded: ["odile-sarn"] });
    assert.deepEqual(await readAudiobookBook(store, PRODUCTION), { schemaVersion: 1, reading: "cast", recorded: ["odile-sarn"] });
  });
});
