import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dramaLineHash, dramaTakeState, type DramaTake } from "../src/audio-drama.js";
import { ulid } from "../src/ids.js";

/** A take answers to its line (SPEC-057 R-31): who says it, the words, the direction, the channel. */
const line = { id: ulid(), kind: "dialogue" as const, speaker: "maren", words: "Climb.", direction: "steady" };
const take = (extra: Partial<DramaTake> = {}): DramaTake => ({ artifactId: "ar_1" as never, file: "artifacts/a.mp3", textHash: dramaLineHash(line),
  voice: { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "v" }, estimatedMicroUsd: 0, madeAt: "2026-10-18T12:00:00.000Z", ...extra });

describe("a line's take (SPEC-057 R-29..R-31)", () => {
  it("goes out of date when the words, direction, speaker or channel change, and not for spacing", () => {
    const base = dramaLineHash(line);
    assert.equal(dramaLineHash({ ...line, words: "  Climb.  " }), base);
    for (const changed of [{ words: "Climb!" }, { direction: "urgent" }, { speaker: "bray" }, { channel: "radio" as const }]) {
      assert.notEqual(dramaLineHash({ ...line, ...changed }), base, JSON.stringify(changed));
    }
  });

  it("reads as none, kept, stand-in, out of date, new or kept?, or misread", () => {
    assert.equal(dramaTakeState(line, undefined), "none");
    assert.equal(dramaTakeState(line, { kept: take() }), "kept");
    assert.equal(dramaTakeState(line, { kept: take({ standIn: true }) }), "stand-in");
    assert.equal(dramaTakeState({ ...line, words: "Climb now." }, { kept: take() }), "out of date");
    assert.equal(dramaTakeState(line, { kept: take(), waiting: take() }), "new or kept?");
    assert.equal(dramaTakeState(line, { waiting: take({ misread: "climb snow" }) }), "misread");
  });
});

describe("a take and the role's voice now (codex on PR 1871)", () => {
  it("is out of date in another voice, or when a stand-in's speaker now has a voice", () => {
    const kept = take();
    assert.equal(dramaTakeState(line, { kept }, { provider: "elevenlabs", voiceId: "v" }), "kept");
    assert.equal(dramaTakeState(line, { kept }, { provider: "elevenlabs", voiceId: "w" }), "out of date");
    assert.equal(dramaTakeState(line, { kept }, { provider: "elevenlabs", voiceId: "v", model: "eleven_v3" }), "out of date", "another model of the same voice");
    assert.equal(dramaTakeState(line, { kept: take({ standIn: true }) }), "stand-in");
    assert.equal(dramaTakeState(line, { kept: take({ standIn: true }) }, { provider: "elevenlabs", voiceId: "v" }), "out of date");
  });
});
