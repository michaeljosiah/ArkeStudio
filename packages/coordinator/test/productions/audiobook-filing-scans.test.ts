import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorldStore } from "../../src/world/store.js";
import { fileGeneratedArtifact } from "../../src/artifacts/filing.js";
import { readAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
import { writeSpeechWav } from "../../src/audio/speech-wav.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";

it("files, measures and checkpoints one cut with three scans and preserves the landed identity on reopen", async () => {
  const dir = await makeTempWorld(),
    sourcePath = join(await tempDir("filing-cut-"), "cut.wav");
  await writeFile(sourcePath, "synthetic audio");
  const productionId = "the-ledger-of-nights",
    chapter = { file: "01-neap", version: 4, hash: "chapter-hash" };
  const reader = { provider: "test", model: "test", voiceId: "test" };
  const generation = {
    source: "audiobook" as const,
    productionId,
    chapterId: "neap",
    chapterVersion: 4,
    block: "title",
    paragraph: -1,
    textHash: "text-hash",
    ...reader,
    parts: 1,
    characters: 4,
    estimatedMicroUsd: 0,
    costMicroUsd: 0,
  };
  let store = await WorldStore.open(dir),
    id: string;
  const live = store as unknown as { rescan: (paths?: string[]) => Promise<void> },
    rescan = live.rescan.bind(store);
  let scans = 0;
  live.rescan = async (paths) => {
    scans++;
    return rescan(paths);
  };
  try {
    const artifact = await fileGeneratedArtifact(store, {
      sourcePath,
      generation,
      production: productionId,
      mediaProbe: { durationSec: async () => 1, info: async () => ({ durationSec: 1, hasAudio: true }) },
    });
    id = artifact.id;
    await updateAudiobook(store, productionId, chapter, (current) => ({
      ...current,
      takes: {
        ...current.takes,
        title: {
          artifactId: artifact.id,
          textHash: generation.textHash,
          reader,
          assigned: reader,
          format: "wav",
          characters: 4,
          parts: 1,
          estimatedMicroUsd: 0,
          costMicroUsd: 0,
          madeAt: new Date().toISOString(),
        },
      },
    }));
    assert.equal(scans, 3);
    assert.equal(store.getBundle().artifacts.find((value) => value.id === id)?.mediaInfo?.durationSec, 1);
    const saved = await readAudiobook(store, productionId, chapter.file);
    assert.ok(saved && saved !== "unreadable");
    assert.equal(saved.takes.title?.artifactId, id);
  } finally {
    live.rescan = rescan;
    await store.close();
  }
  store = await WorldStore.open(dir);
  try {
    const saved = await readAudiobook(store, productionId, chapter.file);
    assert.ok(saved && saved !== "unreadable");
    assert.equal(saved.takes.title?.artifactId, id);
    assert.equal(
      (await fileGeneratedArtifact(store, { sourcePath, generation, production: productionId })).id,
      id,
    );
    assert.equal(store.getBundle().artifacts.filter((value) => value.id === id).length, 1);
  } finally {
    await store.close();
  }
});

it("files a reader's 16-bit PCM take measured from its header: no probe, and two scans with the checkpoint (issue 2781)", async () => {
  const dir = await makeTempWorld(),
    sourcePath = join(await tempDir("filing-wav-"), "cut.wav");
  // A second and a half of 24 kHz mono, as Gemini and Voxa return it.
  await writeFile(sourcePath, writeSpeechWav({ rate: 24_000, samples: new Float32Array(36_000) }));
  const productionId = "the-ledger-of-nights",
    chapter = { file: "01-neap", version: 4, hash: "chapter-hash" },
    reader = { provider: "test", model: "test", voiceId: "test" };
  const generation = { source: "audiobook" as const, productionId, chapterId: "neap", chapterVersion: 4, block: "title",
    paragraph: -1, textHash: "text-hash", ...reader, parts: 1, characters: 4, estimatedMicroUsd: 0, costMicroUsd: 0 };
  const store = await WorldStore.open(dir);
  const live = store as unknown as { rescan: (paths?: string[]) => Promise<void> },
    rescan = live.rescan.bind(store);
  let scans = 0, probed = 0;
  live.rescan = async (paths) => { scans++; return rescan(paths); };
  try {
    const artifact = await fileGeneratedArtifact(store, { sourcePath, generation, production: productionId,
      mediaProbe: { durationSec: async () => { probed++; return 9; }, info: async () => { probed++; return { durationSec: 9, hasAudio: true }; } } });
    assert.equal(probed, 0, "the header answers what the probe would");
    assert.deepEqual(artifact.mediaInfo, { durationSec: 1.5, hasAudio: true, hasVideo: false, audioChannels: 1, audioSampleRateHz: 24_000 });
    await updateAudiobook(store, productionId, chapter, (current) => ({ ...current, takes: { ...current.takes, title: {
      artifactId: artifact.id, textHash: generation.textHash, reader, assigned: reader, format: "wav", characters: 4, parts: 1,
      estimatedMicroUsd: 0, costMicroUsd: 0, madeAt: new Date().toISOString() } } }));
    assert.equal(scans, 2, "one for the filing commit, one for the checkpoint");
  } finally {
    live.rescan = rescan;
    await store.close();
  }
});
