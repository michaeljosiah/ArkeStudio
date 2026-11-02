import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorldStore } from "../../src/world/store.js";
import { fileGeneratedArtifact } from "../../src/artifacts/filing.js";
import { readAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
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
