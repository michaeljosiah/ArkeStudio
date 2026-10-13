import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  audiobookTextHash,
  DEFAULT_NARRATOR,
  listeningChapter,
  type AcousticWords,
  type ListeningChapter,
} from "@arke-studio/contracts";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { planAudiobook, readAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
import { listeningBlocks } from "../../src/productions/audiobook-listening.js";
import {
  applyAudiobookWordTiming,
  prepareAudiobookWordTiming,
} from "../../src/productions/audiobook-word-timing.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

it("binds measured words to exact saved audio and rejects stale audio or a replaced take during preparation", async () => {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore!()!;
  const book = "the-ledger-of-nights",
    file = "01-neap",
    key = "p0.0";
  try {
    const initial = await planAudiobook(store, book, file, { narrator: DEFAULT_NARRATOR });
    const block = initial.blocks.find((p) => p.block.key === key)!.block;
    const tokens = block.text.trim().split(/\s+/);
    const duration = tokens.length * 0.3 + 0.2;
    const source = join(root, "read.wav");
    await writeFile(source, "exact saved audio bytes");
    const filed = await fileArtifact(store, {
      sourcePath: source,
      mediaProbe: {
        durationSec: async () => duration,
        info: async () => ({ durationSec: duration, hasAudio: true }),
      },
    });
    assert.ok(filed.outcome === "filed");
    const take = {
      artifactId: filed.artifact.id,
      textHash: audiobookTextHash(block.text),
      reader: DEFAULT_NARRATOR,
      format: "wav" as const,
      characters: block.text.length,
      parts: 1,
      estimatedMicroUsd: 0,
      costMicroUsd: 0,
      madeAt: store.now(),
    };
    await updateAudiobook(store, book, initial.chapter, (current) => ({
      ...current,
      takes: { ...current.takes, [key]: take },
    }));
    const plan = await planAudiobook(store, book, file, { narrator: DEFAULT_NARRATOR });
    const heard: AcousticWords = {
      text: block.text,
      seconds: duration,
      engine: { id: "whisper.cpp/dtw-word-boundaries-v1", version: "1", model: "fixture" },
      words: tokens.map((text, i) => ({ text, startSec: i * 0.3, endSec: i * 0.3 + 0.2, probability: 0.95 })),
    };
    const signal = new AbortController().signal;
    await prepareAudiobookWordTiming(store, book, plan, key, async () => heard, signal);
    const fresh = await planAudiobook(store, book, file, { narrator: DEFAULT_NARRATOR });
    const chapter = listeningChapter({
      chapterId: fresh.chapter.id,
      order: 1,
      title: "Neap",
      blocks: listeningBlocks(store, fresh),
      pictures: {},
      cover: null,
    });
    await applyAudiobookWordTiming(store, fresh, chapter);
    assert.equal(chapter.blocks[0]?.words?.length, tokens.length);
    assert.equal(store.getBundle().meta.schemaVersion, 73);
    await writeFile(join(worldDir, "artifacts", filed.artifact.file), "changed bytes");
    const stale: ListeningChapter = {
      ...chapter,
      blocks: chapter.blocks.map(({ words: _words, ...rest }) => rest),
    };
    await applyAudiobookWordTiming(store, fresh, stale);
    assert.equal(stale.blocks[0]?.words, undefined);
    assert.match(stale.blocks[0]?.wordTimingReason ?? "", /audio changed/);
    await assert.rejects(
      prepareAudiobookWordTiming(
        store,
        book,
        fresh,
        key,
        async () => {
          await updateAudiobook(store, book, initial.chapter, (current) => ({
            ...current,
            takes: { ...current.takes, [key]: { ...take, textHash: "changed" } },
          }));
          return heard;
        },
        signal,
      ),
      /reading changed/,
    );
    const record = await readAudiobook(store, book, file);
    assert.ok(record !== null && record !== "unreadable");
    assert.equal(
      record.wordTiming?.[key]?.audioHash,
      fresh.record !== null && fresh.record !== "unreadable"
        ? fresh.record.wordTiming?.[key]?.audioHash
        : null,
    );
  } finally {
    await provider.close();
  }
});
