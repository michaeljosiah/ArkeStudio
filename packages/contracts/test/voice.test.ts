import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clonedVoiceCandidates,
  DEFAULT_NARRATOR,
  extractVoiceAttributes,
  mintVoiceId,
  narratorFor,
  newClonedVoice,
  parseVoiceLibrary,
  rankVoices,
} from "../src/voice.js";
import { ClientMessageSchema } from "../src/frames.js";

/**
 * The narrator (asked for 2026-08-17): a third voice role, and deliberately not either of the
 * other two. A character voice lives on a sheet and answers who speaks; a reading voice is
 * chosen per take on the bench and belongs to one recording. The narrator reads text *about*
 * the world rather than lines *in* it.
 */

describe("who narrates (asked for 2026-08-17)", () => {
  const catalogue = [
    { provider: "kokoro", voiceId: "bm_george", label: "George", attributes: [], local: true, canClone: false },
    { provider: "elevenlabs", voiceId: "v_roger", label: "Roger", attributes: [], local: false, canClone: true },
  ];

  it("reads in the shipped local voice until somebody chooses otherwise", () => {
    // Local by default on purpose: "read aloud" is a passive press, and no other preference in
    // this app spends money on one.
    const chosen = narratorFor(null, catalogue);
    assert.equal(chosen.provider, DEFAULT_NARRATOR.provider);
    assert.equal(chosen.voiceId, DEFAULT_NARRATOR.voiceId);
    assert.equal(chosen.fallback, true);
    // Local is not incidental: it is what keeps a passive press from spending.
    assert.equal(catalogue.find((v) => v.voiceId === DEFAULT_NARRATOR.voiceId)?.local, true);
  });

  it("uses the chosen voice, carrying its own provider", () => {
    // Routing picks a model and can disagree with a voice's provider; the voice wins, because
    // one that resolves to a provider unable to say it is the silent mismatch this codebase
    // keeps paying for.
    const chosen = narratorFor({ provider: "elevenlabs", voiceId: "v_roger" }, catalogue);
    assert.equal(chosen.provider, "elevenlabs");
    assert.equal(chosen.voiceId, "v_roger");
    assert.equal(chosen.label, "Roger", "the label comes from the live catalogue, not the stored copy");
    assert.equal(chosen.fallback, false);
  });

  it("falls back rather than failing when the chosen voice is gone", () => {
    // A key withdrawn or a runtime uninstalled should quieten the reading to the local voice,
    // not turn every read-aloud into an error about a voice the user can no longer see.
    const chosen = narratorFor({ provider: "elevenlabs", voiceId: "v_deleted" }, catalogue);
    assert.equal(chosen.fallback, true);
    assert.equal(chosen.provider, "kokoro");
  });
});

describe("the voice catalogue belongs to the app, not a world", () => {
  it("asks for voices with no world open", () => {
    // Settings is reached from the world picker, where no world is open. An empty worldId
    // failed frame validation and the request was dropped, so the narrator's picker sat on
    // "Reading the catalogue…" forever — found on the first press in the installed app.
    assert.equal(ClientMessageSchema.safeParse({ kind: "voice-catalogue" }).success, true);
    assert.equal(
      ClientMessageSchema.safeParse({ kind: "voice-catalogue", worldId: "" }).success,
      false,
      "an empty id is still a bad id — absent is the way to say 'no world'",
    );
  });
});

/**
 * The cloned-voice library (SPEC-022 §2.3). IndexTTS ships with no voices at all — a voice in its
 * world is a wav file — so this is the adapter that makes a clip addressable as `{provider,
 * voiceId}` the way every other surface already expects.
 */
describe("a clip becomes a voice", () => {
  const base = {
    name: "Harbour glass",
    description: "Low, dry, unhurried. Coastal.",
    clip: "voices/harbour-glass.wav",
    consent: true,
    created: "2026-08-18T10:00:00.000Z",
    taken: [] as string[],
  };

  it("mints a readable id and extracts the description into matchable attributes", () => {
    const made = newClonedVoice(base);
    assert.equal(made.ok, true);
    assert.ok(made.ok);
    assert.equal(made.voice.id, "harbour-glass");
    // The description is not decoration: these are what rankVoices matches a written voice on.
    assert.deepEqual(made.voice.attributes, extractVoiceAttributes(base.description));
    assert.ok(made.voice.attributes.includes("coastal"));
  });

  it("refuses a voice with no description, because the picker would bury it (D3)", () => {
    const made = newClonedVoice({ ...base, description: "   " });
    assert.equal(made.ok, false);
    assert.ok(!made.ok);
    assert.match(made.reason, /what the picker matches on/);
  });

  it("refuses a voice whose speaker never agreed", () => {
    const made = newClonedVoice({ ...base, consent: false });
    assert.ok(!made.ok);
    assert.match(made.reason, /agreed to have their voice cloned/);
  });

  it("a cloned voice ranks against a written voice like any other candidate", () => {
    const made = newClonedVoice(base);
    assert.ok(made.ok);
    const ranked = rankVoices(extractVoiceAttributes("A low, dry voice. Coastal, unhurried."), [
      ...clonedVoiceCandidates([made.voice]),
      { provider: "kokoro", voiceId: "af_bella", label: "Bella", attributes: [], local: true, canClone: false },
    ]);
    assert.equal(ranked[0]?.candidate.voiceId, "harbour-glass", "described beats undescribed");
    assert.ok(ranked[0]!.overlap > 0);
    // Local, and not itself cloneable — the original recording is already in the library.
    assert.equal(ranked[0]?.candidate.local, true);
    assert.equal(ranked[0]?.candidate.canClone, false);
  });

  it("names collide readably rather than clobbering", () => {
    assert.equal(mintVoiceId("Harbour glass", ["harbour-glass"]), "harbour-glass-2");
    assert.equal(mintVoiceId("Harbour glass", ["harbour-glass", "harbour-glass-2"]), "harbour-glass-3");
    assert.equal(mintVoiceId("!!!", []), "voice", "a name with nothing to slug still gets an id");
  });

  it("keeps what parses and drops only the bad entry", () => {
    // A hand-edited or older file must not delete every voice the world owns — the failure
    // SheetSchema's leniency exists to avoid, applied to the read path for voices.
    const voices = parseVoiceLibrary({
      voices: [
        { id: "a", name: "A", clip: "voices/a.wav" },
        { id: "", name: "broken", clip: "voices/b.wav" },
        { name: "no id either", clip: "voices/c.wav" },
        { id: "d", name: "D", clip: "voices/d.wav", description: "warm", attributes: ["warm"] },
      ],
    });
    assert.deepEqual(
      voices.map((v) => v.id),
      ["a", "d"],
    );
    // Defaults fill in rather than refusing: an entry written before consent was asked for reads.
    assert.equal(voices[0]?.consent, false);
    assert.deepEqual(voices[0]?.attributes, []);
  });

  it("a library that is not a library is empty, not a crash", () => {
    assert.deepEqual(parseVoiceLibrary(null), []);
    assert.deepEqual(parseVoiceLibrary({ voices: "nope" }), []);
  });
});
