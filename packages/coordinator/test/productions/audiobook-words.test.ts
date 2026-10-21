import assert from "node:assert/strict";
import { it } from "node:test";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { audiobookTextHash, audiobookWordsCounts, DEFAULT_NARRATOR, type AudiobookWordsState } from "@arke-studio/contracts";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { audioHash } from "../../src/audio/qc.js";
import { transcriptCacheKey } from "../../src/audio/transcript-comparison.js";
import type { AudioMediaTools } from "../../src/audio/media-tools.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { audiobookPath, planAudiobook, updateAudiobook } from "../../src/productions/audiobook.js";
import { checkAudiobookWords, readAudiobookWords, type AudiobookWordsDeps } from "../../src/productions/audiobook-words.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const identity = { id: "voxa-whisper", version: "fixture-runtime/model-sha256" };
const signal = () => new AbortController().signal;
const book = "the-ledger-of-nights", chapter = "neap", file = "01-neap", key = "p0.0";
const scope = { productionId: book, blocks: [{ chapterId: chapter, key }] };
async function fixture() {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root); await provider.loadWorld(WORLD_ID);
  const store = provider.openStore!()!;
  const plan = await planAudiobook(store, book, chapter, { narrator: DEFAULT_NARRATOR });
  const block = plan.blocks.find(entry => entry.block.key === key)!.block;
  const source = join(root, "saved.wav"); await writeFile(source, "saved selected narration");
  const filed = await fileArtifact(store, { sourcePath: source, mediaProbe: { durationSec: async () => 10, info: async () => ({ durationSec: 10, hasAudio: true }) } });
  assert.equal(filed.outcome, "filed"); if (filed.outcome !== "filed") throw new Error("fixture filing failed");
  const take = { artifactId: filed.artifact.id, textHash: audiobookTextHash(block.text), reader: DEFAULT_NARRATOR, format: "wav" as const,
    characters: block.text.length, parts: 1, estimatedMicroUsd: 0, costMicroUsd: 0, madeAt: store.now() };
  await updateAudiobook(store, book, plan.chapter, current => ({ ...current, takes: { ...current.takes, [key]: take } }));
  const technical = { durationSec: 10, sampleRateHz: 48000, channels: 1, codec: "pcm_s16le", container: "wav", sampleFormat: "s16", bitDepth: 16, sizeBytes: 24 };
  const tools: AudioMediaTools = {
    probe: async input => ({ sourceHash: input.expectedHash!, technical, hasAudio: true }),
    preparePcmWav: async input => { await copyFile(input.sourcePath, input.destinationPath); return { outputHash: input.expectedSourceHash, technical, toolVersion: "fixture" }; },
    analyze: async () => { throw new Error("Words checks do not perform QC or synthesis"); },
  };
  const deps: AudiobookWordsDeps = { identity: async () => identity, transcribe: async () => block.text, tools };
  return { root, worldDir, provider, store, block, plan, take, artifact: filed.artifact, deps,
    recordPath: join(worldDir, audiobookPath(book, file)) };
}

it("compares current saved audio, reopens its exact cache, and preserves the authored record and bytes", async () => {
  const f = await fixture();
  try {
    const record = await readFile(f.recordPath), source = await readFile(join(f.worldDir, "artifacts", f.artifact.file));
    let calls = 0; f.deps.transcribe = async () => { calls++; return f.block.text; };
    const checked = await checkAudiobookWords(f.store, scope, f.deps, signal(), () => {});
    assert.deepEqual(audiobookWordsCounts(checked.rows), { compared: 1, match: 1, differ: 0, unavailable: 0, unchecked: 0 });
    assert.equal(checked.done, 1); assert.equal(checked.running, false); assert.equal(calls, 1);
    await checkAudiobookWords(f.store, scope, f.deps, signal(), () => {}); assert.equal(calls, 1);
    assert.deepEqual(await readFile(f.recordPath), record); assert.deepEqual(await readFile(join(f.worldDir, "artifacts", f.artifact.file)), source);
    await f.provider.close(); await f.provider.loadWorld(WORLD_ID);
    const reopened = await readAudiobookWords(f.provider.openStore!()!, scope, identity, signal());
    assert.equal(reopened.rows[0]?.comparison?.status, "compared");
    const otherEngine = await readAudiobookWords(f.provider.openStore!()!, scope, { ...identity, version: "changed-model" }, signal());
    assert.equal(otherEngine.rows[0]?.comparison, undefined);
  } finally { await f.provider.close(); }
});

it("keeps true differences separate from unavailable recognition and retries only on an explicit check", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.deps.transcribe = async () => { calls++; throw new Error("private runtime output"); };
    const failed = await checkAudiobookWords(f.store, scope, f.deps, signal(), () => {});
    assert.equal(failed.rows[0]?.comparison?.status, "unavailable");
    const read = await readAudiobookWords(f.store, scope, identity, signal());
    assert.equal(read.rows[0]?.comparison?.status, "unavailable"); assert.equal(calls, 1);
    f.deps.transcribe = async () => { calls++; return "Words that differ from the author's text."; };
    const differs = await checkAudiobookWords(f.store, scope, f.deps, signal(), () => {});
    assert.equal(differs.rows[0]?.comparison?.status, "compared");
    assert.equal(audiobookWordsCounts(differs.rows).differ, 1); assert.equal(calls, 2);
    assert.ok(!JSON.stringify(failed).includes("private runtime output"));
  } finally { await f.provider.close(); }
});

it("rejects replacement while inference is outside the write gate and never persists a current success", async () => {
  const f = await fixture();
  try {
    f.deps.transcribe = async () => {
      await updateAudiobook(f.store, book, f.plan.chapter, current => ({ ...current, takes: { ...current.takes, [key]: { ...f.take, textHash: "changed" } } }));
      return f.block.text;
    };
    const checked = await checkAudiobookWords(f.store, scope, f.deps, signal(), () => {});
    assert.equal(checked.rows[0]?.comparison, undefined);
    assert.match(checked.rows[0]?.reason ?? "", /current reading/);
    await updateAudiobook(f.store, book, f.plan.chapter, current => ({ ...current, takes: { ...current.takes, [key]: f.take } }));
    assert.equal((await readAudiobookWords(f.store, scope, identity, signal())).rows[0]?.comparison, undefined);
  } finally { await f.provider.close(); }
});

it("refuses changed bytes, unknown recognizer identity and missing takes without inferring", async () => {
  const f = await fixture();
  try {
    let calls = 0; f.deps.transcribe = async () => { calls++; return f.block.text; };
    const unknown = await checkAudiobookWords(f.store, scope, { ...f.deps, identity: async () => null }, signal(), () => {});
    assert.equal(unknown.available, false); assert.equal(calls, 0);
    await writeFile(join(f.worldDir, "artifacts", f.artifact.file), "changed bytes");
    const changed = await checkAudiobookWords(f.store, scope, f.deps, signal(), () => {});
    assert.equal(changed.rows[0]?.comparison, undefined); assert.match(changed.rows[0]?.reason ?? "", /unavailable/); assert.equal(calls, 0);
    const chapterRows = await readAudiobookWords(f.store, { productionId: book, chapters: [chapter] }, identity, signal());
    assert.ok(chapterRows.rows.length > 1); assert.equal(audiobookWordsCounts(chapterRows.rows).unavailable, chapterRows.total);
  } finally { await f.provider.close(); }
});

it("propagates Stop during inference and retains no successful cache for the cancelled take", async () => {
  const f = await fixture(), control = new AbortController();
  try {
    let progress: AudiobookWordsState | undefined;
    f.deps.transcribe = async (_bytes, _type, abort) => { control.abort(); assert.equal(abort.aborted, true); return f.block.text; };
    await assert.rejects(checkAudiobookWords(f.store, scope, f.deps, control.signal, state => { progress = state; }));
    assert.equal(progress?.done, 0);
    assert.equal((await readAudiobookWords(f.store, scope, identity, signal())).rows[0]?.comparison, undefined);
  } finally { await f.provider.close(); }
});

it("binds a successful comparison to the full source digest", async () => {
  const f = await fixture();
  try {
    const result = await checkAudiobookWords(f.store, scope, f.deps, signal(), () => {});
    assert.equal(result.rows[0]?.comparison?.audioHash, audioHash(await readFile(join(f.worldDir, "artifacts", f.artifact.file))));
  } finally { await f.provider.close(); }
});

it("retains missing requested chapters and blocks in book coverage", async () => {
  const f = await fixture();
  try {
    const missing = await readAudiobookWords(f.store, { productionId: book, blocks: [
      { chapterId: chapter, key: "removed-block" }, { chapterId: "removed-chapter", key },
    ] }, identity, signal());
    assert.equal(missing.total, 2); assert.equal(audiobookWordsCounts(missing.rows).unavailable, 2);
    const whole = await readAudiobookWords(f.store, { productionId: book }, identity, signal());
    assert.ok(whole.total > 1); assert.ok(whole.rows.some(row => row.chapterId === chapter && row.key === key));
    assert.equal(audiobookWordsCounts(whole.rows).unchecked, 1);
  } finally { await f.provider.close(); }
});

it("keeps over-duration, invalid and timed-out recognition unavailable after reopening, without claiming a wording mismatch", async () => {
  const f = await fixture();
  try {
    let calls = 0; f.deps.transcribe = async () => { calls++; return f.block.text; };
    const probe = f.deps.tools!.probe;
    f.deps.tools!.probe = async input => { const result = await probe(input); return { ...result, technical: { ...result.technical, durationSec: 601 } }; };
    const long = await checkAudiobookWords(f.store, scope, f.deps, signal(), () => {});
    assert.equal(long.rows[0]?.comparison?.status, "unavailable"); assert.equal(calls, 0);
    assert.equal((await readAudiobookWords(f.store, scope, identity, signal())).rows[0]?.comparison?.status, "unavailable");
    f.deps.tools!.probe = probe;
    for (const fail of [async () => "x".repeat(100001), async () => { throw new DOMException("private timeout detail", "TimeoutError"); }]) {
      f.deps.transcribe = fail;
      const result = await checkAudiobookWords(f.store, scope, f.deps, signal(), () => {});
      assert.equal(result.rows[0]?.comparison?.status, "unavailable"); assert.equal(audiobookWordsCounts(result.rows).differ, 0);
      assert.ok(!JSON.stringify(result).includes("private timeout detail"));
    }
  } finally { await f.provider.close(); }
});

it("ignores corrupt or oversized cache data and refuses a changed recognizer during inference", async () => {
  const f = await fixture();
  try {
    await checkAudiobookWords(f.store, scope, f.deps, signal(), () => {});
    const hash = audioHash(await readFile(join(f.worldDir, "artifacts", f.artifact.file)));
    const cache = join(f.worldDir, ".cache/audio-transcripts", transcriptCacheKey(hash, f.block.text, identity));
    for (const bad of ["{broken", "x".repeat(256001)]) {
      await writeFile(cache, bad);
      assert.equal((await readAudiobookWords(f.store, scope, identity, signal())).rows[0]?.comparison, undefined);
    }
    let current = identity;
    f.deps.identity = async () => current;
    f.deps.transcribe = async () => { current = { ...identity, version: "replaced" }; return f.block.text; };
    const result = await checkAudiobookWords(f.store, scope, f.deps, signal(), () => {});
    assert.equal(result.available, false); assert.match(result.reason!, /recognizer changed/);
    assert.equal(result.rows[0]?.comparison, undefined);
  } finally { await f.provider.close(); }
});
