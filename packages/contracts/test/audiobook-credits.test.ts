import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AudiobookCreditsSchema,
  audiobookCreditFacts,
  audiobookCreditMissing,
  audiobookCreditWarning,
  audiobookCreditWords,
  draftAudiobookCredit,
} from "../src/audiobook-credits.js";

const defaults = { title: "Na love or Juju", author: "Michael Josiah", voiceLabel: "Nigerian Woman 2", year: 2026 };

describe("audiobook credits (design turn 252, SPEC-047 R-210 – R-213)", () => {
  it("drafts ACX's shape from the details, naming the narrator the author gives", () => {
    const facts = audiobookCreditFacts({ narrator: "Ife Balogun" }, defaults);
    assert.equal(draftAudiobookCredit("opening", facts), "Na love or Juju. Written by Michael Josiah. Narrated by Ife Balogun.");
    assert.equal(
      draftAudiobookCredit("closing", facts),
      "You have been listening to Na love or Juju, written by Michael Josiah, narrated by Ife Balogun. Copyright 2026 Michael Josiah. The End.",
    );
  });

  it("names the narrator's voice where the author named no one, and never says how it was made", () => {
    const facts = audiobookCreditFacts({}, defaults);
    assert.equal(facts.narrator, "Nigerian Woman 2");
    for (const key of ["opening", "closing"] as const) assert.doesNotMatch(draftAudiobookCredit(key, facts), /\bAI\b/);
  });

  it("drops a clause whose detail is empty rather than speaking a gap", () => {
    const facts = audiobookCreditFacts({ author: "", copyright: "" }, { ...defaults, voiceLabel: null });
    assert.equal(draftAudiobookCredit("opening", facts), "Na love or Juju.");
    assert.equal(draftAudiobookCredit("closing", facts), "You have been listening to Na love or Juju. The End.");
  });

  it("keeps the author's own words, and redrafts only words never written over", () => {
    const credits = AudiobookCreditsSchema.parse({ schemaVersion: 1, updatedAt: "2026-10-31T12:00:00.000Z", words: { closing: "The End of Na love or Juju." } });
    const facts = audiobookCreditFacts({ narrator: "Ife Balogun" }, defaults);
    assert.deepEqual(audiobookCreditWords(credits, "closing", facts), { words: "The End of Na love or Juju.", edited: true });
    assert.equal(audiobookCreditWords(credits, "opening", facts).edited, false);
  });

  it("says which name a credit no longer carries (R-212)", () => {
    const facts = audiobookCreditFacts({ narrator: "Ife Balogun" }, defaults);
    assert.deepEqual(audiobookCreditMissing("Na love or Juju, by Michael Josiah.", facts), ["narrator"]);
    assert.equal(audiobookCreditWarning(["narrator"]), "names no narrator");
    assert.equal(audiobookCreditWarning(["title", "author"]), "names no title or author");
    assert.deepEqual(audiobookCreditMissing(draftAudiobookCredit("closing", facts), facts), []);
    // Every credit names a narrator, as ACX asks: one with none to name warns too.
    assert.deepEqual(audiobookCreditMissing("Na love or Juju.", audiobookCreditFacts({ author: "" }, { ...defaults, voiceLabel: null })), ["narrator"]);
  });
});
