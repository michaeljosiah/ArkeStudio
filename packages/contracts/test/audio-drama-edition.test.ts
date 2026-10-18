import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dramaCredits, episodeReadiness, listenerTranscript } from "../src/audio-drama-edition.js";
import { dramaLineHash, type DramaTake, type EpisodeScriptBlock, type EpisodeTakes } from "../src/audio-drama.js";
import { ulid } from "../src/ids.js";

/** An audio drama's edition (SPEC-057 R-72..R-75): what is ready, and what a listener reads. */
const line = (speaker: string, words: string, extra: object = {}): Extract<EpisodeScriptBlock, { kind: "dialogue" }> =>
  ({ id: ulid(), kind: "dialogue", speaker, words, ...extra }) as never;
const take = (block: Extract<EpisodeScriptBlock, { kind: "dialogue" }>, extra: Partial<DramaTake> = {}): DramaTake => ({ artifactId: "ar_1" as never, file: "artifacts/a.wav",
  textHash: dramaLineHash(block), voice: { provider: "elevenlabs", model: "m", voiceId: "v", label: "Coral" }, estimatedMicroUsd: 0, madeAt: "2026-10-18T12:00:00.000Z", ...extra });
const takes = (lines: EpisodeTakes["lines"]): EpisodeTakes => ({ version: 1, episode: 1, lines });
const name = (slug: string) => ({ maren: "Maren Kest", sereth: "Sereth", ilo: "Ilo Kest" })[slug] ?? slug;

describe("episode readiness (R-72)", () => {
  it("is ready when every line has a current take and every required sound is placed; a stand-in is said, not refused", () => {
    const a = line("maren", "Climb."), b = line("sereth", "Turn of tide.");
    const ready = episodeReadiness([a, b], takes({ [a.id]: { kept: take(a) }, [b.id]: { kept: take(b, { standIn: true }) } }), name);
    assert.deepEqual(ready, { ready: true, reasons: [], notes: ["Sereth's stand-in kept"] });
  });

  it("refuses with its reasons: lines not performed, takes out of date or waiting, a required sound missing", () => {
    const a = line("maren", "Climb."), b = line("sereth", "Turn of tide."), c = line("maren", "Now.");
    const cue: EpisodeScriptBlock = { id: ulid(), kind: "sound", heard: "The bell.", required: true };
    const held = episodeReadiness([a, b, c, cue], takes({
      [a.id]: { kept: take({ ...a, words: "Climb!" }) },
      [b.id]: { kept: take(b), waiting: take(b) },
    }), name);
    assert.equal(held.ready, false);
    assert.deepEqual(held.reasons, ["1 line not performed", "1 take out of date", "1 take waits for a decision", "1 sound missing"]);
    assert.deepEqual(episodeReadiness([a], undefined, name).reasons, ["not performed"]);
  });
});

describe("the listener's transcript and the credits (R-74, R-75)", () => {
  it("writes what is said and the meaningful sound, never a direction, a hidden role by its label until its reveal", () => {
    const blocks: EpisodeScriptBlock[] = [
      line("maren", "Climb.", { direction: "breathless" }),
      { id: ulid(), kind: "sound", heard: "The bell.", required: true },
      { id: ulid(), kind: "ambience", heard: "Wind." },
      line("ilo", "I'm here."),
      { id: ulid(), kind: "narration", words: "She climbed." },
    ];
    const cast = { ilo: { publicLabel: "The Singer", revealEpisode: 5 } };
    const text = listenerTranscript([{ episode: 2, title: "The Tide Log", blocks }], name, cast);
    assert.equal(text, "Episode 2 · The Tide Log\n\nMAREN KEST: Climb.\n[The bell.]\nTHE SINGER: I'm here.\nNARRATOR: She climbed.\n");
    assert.doesNotMatch(text, /breathless|Ilo|Wind/);
    assert.match(listenerTranscript([{ episode: 5, title: "", blocks }], name, cast), /ILO KEST: I'm here\./, "named from the episode that reveals them");
  });

  it("credits the voices, the recordings and each generated sound by its engine, and says AI was used", () => {
    const credits = dramaCredits({ title: "Low Water", roles: [{ role: "Maren Kest", voice: "Coral · elevenlabs" }, { role: "Ilo Kest", voice: "your recording", recorded: true }],
      sounds: [{ name: "Harbour bell", engine: "eleven_text_to_sound_v2" }] });
    assert.match(credits, /Maren Kest — Coral · elevenlabs/);
    assert.match(credits, /Ilo Kest — your recording \(recorded\)/);
    assert.match(credits, /Harbour bell — generated with eleven_text_to_sound_v2/);
    assert.match(credits, /made with AI/);
  });
});
