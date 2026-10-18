import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AudioDramaRecordSchema, dramaRoleName, dramaTakeState, dramaLineHash, narrationQuotes, reviewCoverage, reviewDramaScript, sheetSound,
  type EpisodeScriptBlock,
} from "../src/audio-drama.js";
import { ulid } from "../src/ids.js";

/** Review and Cast (SPEC-057 R-49..R-60): what each note rests on, and who a role is to the listener. */
const line = (speaker: string, words: string, extra: object = {}): EpisodeScriptBlock => ({ id: ulid(), kind: "dialogue", speaker, words, ...extra });
const heading = (place: string, extra: object = {}): EpisodeScriptBlock => ({ id: ulid(), kind: "heading", place, ...extra });
const narration = (words: string, extra: object = {}): EpisodeScriptBlock => ({ id: ulid(), kind: "narration", words, ...extra });
const ambience = (heard: string): EpisodeScriptBlock => ({ id: ulid(), kind: "ambience", heard });
const names = { maren: "Maren Kest", bray: "Bray", ilo: "Ilo Kest" };

describe("review coverage (R-51)", () => {
  it("says no audio has been heard, or exactly what has", () => {
    assert.equal(reviewCoverage(3, [], 1450), "Script v3 · no audio heard yet");
    assert.equal(reviewCoverage(3, [[0, 880]], 1450), "heard 0:00–14:40 of 24:10");
  });

  it("merges overlapping listening, keeps gaps, and clamps to the episode", () => {
    assert.equal(reviewCoverage(1, [[300, 400], [0, 100], [50, 200]], 600), "heard 0:00–3:20, 5:00–6:40 of 10:00");
    assert.equal(reviewCoverage(1, [[550, 900], [-5, 10]], 600), "heard 0:00–0:10, 9:10–10:00 of 10:00");
    assert.equal(reviewCoverage(2, [[40, 40]], 600), "Script v2 · no audio heard yet", "an empty interval is not listening");
  });
});

describe("the script's review (R-50..R-53)", () => {
  it("rests every note on the script's version, and lists intelligibility as waiting for heard audio", () => {
    const review = reviewDramaScript({
      episode: 1, version: 3, names,
      blocks: [heading("The bell tower"), line("maren", "Bray. Bray, look."), line("bray", "I see them.", { direction: "slowly, as if he had said “never” before and meant it every single time" })],
    });
    assert.equal(review.coverage, "Script v3 · no audio heard yet");
    assert.ok(review.notes.length > 0);
    assert.ok(review.notes.every((note) => note.evidence === "script v3"));
    assert.deepEqual(review.notes.map((note) => note.check), ["clarity", "emotion"]);
    assert.ok(review.notes.every((note) => note.check !== "intelligibility"), "no note claims audio it did not hear");
    assert.deepEqual(review.checked.find((entry) => entry.check === "intelligibility"), { check: "intelligibility", says: "Needs heard audio." });
  });

  it("reports a leak of something kept from the listener with its reveal episode, and only before it", () => {
    const leak = line("bray", "Ilo's alive. I heard him sing.");
    const plan = { minutes: 25, keptFromListener: [{ fact: "Ilo is alive", revealEpisode: 5 }] };
    const early = reviewDramaScript({ episode: 2, version: 1, names, plan, blocks: [heading("The quay"), ambience("Gulls"), leak] });
    const note = early.notes.find((candidate) => candidate.check === "mystery");
    assert.deepEqual(note && [note.blocks, note.says], [[leak.id], "This may tell the listener “Ilo is alive” before episode 5."]);
    const late = reviewDramaScript({ episode: 5, version: 1, names, plan, blocks: [heading("The quay"), ambience("Gulls"), leak] });
    assert.equal(late.notes.filter((candidate) => candidate.check === "mystery").length, 0);
    const safe = reviewDramaScript({ episode: 2, version: 1, names, plan, blocks: [heading("The quay"), ambience("Gulls"), line("bray", "The tide's turning.")] });
    assert.deepEqual(safe.checked.filter((entry) => entry.check === "mystery"), [{ check: "mystery", says: "Nothing here tells the listener Ilo is alive." }]);
  });

  it("reports a hidden role's real name spoken before the episode that reveals it", () => {
    const cast = { ilo: { publicLabel: "The Singer", revealEpisode: 5 } };
    const named = narration("Somewhere below, Ilo Kest was singing.");
    const review = reviewDramaScript({ episode: 3, version: 2, names, cast, blocks: [heading("Below"), ambience("Water"), named] });
    assert.deepEqual(review.notes.filter((note) => note.check === "mystery").map((note) => note.says), ["Ilo Kest is named here, before episode 5."]);
  });

  it("checks fidelity, clarity and pacing from the script alone", () => {
    const pinned = heading("The bell tower", { source: { story: "low-water", chapter: "the-bell-tower", version: 12 } });
    const added = line("maren", "This was never in the book.");
    const sourced = line("bray", "The log's wrong.", { paragraphs: [14] });
    const offMic = Array.from({ length: 5 }, () => line("bray", "Still here.", { channel: "off-mic" }));
    const speech = line("maren", Array.from({ length: 80 }, () => "word").join(" "));
    const review = reviewDramaScript({
      episode: 1, version: 4, names, voices: { maren: "elevenlabs/v1", bray: "elevenlabs/v1" },
      chapters: [{ story: "low-water", chapter: "the-bell-tower", version: 14 }],
      blocks: [pinned, ambience("Wind in the stair"), added, sourced, ...offMic, speech],
    });
    const says = review.notes.map((note) => `${note.check}: ${note.says}`);
    assert.ok(says.includes("fidelity: 7 lines in this scene are not in the source."));
    assert.ok(says.includes("fidelity: Written from v12. The chapter is now v14."));
    assert.ok(says.includes("clarity: Bray is off-mic for 5 lines. The listener may lose where they are."));
    assert.ok(says.includes("clarity: Maren Kest and Bray speak in the same voice here."));
    assert.ok(says.includes("pacing: About 31 s in one breath. Long for the ear."));
    assert.equal(new Set(review.notes.map((note) => note.key)).size, review.notes.length, "every note decides on its own key");
  });

  it("lists a check with nothing to say as closed", () => {
    const review = reviewDramaScript({ episode: 1, version: 1, names, blocks: [heading("The quay"), ambience("Gulls"), line("maren", "Climb.")] });
    assert.equal(review.notes.length, 0);
    assert.deepEqual(review.checked.map((entry) => entry.check), ["fidelity", "clarity", "pacing", "emotion", "mystery", "intelligibility"]);
  });
});

describe("cast (R-57..R-59, R-85)", () => {
  it("uses the public label until the reveal episode", () => {
    const role = { publicLabel: "The Singer", revealEpisode: 5 };
    assert.equal(dramaRoleName("Ilo Kest", role, 4), "The Singer");
    assert.equal(dramaRoleName("Ilo Kest", role, 5), "Ilo Kest");
    assert.equal(dramaRoleName("Ilo Kest", undefined, 1), "Ilo Kest");
  });

  it("keeps a hidden identity whole: a label needs its episode", () => {
    const record = (cast: object) => AudioDramaRecordSchema.safeParse({ version: 1, plan: { episodes: 6, minutes: 25 }, cast });
    assert.ok(record({ ilo: { publicLabel: "The Singer", revealEpisode: 5 } }).success);
    assert.ok(!record({ ilo: { publicLabel: "The Singer" } }).success);
    assert.ok(record({ narrator: { sound: "Close, unhurried." } }).success);
  });

  it("finds whose words a narration quotes, by name, only where it quotes", () => {
    assert.deepEqual(narrationQuotes("“Two hours,” Maren said.", names), ["maren"]);
    assert.deepEqual(narrationQuotes("Maren looked at the water.", names), [], "no quotation, no quote");
    assert.deepEqual(narrationQuotes("“Climb,” said Bray to Maren Kest.", names).sort(), ["bray", "maren"]);
  });

  it("starts How they sound from the sheet's Voice section", () => {
    const sheet = { sections: [{ heading: "Essence", body: "x" }, { heading: "Voice · written", body: "Low and even.\nNever wastes a word.\n\nSecond paragraph." }] };
    assert.equal(sheetSound(sheet), "Low and even. Never wastes a word.");
    assert.equal(sheetSound({ sections: [] }), undefined);
  });

  it("puts a kept take out of date when the role's voice changes (R-60)", () => {
    const block = { id: ulid(), kind: "dialogue" as const, speaker: "maren", words: "Climb." };
    const kept = { artifactId: "ar_1" as never, file: "artifacts/a.mp3", textHash: dramaLineHash(block),
      voice: { provider: "elevenlabs", model: "m", voiceId: "a" }, estimatedMicroUsd: 0, madeAt: "2026-10-18T12:00:00.000Z" };
    assert.equal(dramaTakeState(block, { kept }, { provider: "elevenlabs", voiceId: "a" }), "kept");
    assert.equal(dramaTakeState(block, { kept }, { provider: "elevenlabs", voiceId: "b" }), "out of date");
    assert.equal(dramaTakeState(block, { kept: { ...kept, standIn: true } }), "stand-in");
    assert.equal(dramaTakeState(block, { kept: { ...kept, standIn: true } }, { provider: "elevenlabs", voiceId: "b" }), "out of date", "a voice of its own now");
  });
});

describe("codex round 1 on PR 1873", () => {
  it("catches a one-word secret, whole", () => {
    const plan = { minutes: 25, keptFromListener: [{ fact: "Pregnant.", revealEpisode: 4 }] };
    const said = line("bray", "She's pregnant, Maren.");
    const review = reviewDramaScript({ episode: 2, version: 1, names, plan, blocks: [heading("Quay"), ambience("Gulls"), said] });
    assert.deepEqual(review.notes.filter((note) => note.check === "mystery").map((note) => note.blocks), [[said.id]]);
    const clear = reviewDramaScript({ episode: 2, version: 1, names, plan, blocks: [heading("Quay"), ambience("Gulls"), line("bray", "Pregnancy tests are dear.")] });
    assert.equal(clear.notes.filter((note) => note.check === "mystery").length, 0);
  });

  it("names a role by its first word only where no other role shares it", () => {
    const two = { kest: "Maren Kest", vale: "Maren Vale" };
    assert.deepEqual(narrationQuotes("“Climb,” said Maren Kest.", two), ["kest"]);
    assert.deepEqual(narrationQuotes("“Climb,” said Maren.", two), [], "an ambiguous first name names neither");
  });

  it("opens a decided note again when its line is rewritten", () => {
    const leak = (words: string) => ({ ...line("bray", words), id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }) as EpisodeScriptBlock;
    const plan = { minutes: 25, keptFromListener: [{ fact: "Ilo is alive", revealEpisode: 5 }] };
    const key = (words: string) => reviewDramaScript({ episode: 1, version: 1, names, plan, blocks: [heading("Quay"), ambience("Gulls"), leak(words)] })
      .notes.find((note) => note.check === "mystery")!.key;
    assert.notEqual(key("Ilo's alive."), key("Ilo is alive, I swear it."));
  });

  it("checks lines before the first heading too", () => {
    const opener = line("maren-kest", "Bray.");
    const review = reviewDramaScript({ episode: 1, version: 1, names, blocks: [opener] });
    assert.deepEqual(review.notes.filter((note) => note.check === "clarity").map((note) => note.blocks), [[opener.id]]);
  });
});
