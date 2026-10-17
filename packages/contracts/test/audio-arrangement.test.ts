import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AudioArrangementSchema, AUDIO_STUDIO_HISTORY, AUDIO_STUDIO_MAX_SAMPLES, type AudioArrangementCommand, type AudioArrangementState, type AudioSource } from "../src/audio-arrangement-schema.js";
import { audioCrossfade, audioClipGain, audioReplacementDiff, audioSamples, bindAudioPassages, editAudioArrangement, initialAudioArrangement, newAudioClip, resolveAudioArrangement, validateAudioArrangement } from "../src/audio-arrangement.js";
import { migrateAudioArrangement } from "../src/audio-arrangement-migration.js";
import { audiobookTimingHash, timeChapter } from "../src/audiobook-timing.js";

const source = (name: string, seconds = 5): AudioSource => ({ file: `artifacts/${name}.wav`, hash: `sha256:${"a".repeat(64)}`, samples: audioSamples(seconds), rate: 48000, channels: 2, label: name });
const script = { hash: "manuscript-1", passages: [{ key: "p0.0", textHash: "first" }, { key: "p1.0", textHash: "second" }] };
function state(): AudioArrangementState {
  const first = { ...newAudioClip("first", "voices", source("first"), audioSamples(5)), passageId: "one", role: "speech" as const, placement: { kind: "sequence" as const, offset: 0 } };
  const second = { ...newAudioClip("second", "voices", source("second", 3), audioSamples(3)), passageId: "two", role: "speech" as const, placement: { kind: "sequence" as const, offset: 0 } };
  const cue = { ...newAudioClip("door", "sounds", source("door", 1), audioSamples(1)), placement: { kind: "passage" as const, anchor: { passageId: "one", edge: "end" as const, offset: 0 } } };
  const fixed = { ...newAudioClip("fixed", "sounds", source("fixed", 1), audioSamples(1)), placement: { kind: "fixed" as const, at: audioSamples(12) } };
  return { manuscriptHash: script.hash, passages: script.passages.map((p, i) => ({ ...p, id: i === 0 ? "one" : "two" })),
    tracks: [{ id: "voices", name: "Voices", gainDb: 0, muted: false }, { id: "sounds", name: "Sounds", gainDb: 0, muted: false }],
    clips: [first, second, cue, fixed], omissions: [], master: { targetLufs: -18, ceilingDb: -1.5 } };
}
const change = (held: AudioArrangementState, commands: AudioArrangementCommand[]) => editAudioArrangement(initialAudioArrangement(held, "{}"), { kind: "commands", label: "Edit", commands });

describe("Audio Studio sample clock and source review (SPEC-047 R-187..R-194)", () => {
  it("removes deleted passage audio and dependent cues with one protected, undoable review", () => {
    const current = state(), deleted = { hash: "edited", passages: [script.passages[1]!] };
    assert.ok(resolveAudioArrangement(current, deleted).issues.length);
    const saved = change(current, [{ kind: "remove-passage", id: "one" }]);
    assert.deepEqual(saved.current.clips.map(clip => clip.id), ["second", "fixed"]);
    assert.deepEqual(resolveAudioArrangement(saved.current, deleted).issues, []);
    assert.deepEqual(editAudioArrangement(saved, { kind: "undo" }).current, current);
    current.clips[2]!.protected = true;
    assert.throws(() => change(current, [{ kind: "remove-passage", id: "one" }]), /protection/);
  });
  it("refuses oversized recovery and placements beyond the actual WAV limit before saving", () => {
    assert.throws(() => initialAudioArrangement(state(), "x".repeat(16 * 1024 * 1024 + 1)), /recovery record/);
    const current = state(), clip = current.clips[3]!;
    clip.placement = { kind: "fixed", at: AUDIO_STUDIO_MAX_SAMPLES - clip.sourceOut };
    assert.equal(resolveAudioArrangement(validateAudioArrangement(current), script).samples, AUDIO_STUDIO_MAX_SAMPLES);
    clip.placement.at++;
    assert.throws(() => validateAudioArrangement(current), /chapter clock/);
  });
  it("crossfades exact windows with linked placement and one undo entry", () => {
    const current = state();
    const commands = audioCrossfade(current, script, "first", "second", audioSamples(.5));
    const saved = change(current, commands), plan = resolveAudioArrangement(saved.current, script);
    assert.equal(plan.clips.find(entry => entry.clip.id === "second")?.at, audioSamples(4.5));
    assert.deepEqual(saved.current.clips[1]!.placement, { kind: "sequence", offset: -audioSamples(.5) });
    assert.equal(saved.current.clips[0]!.sourceOut, current.clips[0]!.sourceOut);
    assert.equal(saved.current.clips[1]!.sourceIn, current.clips[1]!.sourceIn);
    assert.equal(saved.undo.length, 1);
    assert.deepEqual(editAudioArrangement(saved, { kind: "undo" }).current, current);
    assert.throws(() => audioCrossfade(current, script, "first", "second", audioSamples(3)), /shorter/);
    current.clips[1]!.protected = true;
    assert.throws(() => audioCrossfade(current, script, "first", "second", audioSamples(.5)), /protection/);
  });
  it("removing a repeated performance does not omit the original passage", () => {
    const repeated = change(state(), [{ kind: "duplicate-clip", id: "first", nextId: "repeat", at: audioSamples(20) }]).current;
    const removed = change(repeated, [{ kind: "remove-clip", id: "repeat" }]).current;
    assert.deepEqual(removed.omissions, []); assert.deepEqual(resolveAudioArrangement(removed, script).issues, []);
  });
  it("requires explicit omission acknowledgement for muted speech but not solo audition", () => {
    const current = state(); current.tracks[0]!.muted = true;
    assert.equal(resolveAudioArrangement(current, script).issues.filter(issue => issue.kind === "passage").length, 2);
    const acknowledged = change(current, current.passages.map(passage => ({ kind: "omit-passage", id: passage.id, label: passage.key, acknowledged: true }))).current;
    assert.deepEqual(resolveAudioArrangement(acknowledged, script).issues, []);
    assert.deepEqual(resolveAudioArrangement(state(), script).issues, []);
  });
  it("moves linked material after a longer take while keeping fixed cues stationary", () => {
    const current = state(), snapshot = JSON.stringify(current);
    const diff = audioReplacementDiff(current, script, "first", source("longer", 7));
    assert.equal(JSON.stringify(current), snapshot, "preparing never changes Current");
    assert.deepEqual(diff.changes.map(entry => [entry.id, entry.from, entry.to, entry.afterSamples]), [
      ["first", 0, 0, audioSamples(7)], ["second", audioSamples(5), audioSamples(7), audioSamples(3)], ["door", audioSamples(5), audioSamples(7), audioSamples(1)],
    ]);
    assert.deepEqual(diff.fixed, ["fixed"]);
    assert.deepEqual(resolveAudioArrangement(diff.suggested, script).issues, []);
  });

  it("resets exact-source trims explicitly and leaves attachment and level intact", () => {
    const current = state(), clip = current.clips[0]!;
    clip.sourceIn = audioSamples(1); clip.sourceOut = audioSamples(4); clip.gainDb = -4;
    const diff = audioReplacementDiff(current, script, "first", source("replacement", 2));
    assert.equal(diff.trimsReset, true);
    assert.equal(diff.suggested.clips[0]!.sourceIn, 0);
    assert.equal(diff.suggested.clips[0]!.sourceOut, audioSamples(2));
    assert.equal(diff.suggested.clips[0]!.gainDb, -4);
    assert.deepEqual(diff.suggested.clips[0]!.placement, clip.placement);
  });

  it("preserves a 250 ms cast overlap and ducks under the union of both voices", () => {
    const changed = change(state(), [{ kind: "set-clip", id: "second", changes: { placement: { kind: "sequence", offset: -audioSamples(.25) } } }]).current;
    const bed = { ...newAudioClip("bed", "sounds", source("music", 2), audioSamples(2)), role: "music" as const, loop: true, duckDb: 10,
      placement: { kind: "range" as const, from: { passageId: "one", edge: "start" as const, offset: 0 }, to: { passageId: "two", edge: "end" as const, offset: 0 } } };
    changed.clips.push(bed);
    const plan = resolveAudioArrangement(changed, script), voices = plan.clips.filter(entry => entry.clip.role === "speech");
    assert.equal(voices[1]!.at, audioSamples(4.75));
    const music = plan.clips.find(entry => entry.clip.id === "bed")!;
    assert.equal(music.samples, audioSamples(7.75));
    assert.equal(audioClipGain(music, audioSamples(4.9), voices), 10 ** (-10 / 20));
  });

  it("keeps muted tracks authored while clip roles remain independent of track names", () => {
    const held = change(state(), [{ kind: "set-track", id: "voices", changes: { name: "Effects", muted: true, gainDb: -6 } }]);
    const plan = resolveAudioArrangement(held.current, script), first = plan.clips[0]!;
    assert.equal(first.clip.role, "speech"); assert.equal(first.muted, true); assert.equal(first.gainDb, -6);
    assert.equal(audioClipGain(first, audioSamples(1), []), 0);
  });

  it("reports a missing source instead of substituting a newer selected take", () => {
    const current = state(), plan = resolveAudioArrangement(current, script, new Set(["artifacts/first.wav"]));
    assert.deepEqual(plan.issues.map(issue => issue.kind), ["source"]);
    assert.equal(plan.clips[0]!.clip.source!.hash, source("first").hash);
  });

  it("rejects cyclic cue dependencies and invalid source windows", () => {
    assert.throws(() => change(state(), [
      { kind: "set-clip", id: "first", changes: { placement: { kind: "passage", anchor: { passageId: "two", edge: "end", offset: 0 } } } },
      { kind: "set-clip", id: "second", changes: { placement: { kind: "passage", anchor: { passageId: "one", edge: "end", offset: 0 } } } },
    ]), /cycle/);
    assert.throws(() => change(state(), [{ kind: "set-clip", id: "first", changes: { sourceOut: audioSamples(100) } }]), /trim/);
    assert.throws(() => change(state(), [{ kind: "set-clip", id: "first", changes: { trackId: "missing" } }]), /track/);
  });
});

describe("durable arrangement edits", () => {
  it("applies a batch once and preserves monotonic undo/redo after reopening", () => {
    const current = initialAudioArrangement(state(), '{"timing":{"legacy":true}}');
    const moved = editAudioArrangement(current, { kind: "commands", label: "Move and level", commands: [
      { kind: "set-clip", id: "door", changes: { gainDb: -4 } }, { kind: "set-clip", id: "door", changes: { placement: { kind: "fixed", at: audioSamples(9) } } },
    ] });
    const reopened = AudioArrangementSchema.parse(JSON.parse(JSON.stringify(moved)));
    assert.equal(reopened.undo.length, 1); assert.equal(reopened.revision, 2);
    const undone = editAudioArrangement(reopened, { kind: "undo" });
    assert.deepEqual(undone.current, current.current); assert.equal(undone.revision, 3); assert.equal(undone.schemaVersion, 1);
    const redone = editAudioArrangement(undone, { kind: "redo" });
    assert.deepEqual(redone.current, moved.current); assert.equal(redone.revision, 4); assert.equal(redone.legacy, current.legacy);
  });

  it("rolls back the whole batch when a later edit is refused", () => {
    const current = initialAudioArrangement(state(), "{}"), before = JSON.stringify(current);
    assert.throws(() => editAudioArrangement(current, { kind: "commands", label: "Invalid", commands: [
      { kind: "set-clip", id: "door", changes: { gainDb: -5 } }, { kind: "remove-track", id: "voices" },
    ] }), /track's clips/);
    assert.equal(JSON.stringify(current), before);
  });

  it("splits a range bed at a linked boundary while retaining its original ending", () => {
    const current = state(), bed = { ...newAudioClip("bed", "sounds", source("bed", 2), audioSamples(2)), loop: true,
      placement: { kind: "range" as const, from: { passageId: "one", edge: "start" as const, offset: 0 }, to: { passageId: "two", edge: "end" as const, offset: 0 } } };
    current.clips.push(bed);
    const split = change(current, [{ kind: "split-clip", id: "bed", nextId: "bed-tail", at: audioSamples(3) }]);
    const plan = resolveAudioArrangement(split.current, script), left = plan.clips.find(entry => entry.clip.id === "bed")!, right = plan.clips.find(entry => entry.clip.id === "bed-tail")!;
    assert.equal(left.samples, audioSamples(3)); assert.equal(right.at, audioSamples(3)); assert.equal(right.samples, audioSamples(5));
    assert.equal(right.clip.loopOffset, audioSamples(3)); assert.deepEqual(right.clip.source, left.clip.source);
    assert.deepEqual(right.clip.placement.kind === "range" && right.clip.placement.to, bed.placement.to);
  });
  it("splits at an exact sample without losing source or passage identity", () => {
    const split = change(state(), [{ kind: "split-clip", id: "first", nextId: "first-right", at: 12001 }]);
    const plan = resolveAudioArrangement(split.current, script), left = plan.clips.find(entry => entry.clip.id === "first")!, right = plan.clips.find(entry => entry.clip.id === "first-right")!;
    assert.equal(left.samples, 12001); assert.equal(right.at, 12001);
    assert.equal(right.clip.sourceIn, left.clip.sourceOut); assert.equal(left.samples + right.samples, audioSamples(5));
    assert.equal(right.clip.passageId, left.clip.passageId); assert.deepEqual(right.clip.source, left.clip.source);
    assert.equal(plan.clips.find(entry => entry.clip.id === "second")!.at, audioSamples(5));
  });

  it("marks repeated speech without moving the ordinary reading sequence", () => {
    const duplicate = change(state(), [{ kind: "duplicate-clip", id: "first", nextId: "repeat", at: audioSamples(20) }]);
    const plan = resolveAudioArrangement(duplicate.current, script);
    assert.equal(duplicate.current.clips.at(-1)!.repeated, true);
    assert.equal(plan.clips.find(entry => entry.clip.id === "second")!.at, audioSamples(5));
    assert.equal(plan.samples, audioSamples(25));
  });

  it("requires an explicit omission acknowledgement without removing prose or media", () => {
    const removed = change(state(), [{ kind: "remove-clip", id: "first" }]);
    assert.equal(removed.current.passages.length, 2);
    assert.ok(resolveAudioArrangement(removed.current, script).issues.some(issue => issue.kind === "omission"));
    const acknowledged = editAudioArrangement(removed, { kind: "commands", label: "Acknowledge", commands: [{ kind: "acknowledge-omission", id: "first", acknowledged: true }] });
    assert.deepEqual(resolveAudioArrangement(acknowledged.current, script).issues, []);
    assert.deepEqual(editAudioArrangement(editAudioArrangement(acknowledged, { kind: "undo" }), { kind: "undo" }).current, state());
  });

  it("clears an omission only after the author has restored an audible primary performance", () => {
    const current = state(), original = current.clips[0]!;
    const removed = change(current, [{ kind: "remove-clip", id: original.id }]).current;
    assert.throws(() => change(removed, [{ kind: "clear-omission", id: original.id }]), /audible performance/);
    const restored = change(removed, [{ kind: "add-clip", clip: original }, { kind: "clear-omission", id: original.id }]).current;
    assert.deepEqual(restored.omissions, []); assert.deepEqual(resolveAudioArrangement(restored, script).issues, []);
  });
  it("requires a distinct protection release and retains the rest of the clip", () => {
    const held = change(state(), [{ kind: "protect-clip", id: "first", protected: true }]);
    assert.throws(() => editAudioArrangement(held, { kind: "commands", label: "Move", commands: [{ kind: "set-clip", id: "first", changes: { gainDb: -3 } }] }), /protection/);
    const released = editAudioArrangement(held, { kind: "commands", label: "Release", commands: [{ kind: "protect-clip", id: "first", protected: false }] });
    assert.deepEqual(released.current, state());
  });

  it("bounds history, drops redo on a branch and keeps a no-op revision unchanged", () => {
    let held = initialAudioArrangement(state(), "{}");
    assert.equal(editAudioArrangement(held, { kind: "commands", label: "No-op", commands: [{ kind: "set-clip", id: "first", changes: { gainDb: 0 } }] }), held);
    for (let i = 0; i < 30; i++) held = editAudioArrangement(held, { kind: "commands", label: "Level", commands: [{ kind: "set-clip", id: "first", changes: { gainDb: -i } }] });
    assert.equal(held.undo.length, AUDIO_STUDIO_HISTORY);
    held = editAudioArrangement(held, { kind: "undo" });
    held = editAudioArrangement(held, { kind: "commands", label: "New branch", commands: [{ kind: "set-clip", id: "first", changes: { gainDb: -35 } }] });
    assert.equal(held.redo.length, 0);
  });
});

describe("conservative passage identity", () => {
  it("follows unique unchanged passages when insertion changes their paragraph keys", () => {
    const edited = { hash: "manuscript-2", passages: [{ key: "p0.0", textHash: "inserted" }, { key: "p1.0", textHash: "first" }, { key: "p2.0", textHash: "second" }] };
    const bound = bindAudioPassages(state(), edited);
    assert.equal(bound.get("one")!.key, "p1.0"); assert.equal(bound.get("two")!.key, "p2.0");
    assert.ok(resolveAudioArrangement(state(), edited).issues.some(issue => issue.id === "p0.0"));
  });

  it("does not guess among repeated text after a manuscript change", () => {
    const held = state(); held.passages[1]!.textHash = "first";
    const old = { hash: script.hash, passages: [{ key: "p0.0", textHash: "first" }, { key: "p1.0", textHash: "first" }] };
    assert.equal(bindAudioPassages(held, old).size, 2);
    assert.equal(bindAudioPassages(held, { ...old, hash: "changed" }).size, 0);
    const repaired = change(held, [{ kind: "bind-passage", id: "one", key: "p1.0", textHash: "first", scriptHash: "changed" }]).current;
    const bindings = bindAudioPassages(repaired, { ...old, hash: "changed" });
    assert.equal(bindings.size, 1); assert.equal(bindings.get("one")!.key, "p1.0");
  });

  it("keeps changed, split and deleted text unresolved rather than rebinding by position", () => {
    for (const passages of [[{ key: "p0.0", textHash: "changed" }], [], [{ key: "p0.0", textHash: "half" }, { key: "p0.1", textHash: "other half" }]]) {
      const plan = resolveAudioArrangement(state(), { hash: "edited", passages });
      assert.ok(plan.issues.some(issue => issue.kind === "passage" && issue.id === "one"));
      assert.equal(plan.clips.some(entry => entry.clip.id === "first"), false);
    }
  });
});

describe("legacy arrangement derivation", () => {
  it("preserves speech placement, trims, overlapping reactions, beds and effect tails without mutating input", () => {
    const blocks = [{ key: "p0.0", text: "First", lane: "narration", take: { artifactId: "first", file: "artifacts/first.wav", seconds: 5 } },
      { key: "p1.0", text: "Second", lane: "Mara", take: { artifactId: "second", file: "artifacts/second.wav", seconds: 3 } }];
    const anchor = (index: number) => ({ key: blocks[index]!.key, textHash: audiobookTimingHash(blocks[index]!.text) });
    const record = { timing: { "p1.0": { textHash: anchor(1).textHash, start: -.25, by: "author" as const, at: "2026-10-15T10:00:00Z" } },
      beds: { b1: { from: anchor(0), to: anchor(1), source: { file: "artifacts/music.wav", label: "Music", origin: "world" as const, seconds: 2 }, levelDb: -14, fadeInSec: 2, fadeOutSec: 4, duckDb: 10, by: "author" as const, at: "2026-10-15T10:00:00Z" } },
      sounds: { s1: { block: anchor(1), source: { file: "artifacts/door.wav", label: "Door", origin: "world" as const, seconds: 8 }, levelDb: -6, by: "author" as const, at: "2026-10-15T10:00:00Z" } } };
    const timing = timeChapter({ blocks, record, reading: "cast", unmade: "skip" }), before = JSON.stringify(timing);
    const script = { hash: "legacy", passages: blocks.map(block => ({ key: block.key, textHash: audiobookTimingHash(block.text) })) };
    const sources = [source("first"), source("second", 3), source("music", 2), source("door", 8)];
    const migrated = migrateAudioArrangement(script, timing, new Map(sources.map(entry => [entry.file, entry])));
    const resolved = resolveAudioArrangement(migrated, script);
    assert.deepEqual(resolved.issues, []); assert.equal(JSON.stringify(timing), before);
    for (const bar of timing.bars) {
      const placed = resolved.passages.find(passage => passage.key === bar.key)!;
      assert.equal(placed.at, audioSamples(bar.at)); assert.equal(placed.samples, audioSamples(bar.seconds));
    }
    assert.equal(resolved.samples, audioSamples(timing.bars[1]!.at + 8), "effect tails remain audible");
    assert.equal(resolved.clips.find(entry => entry.clip.role === "music")!.samples, audioSamples(timing.beds[0]!.seconds));
  });

  it("refuses unresolved legacy cues and missing source metadata instead of committing a partial migration", () => {
    const timing = timeChapter({ blocks: [{ key: "p0.0", text: "First", lane: "narration", take: { artifactId: "first", file: "artifacts/first.wav", seconds: 5 } }], record: {}, reading: "narrator", unmade: "skip" });
    assert.throws(() => migrateAudioArrangement(script, timing, new Map()), /Restore/);
    timing.lost.sounds.push("s1");
    assert.throws(() => migrateAudioArrangement(script, timing, new Map()), /unresolved timing/);
  });

  it("opens a take whose timed length is rounded past its file, and refuses one further out (issue 1827)", () => {
    // Juju chapter 1, block p61: timed at 41.92 s, decoded to 2,012,142 samples (41.9196 s).
    const timed = (seconds: number) => timeChapter({ blocks: [{ key: "p0.0", text: "First", lane: "narration", take: { artifactId: "first", file: "artifacts/first.wav", seconds } }], record: {}, reading: "narrator", unmade: "skip" });
    const file = { ...source("first"), samples: 2_012_142 };
    const one = { hash: "legacy", passages: [{ key: "p0.0", textHash: audiobookTimingHash("First") }] };
    const migrated = migrateAudioArrangement(one, timed(41.92), new Map([[file.file, file]]));
    assert.equal(migrated.clips[0]!.sourceOut, file.samples, "the rounding is the file's end");
    assert.deepEqual(resolveAudioArrangement(migrated, one).issues, []);
    assert.throws(() => migrateAudioArrangement(one, timed(41.922), new Map([[file.file, file]])), /The trim is outside this exact source/, "a real disagreement is still refused");
  });

  it("a take cut to its file's end does not move the passages after it (codex on PR 1832)", () => {
    const blocks = [
      { key: "p0.0", text: "First", lane: "narration" as const, take: { artifactId: "first", file: "artifacts/first.wav", seconds: 41.92 } },
      { key: "p1.0", text: "Second", lane: "narration" as const, take: { artifactId: "second", file: "artifacts/second.wav", seconds: 3 } },
      { key: "p2.0", text: "Third", lane: "narration" as const, take: { artifactId: "third", file: "artifacts/third.wav", seconds: 2 } },
    ];
    const timing = timeChapter({ blocks, record: {}, reading: "narrator", unmade: "skip" });
    const script = { hash: "legacy", passages: blocks.map(block => ({ key: block.key, textHash: audiobookTimingHash(block.text) })) };
    const sources = [{ ...source("first"), samples: 2_012_142 }, source("second", 3), source("third", 2)];
    const resolved = resolveAudioArrangement(migrateAudioArrangement(script, timing, new Map(sources.map(entry => [entry.file, entry]))), script);
    assert.deepEqual(resolved.issues, []);
    for (const bar of timing.bars) {
      const placed = resolved.passages.find(passage => passage.key === bar.key)!;
      assert.equal(placed.at, audioSamples(bar.at), `${bar.key} starts where the timing put it`);
    }
  });

  it("rejects unsafe paths, unsupported schemas and fractional sample positions", () => {
    const current = state(); current.clips[0]!.source!.file = "../private.wav";
    assert.throws(() => validateAudioArrangement(current), /audio must belong/);
    assert.equal(AudioArrangementSchema.safeParse({ ...initialAudioArrangement(state(), "{}"), schemaVersion: 2 }).success, false);
    current.clips[0]!.source!.file = "artifacts/first.wav"; current.clips[0]!.sourceIn = .5;
    assert.throws(() => validateAudioArrangement(current));
  });
});
