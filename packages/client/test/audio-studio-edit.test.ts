import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { audioSamples, newAudioClip, resolveAudioArrangement, type AudioStudioSnapshot } from "@arke-studio/contracts";
import { audioStudioAddition, audioStudioReview } from "../src/lib/audio-studio-edit.js";
import { audioGestureCommand } from "../src/lib/audio-studio-gesture.js";

function fixture(): AudioStudioSnapshot {
  const source = { file: "artifacts/voice.wav", hash: `sha256:${"a".repeat(64)}`, samples: audioSamples(3), channels: 2, rate: 48000, label: "Voice" };
  return { base: "a".repeat(64), revision: 2, undo: "Add clip", redo: null, passages: [{ key: "p0.0", text: "Welcome home." }], library: [],
    script: { hash: "script", passages: [{ key: "p0.0", textHash: "welcome" }] },
    state: { manuscriptHash: "script", passages: [{ id: "passage", key: "p0.0", textHash: "welcome" }], tracks: [{ id: "voice", name: "Voice", gainDb: 0, muted: false }],
      clips: [{ ...newAudioClip("voice", "voice", source, source.samples), role: "speech", passageId: "passage", placement: { kind: "sequence", offset: 0 } }], omissions: [], master: { targetLufs: -18, ceilingDb: -1.5 } } };
}
describe("Audio Studio edit preparation", () => {
  it("reviews source changes without mutating Current and resets source-specific trims", () => {
    const snapshot = fixture(); snapshot.state.clips[0]!.sourceIn = audioSamples(1);
    const original = structuredClone(snapshot), source = { ...snapshot.state.clips[0]!.source!, samples: audioSamples(5), file: "artifacts/new.wav" };
    const review = audioStudioReview(snapshot, { kind: "commands", label: "Replace", commands: [{ kind: "replace-source", id: "voice", source }] });
    assert.deepEqual(snapshot, original); assert.equal(review.base, snapshot.base); assert.equal(review.trimsReset, true);
    assert.equal(review.current.samples, audioSamples(2)); assert.equal(review.suggested.samples, audioSamples(5));
  });
  it("keeps dropped effects fixed and explicitly attaches a selected performance", () => {
    const snapshot = fixture(), source = snapshot.state.clips[0]!.source!;
    const drop = audioStudioAddition(snapshot, source, { at: 12001, trackId: "voice" });
    const dropped = drop.at(-1)!;
    assert.deepEqual(dropped.kind === "add-clip" && dropped.clip.placement, { kind: "fixed", at: 12001 });
    const speech = audioStudioAddition(snapshot, source, { at: 12001, passageKey: "p0.0" });
    const command = speech.at(-1)!; assert.equal(command.kind, "add-clip");
    if (command.kind === "add-clip") { assert.equal(command.clip.passageId, "passage"); assert.deepEqual(command.clip.placement, { kind: "sequence", offset: 0 }); }
  });
  it("refuses to guess the identity of repeated text after a manuscript edit", () => {
    const snapshot = fixture(); snapshot.state.passages.push({ id: "second", key: "p1.0", textHash: "welcome" });
    snapshot.state.manuscriptHash = "old-script";
    const commands = audioStudioAddition(snapshot, snapshot.state.clips[0]!.source!, { at: 0, passageKey: "p0.0" });
    assert.equal(commands[0]?.kind, "add-passage", "an explicit new identity cannot silently rebind either old passage");
  });
  it("shared pointer gestures preserve linked placement and exact sample trims", () => {
    const snapshot = fixture(), entry = resolveAudioArrangement(snapshot.state, snapshot.script).clips[0]!;
    const move = audioGestureCommand(entry, "move", 12001);
    assert.deepEqual(move?.kind === "set-clip" && move.changes.placement, { kind: "sequence", offset: 12001 });
    const trim = audioGestureCommand(entry, "trim-start", 2401);
    assert.equal(trim?.kind === "set-clip" && trim.changes.sourceIn, 2401);
    assert.deepEqual(trim?.kind === "set-clip" && trim.changes.placement, { kind: "sequence", offset: 2401 });
  });
});
