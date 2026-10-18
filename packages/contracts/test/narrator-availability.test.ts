import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookNarratorUnavailable, readerUnavailableWords } from "../src/narrator-availability.js";

/**
 * Why the book's own narrator cannot read now (issue 1661): a 402 left a read waiting on
 * `request 1 of 9` with the reason only in app.jsonl, and the door named George over the book's
 * designed voice. One judgement, so the chapter, the door and the run hold on the same words.
 */
describe("the book narrator's availability (issue 1661)", () => {
  const NARRATOR = { provider: "google", model: "gemini-2.5-flash-tts", voiceId: "designed:ife", label: "Nigerian Woman 2" };
  const row = { provider: "google", model: "gemini-2.5-flash-tts", voiceId: "designed:ife", attributes: [] };
  const ok = { id: "google" as const, fault: null };
  const paying = { id: "google" as const, fault: "google: HTTP 402 payment_required", faultKind: "credential" as const };

  it("says nothing of a narrator that reads, or a book with none of its own", () => {
    assert.equal(bookNarratorUnavailable(NARRATOR, [row], [ok]), null);
    assert.equal(bookNarratorUnavailable(undefined, [], [paying]), null, "an inherited narrator is not the book's to hold");
  });

  it("names a refused payment as the author acts on it, ahead of anything the catalogue says", () => {
    assert.equal(bookNarratorUnavailable(NARRATOR, [row], [paying]), "Google needs payment");
    assert.equal(bookNarratorUnavailable(NARRATOR, null, [paying]), "Google needs payment", "a fault speaks before the catalogue answers");
    assert.equal(bookNarratorUnavailable(NARRATOR, [row], [{ id: "google", fault: "google rejected the key (HTTP 401)" }]), "google rejected the key (HTTP 401)");
  });

  it("a store's fault is not the credential's, and leaves the narrator reading", () => {
    assert.equal(bookNarratorUnavailable(NARRATOR, [row], [{ id: "google", fault: "the key could not be saved", faultKind: "not-saved" }]), null);
  });

  it("gives the catalogue's reason, and says a voice the list dropped is not in it", () => {
    assert.equal(bookNarratorUnavailable(NARRATOR, [{ ...row, unavailableReason: "Connect the Google project that owns this voice. Saved audio still plays." }]), "Connect the Google project that owns this voice. Saved audio still plays.");
    assert.equal(bookNarratorUnavailable(NARRATOR, [{ ...row, unavailableReason: "HTTP 402 payment required" }]), "Google needs payment");
    assert.equal(bookNarratorUnavailable(NARRATOR, [{ ...row, voiceId: "designed:other" }]), "Google doesn't list this voice now");
    assert.equal(bookNarratorUnavailable(NARRATOR, [{ ...row, narratorCopy: true }]), "Google doesn't list this voice now", "the app narrator's copy of another world's voice is not this world's (SPEC-049 R-12)");
  });

  it("a catalogue not yet asked, or one that did not load, says nothing of the voice", () => {
    assert.equal(bookNarratorUnavailable(NARRATOR, null, [ok]), null);
    assert.equal(bookNarratorUnavailable(NARRATOR, [], [ok]), null);
  });

  it("puts a refused payment in the author's words and leaves any other reason as the reader said it", () => {
    assert.equal(readerUnavailableWords("elevenlabs", "elevenlabs: HTTP 402 payment_required"), "ElevenLabs needs payment");
    assert.equal(readerUnavailableWords("elevenlabs", "offline"), "offline");
  });
});
