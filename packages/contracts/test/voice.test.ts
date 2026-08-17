import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { narratorFor, DEFAULT_NARRATOR } from "../src/voice.js";
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
