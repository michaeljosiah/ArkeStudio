import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, ulid, type EpisodeScriptBlock, type Job } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { createProduction } from "../../src/productions/ops.js";
import { saveEpisodeScript } from "../../src/productions/audio-drama.js";
import { decideDramaTake, hearDramaLines, placeTake, type DramaHearDeps } from "../../src/productions/audio-drama-hear.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/** Hearing an audio drama's lines (SPEC-057 R-25..R-31): priced, never substituted unasked, kept as takes. */
const CLOCK = "2026-10-18T12:00:00.000Z";
const NARRATOR = { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "narrator-voice", label: "The narrator" };

async function drama(blocks: EpisodeScriptBlock[]) {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  const id = await createProduction(store, { title: "Low Water", medium: "story", productionKind: "audio-drama" });
  await saveEpisodeScript(store, id, { episode: 1, title: "", blocks, baseHash: null });
  const sent: EnqueueInput[] = [];
  const deps = (extra: Partial<DramaHearDeps> = {}): DramaHearDeps => ({
    worldId: store.worldId, narrator: NARRATOR, models: SHIPPED_MANIFEST.models,
    enqueue: async (input) => {
      sent.push(input);
      await mkdir(join(store.dir, input.landing!.dir), { recursive: true });
      await writeFile(join(store.dir, input.landing!.dir, input.landing!.name!), Buffer.from(`audio:${String(input.params["text"])}`));
      return newId("jb");
    },
    waitForJob: async (jobId) => {
      const input = sent.at(-1)!;
      return { id: jobId, status: "succeeded", landedFiles: [`${input.landing!.dir}/${input.landing!.name}`] } as unknown as Job;
    },
    ...extra,
  });
  return { store, id, sent, deps, takes: () => store.getBundle().productions.find((p) => p.meta.id === id)!.episodeTakes?.[0] };
}
const maren = (words: string, extra: object = {}): EpisodeScriptBlock => ({ id: ulid(), kind: "dialogue", speaker: "maren-kest", words, ...extra });
const bray = (words: string): EpisodeScriptBlock => ({ id: ulid(), kind: "dialogue", speaker: "bray-half-hitch", words });

describe("hearing an audio drama's lines (SPEC-057 R-25..R-31)", () => {
  it("names a speaker with no voice back, and substitutes nobody unasked (R-28)", async () => {
    const a = maren("The log said two hours."), b = bray("The log's wrong.");
    const { store, id, deps, sent } = await drama([a, b]);
    const quoted = await hearDramaLines(store, id, { episode: 1, blocks: [a.id, b.id] }, deps());
    assert.equal(quoted.disposition, "quoted");
    if (quoted.disposition !== "quoted") return;
    assert.deepEqual(quoted.missing.map((m) => [m.speaker, m.blocks]), [["bray-half-hitch", [b.id]]]);
    assert.deepEqual(quoted.quote.requests.map((r) => r.block), [a.id], "the uncast line is not priced as if it had a voice");
    assert.equal(sent.length, 0);
    const standIn = await hearDramaLines(store, id, { episode: 1, blocks: [b.id], decisions: { "bray-half-hitch": "narrator" }, quoteOnly: true }, deps());
    assert.ok(standIn.disposition === "quoted" && standIn.quote.requests[0]!.standIn && standIn.quote.requests[0]!.voice === "The narrator");
    const left = await hearDramaLines(store, id, { episode: 1, blocks: [a.id, b.id], decisions: { "bray-half-hitch": "leave-out" }, quoteOnly: true }, deps());
    assert.ok(left.disposition === "quoted" && left.missing.length === 0 && left.quote.requests.length === 1);
  });

  it("makes only against the token it quoted, keeps a first take, and plays it again without sending (R-26, R-29)", async () => {
    const a = maren("The log said two hours.", { direction: "flat, tired" });
    const { store, id, deps, sent, takes } = await drama([a]);
    const quoted = await hearDramaLines(store, id, { episode: 1, blocks: [a.id] }, deps());
    assert.ok(quoted.disposition === "quoted" && quoted.quote.estimatedMicroUsd > 0, "an ElevenLabs line is priced");
    if (quoted.disposition !== "quoted") return;
    assert.ok(quoted.quote.requests[0]!.direction, "what happened to the direction is said");
    const made = await hearDramaLines(store, id, { episode: 1, blocks: [a.id], quoteToken: quoted.quote.token }, deps());
    assert.deepEqual(made, { disposition: "made", made: [a.id] });
    assert.equal(sent.length, 1);
    const kept = takes()!.lines[a.id]!.kept!;
    assert.ok(kept.file.startsWith("artifacts/"));
    assert.equal(kept.voice.voiceId, "v_8Kq2");
    const again = await hearDramaLines(store, id, { episode: 1, blocks: [a.id], quoteOnly: true }, deps());
    assert.ok(again.disposition === "quoted" && again.quote.requests[0]!.cached && again.quote.estimatedMicroUsd === 0);
    const replayed = await hearDramaLines(store, id, { episode: 1, blocks: [a.id], quoteToken: again.disposition === "quoted" ? again.quote.token : "" }, deps());
    assert.deepEqual(replayed, { disposition: "made", made: [] }, "a line performed for these words is played, not sent again");
    assert.equal(sent.length, 1);
  });

  it("a retake of a current line waits for the author; Keep new replaces it (R-30)", async () => {
    const a = maren("Climb.");
    const { store, id, deps, takes } = await drama([a]);
    const first = await hearDramaLines(store, id, { episode: 1, blocks: [a.id] }, deps());
    await hearDramaLines(store, id, { episode: 1, blocks: [a.id], quoteToken: first.disposition === "quoted" ? first.quote.token : "" }, deps());
    const firstTake = takes()!.lines[a.id]!.kept!;
    const quoted = await hearDramaLines(store, id, { episode: 1, blocks: [a.id], retake: true }, deps());
    await hearDramaLines(store, id, { episode: 1, blocks: [a.id], retake: true, quoteToken: quoted.disposition === "quoted" ? quoted.quote.token : "" }, deps());
    const line = takes()!.lines[a.id]!;
    assert.equal(line.kept!.artifactId, firstTake.artifactId, "the kept take stays until the author decides");
    assert.ok(line.waiting && line.waiting.artifactId !== firstTake.artifactId);
    await decideDramaTake(store, id, 1, a.id, "new");
    assert.equal(takes()!.lines[a.id]!.kept!.artifactId, line.waiting.artifactId);
    assert.equal(takes()!.lines[a.id]!.waiting, undefined);
  });

  it("a take heard to say other words waits with what was heard (R-30)", async () => {
    const a = maren("The log said two hours.");
    const { store, id, deps, takes } = await drama([a]);
    const misheard = deps({ transcribe: async () => "the dog said two flowers" });
    const quoted = await hearDramaLines(store, id, { episode: 1, blocks: [a.id] }, misheard);
    await hearDramaLines(store, id, { episode: 1, blocks: [a.id], quoteToken: quoted.disposition === "quoted" ? quoted.quote.token : "" }, misheard);
    const line = takes()!.lines[a.id]!;
    assert.equal(line.kept, undefined, "a misread first take is not kept on its own");
    assert.equal(line.waiting!.misread, "the dog said two flowers");
  });

  it("places takes: a first keeps itself, one for changed words replaces, a retake or misread waits", () => {
    const take = (textHash: string, extra: object = {}) => ({ artifactId: `art_${textHash}`, file: "artifacts/x.mp3", textHash, voice: NARRATOR, estimatedMicroUsd: 0, madeAt: CLOCK, ...extra }) as never;
    assert.deepEqual(placeTake(undefined, take("a"), false), { kept: take("a") });
    assert.deepEqual(placeTake({ kept: take("old") }, take("new"), false), { kept: take("new") }, "the kept take no longer matched the line");
    assert.deepEqual(placeTake({ kept: take("a") }, take("a"), true), { kept: take("a"), waiting: take("a") });
    assert.deepEqual(placeTake({ kept: take("a") }, take("b", { misread: "x" }), false), { kept: take("a"), waiting: take("b", { misread: "x" }) });
  });
});
