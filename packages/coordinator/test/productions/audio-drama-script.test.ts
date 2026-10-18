import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { ulid, type EpisodeScriptBlock } from "@arke-studio/contracts";
import { createProduction } from "../../src/productions/ops.js";
import { saveEpisodeScript } from "../../src/productions/audio-drama.js";
import { productionRecord } from "../../src/world-chat/production-record.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/** An audio drama's episode script on disk (SPEC-057 R-83): saved whole, fenced, versioned. */
const CLOCK = "2026-10-18T12:00:00.000Z";
async function drama() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  const id = await createProduction(store, { title: "Low Water", medium: "story", productionKind: "audio-drama" });
  return { store, id };
}
const exists = (path: string) => access(path).then(() => true, () => false);
const scene = (paragraphs: number[]): EpisodeScriptBlock => ({ id: ulid(), kind: "heading", place: "The bell tower",
  source: { story: "the-ledger-of-nights", chapter: "ch-3", version: 14, paragraphs } });
const line = (speaker: string, words: string, paragraphs?: number[]): EpisodeScriptBlock =>
  ({ id: ulid(), kind: "dialogue", speaker, words, ...(paragraphs ? { paragraphs } : {}) });

describe("saving an episode script (SPEC-057 R-83)", () => {
  it("creates the script at v1, keeps the version on later saves, and snapshots it", async () => {
    const { store, id } = await drama();
    const blocks = [scene([14, 15]), line("maren", "Bray, look.", [14])];
    const first = await saveEpisodeScript(store, id, { episode: 1, title: "The tide turns", blocks, baseHash: null });
    assert.equal(first.version, 1);
    const path = join(store.dir, "productions", id, "scripts", "episode-001.json");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).blocks, blocks, "ids and source pins round-trip");
    const second = await saveEpisodeScript(store, id, { episode: 1, title: "The tide turns", blocks: [...blocks, line("bray", "I see them.")], baseHash: first.hash });
    assert.equal(second.version, 1, "a direct save keeps the version, as a chapter's does");
    assert.notEqual(second.hash, first.hash);
    assert.ok(await exists(join(store.dir, ".history", "productions", id, "scripts", "episode-001", "v1.json")));
    const bundled = store.getBundle().productions.find(production => production.meta.id === id)!;
    assert.equal(bundled.episodeScripts?.[0]?.hash, second.hash, "the scan carries the base the next save is fenced on");
    assert.equal(bundled.episodeScripts?.[0]?.script.blocks.length, 3);
    assert.equal((productionRecord(store.getBundle(), id) as { episodeScripts?: unknown[] }).episodeScripts?.length, 1, "Arke reads what the score shows");
  });

  it("refuses a save against a moved base, a broken relation, or a production that is not a drama", async () => {
    const { store, id } = await drama();
    const first = await saveEpisodeScript(store, id, { episode: 2, title: "", blocks: [line("maren", "One.")], baseHash: null });
    await saveEpisodeScript(store, id, { episode: 2, title: "", blocks: [line("maren", "Two.")], baseHash: first.hash });
    await assert.rejects(saveEpisodeScript(store, id, { episode: 2, title: "", blocks: [line("maren", "Stale.")], baseHash: first.hash }), /base|stale|changed/i);
    await assert.rejects(saveEpisodeScript(store, id, { episode: 3, title: "", blocks: [{ ...line("maren", "Cut"), cut: true } as EpisodeScriptBlock], baseHash: null }),
      /breaks in/);
    const book = await createProduction(store, { title: "A book", medium: "story" });
    await assert.rejects(saveEpisodeScript(store, book, { episode: 1, title: "", blocks: [], baseHash: null }), /not an audio drama/);
  });

  it("reports a script file named for another episode instead of opening it as that episode", async () => {
    const { store, id } = await drama();
    await saveEpisodeScript(store, id, { episode: 2, title: "", blocks: [line("maren", "Two.")], baseHash: null });
    const scripts = join(store.dir, "productions", id, "scripts");
    await rename(join(scripts, "episode-002.json"), join(scripts, "episode-001.json"));
    await store.reload();
    const bundled = store.getBundle().productions.find(production => production.meta.id === id)!;
    assert.equal(bundled.episodeScripts, undefined, "a misnamed script is not read as an episode");
  });

  it("pins a repeated passage by paragraph number, never by its text", async () => {
    const { store, id } = await drama();
    // Paragraphs 3 and 9 of the chapter read the same; each line keeps the one it came from.
    const blocks = [scene([3, 9]), line("maren", "Climb.", [3]), line("bray", "Climb.", [9])];
    const saved = await saveEpisodeScript(store, id, { episode: 1, title: "", blocks, baseHash: null });
    assert.ok(saved.hash);
    const read = store.getBundle().productions.find(production => production.meta.id === id)!.episodeScripts![0]!.script.blocks;
    assert.deepEqual(read.map(block => "paragraphs" in block ? block.paragraphs : (block as { source?: { paragraphs?: number[] } }).source?.paragraphs), [[3, 9], [3], [9]]);
  });
});
