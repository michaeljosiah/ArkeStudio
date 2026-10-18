import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, ulid, type EpisodeScriptBlock, type Job } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { createProduction } from "../../src/productions/ops.js";
import { decideDramaNote, saveEpisodeScript, setDramaRole } from "../../src/productions/audio-drama.js";
import { decideDramaTake, hearDramaLines, placeTake, type DramaHearDeps } from "../../src/productions/audio-drama-hear.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { WorldStore } from "../../src/world/store.js";
import { DRAMA_CAST_SCHEMA_VERSION, DRAMA_TAKE_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
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

describe("the cast in each request (SPEC-057 R-55..R-58, R-85)", () => {
  // Breeze takes a note as an instruction beside the words, so what reaches each request shows.
  const BREEZE = { provider: "breezeblue", model: "breeze-tts-2", voiceId: "breeze-a", label: "Breeze A" };

  it("sends How they sound to the actor and the narrator's version only to the narrator", async () => {
    const spoken = maren("The log said two hours.");
    const quoting: EpisodeScriptBlock = { id: ulid(), kind: "narration", words: "\u201CTwo hours,\u201D Maren said, and did not look up." };
    const plain: EpisodeScriptBlock = { id: ulid(), kind: "narration", words: "The water took the stairs." };
    const { store, id, deps } = await drama([spoken, quoting, plain]);
    await setDramaRole(store, id, "maren-kest", { voice: BREEZE, sound: "Low and even.", narration: "A little of her slowness." });
    await setDramaRole(store, id, "narrator", { voice: BREEZE, sound: "Close, unhurried." });
    const quoted = await hearDramaLines(store, id, { episode: 1, blocks: [spoken.id, quoting.id, plain.id], quoteOnly: true }, deps());
    assert.ok(quoted.disposition === "quoted");
    if (quoted.disposition !== "quoted") return;
    const [actor, narrator, narrating] = quoted.quote.requests;
    assert.deepEqual(actor!.note, { sent: "instruction", text: "Low and even." });
    assert.equal(actor!.voice, "Breeze A", "this production's voice wins over the character's");
    assert.deepEqual(narrator!.note, { sent: "instruction", text: "Close, unhurried.\nWhen quoting Maren Kest: A little of her slowness." });
    assert.doesNotMatch(narrator!.note!.text, /Low and even/, "the actor's note never reaches the narrator");
    assert.deepEqual(narrating!.note, { sent: "instruction", text: "Close, unhurried." }, "no quotation, no character's version");
  });

  it("starts the actor's note from the sheet, and says a reader that takes no instruction is not sent it", async () => {
    const spoken = maren("Climb.");
    const { store, id, deps } = await drama([spoken]);
    const quoted = await hearDramaLines(store, id, { episode: 1, blocks: [spoken.id], quoteOnly: true }, deps());
    assert.ok(quoted.disposition === "quoted");
    if (quoted.disposition !== "quoted") return;
    const note = quoted.quote.requests[0]!.note!;
    assert.equal(note.sent, "not sent");
    assert.match(note.text, /^Low and even\. Speaks to the water/);
  });

  it("gives a speaker with no voice one through this production, sheet or not (R-56)", async () => {
    const b = bray("The log's wrong.");
    const clerk: EpisodeScriptBlock = { id: ulid(), kind: "dialogue", speaker: "harbour-clerk", words: "Turn of tide." };
    const { store, id, deps } = await drama([b, clerk]);
    const before = await hearDramaLines(store, id, { episode: 1, blocks: [b.id, clerk.id], quoteOnly: true }, deps());
    assert.ok(before.disposition === "quoted" && before.missing.length === 2);
    await setDramaRole(store, id, "bray-half-hitch", { voice: BREEZE });
    await setDramaRole(store, id, "harbour-clerk", { voice: BREEZE });
    const after = await hearDramaLines(store, id, { episode: 1, blocks: [b.id, clerk.id], quoteOnly: true }, deps());
    assert.ok(after.disposition === "quoted" && after.missing.length === 0 && after.quote.requests.length === 2);
  });

  it("keeps role notes and review decisions in the production, never on the sheet (R-85)", async () => {
    const { store, id } = await drama([maren("Climb.")]);
    const record = () => store.getBundle().productions.find((p) => p.meta.id === id)!.audioDrama!;
    await setDramaRole(store, id, "maren-kest", { sound: "Quick, bright.", publicLabel: "The keeper", revealEpisode: 3 });
    await decideDramaNote(store, id, "pacing:x:1", "intentional");
    assert.deepEqual(record().cast, { "maren-kest": { sound: "Quick, bright.", publicLabel: "The keeper", revealEpisode: 3 } });
    assert.deepEqual(record().review, { "pacing:x:1": "intentional" });
    assert.ok((await readWorldMeta(store.dir)).schemaVersion >= DRAMA_CAST_SCHEMA_VERSION, "a build that cannot read the cast refuses the world");
    const sheet = store.getBundle().sheets.find((candidate) => candidate.id === "maren-kest")!;
    assert.equal(sheet.narration, undefined);
    assert.equal(sheet.name, "Maren Kest");
    await setDramaRole(store, id, "maren-kest", null);
    await decideDramaNote(store, id, "pacing:x:1", null);
    assert.equal(record().cast, undefined);
    assert.equal(record().review, undefined);
  });
});

describe("codex round 1 on PR 1871", () => {
  it("refuses a press priced from a script that has since changed", async () => {
    const a = maren("Climb.");
    const { store, id, deps } = await drama([a]);
    await assert.rejects(hearDramaLines(store, id, { episode: 1, blocks: [a.id], scriptHash: "sha256:old" }, deps()), /script changed/);
  });

  it("takes up a line already paid for when its take was never recorded, sending nothing again", async () => {
    const a = maren("The log said two hours.");
    const { store, id, deps, sent, takes } = await drama([a]);
    const quoted = await hearDramaLines(store, id, { episode: 1, blocks: [a.id] }, deps());
    assert.ok(quoted.disposition === "quoted");
    if (quoted.disposition !== "quoted") return;
    // The process stopped after the job landed and before the take: the landed file is still there.
    const dir = ".staging/drama/recovered";
    await mkdir(join(store.dir, dir), { recursive: true });
    await writeFile(join(store.dir, dir, "line.mp3"), Buffer.from("audio:paid"));
    const paid = { id: newId("jb"), status: "succeeded", target: { kind: "voice-preview", id: "drama" }, productionId: id, model: "eleven_multilingual_v2",
      params: { block: a.id, text: a.kind === "dialogue" ? a.words : "", voiceId: "v_8Kq2" }, landedFiles: [`${dir}/line.mp3`] } as unknown as Job;
    const made = await hearDramaLines(store, id, { episode: 1, blocks: [a.id], quoteToken: quoted.quote.token },
      deps({ succeededJobs: (match) => [paid].filter(match) }));
    assert.deepEqual(made, { disposition: "made", made: [a.id] });
    assert.equal(sent.length, 0, "the line is not sent again");
    assert.ok(takes()!.lines[a.id]!.kept);
    assert.ok((await readWorldMeta(store.dir)).schemaVersion >= DRAMA_TAKE_SCHEMA_VERSION, "a build that cannot read takes refuses the world");
  });
});
