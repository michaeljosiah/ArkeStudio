import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cutChecks, cutChecksCount, ProductionBundleSchema, ProductionTimelineSchema, TakeSchema,
  type CutCheck, type ProductionBundle, type ProductionTimeline,
} from "../src/index.js";

/*
 * The checks on a cut (design turns 287 and 288d), read from the saved timeline alone. Each is a
 * fault Gold on Gold was shown with on 2026-11-26: a line over another shot's face, a room tone
 * looped so its laugh came round, two shots from one camera position that read as a zoom.
 */

const AT = "2026-11-26T00:00:00Z", RATE = 30;
const still = (position: number) => ({ version: 1, keys: [{ t: 0, p: [0, 1.5, 3], l: [0, 1.5, 0] }, { t: 4, p: [0, 1.5, 3], l: [0, 1.5, 0] }], position });

type ShotOver = { position?: number; continuity?: Record<string, unknown> };
function production(shots: ShotOver[], over: Record<string, unknown> = {}): ProductionBundle {
  return ProductionBundleSchema.parse({
    meta: { id: "film", title: "Film", format: "video", status: "in-progress", created: AT, updated: AT, failureModes: [], frameRate: RATE, ...(over["look"] ? { look: over["look"] } : {}) },
    story: null, treatment: null, chapters: [],
    scenes: [{ id: "sc_one", slug: "one", status: "draft", number: 1, title: "One", version: 1,
      blocking: { version: 1, cast: [], sets: [] },
      shots: shots.map((shot, i) => ({ id: `sh_${i + 1}`, number: i + 1, title: "Shot", description: "A shot.", durationSec: 4,
        ...(shot.position === undefined ? {} : { staging: still(shot.position) }),
        ...(shot.continuity ? { continuity: shot.continuity } : {}) })) }],
    takes: over["takes"] ?? [], reviews: [], selections: over["selections"] ?? {},
    ...(over["spine"] ? { spine: over["spine"] } : {}),
  });
}

type Clip = Record<string, unknown>;
const shotClip = (n: number, start: number, frames = 120): Clip => ({ id: `cl_shot${n}`, startFrame: start, durationFrames: frames,
  source: { kind: "shot", shotId: `sh_${n}`, sceneNumber: 1, shotNumber: n, label: `SC 1 · SH ${n}` } });
const file = (id: string, artifactId: string, start: number, frames: number, sourceIn = 0, role?: string): Clip => ({ id, startFrame: start, durationFrames: frames, sourceInFrames: sourceIn,
  source: { kind: "artifact", artifactId, label: `${artifactId.slice(-4)}.wav` }, ...(role ? { role } : {}) });
function timeline(picture: Clip[], tracks: Array<{ kind: string; clips: Clip[] }> = []): ProductionTimeline {
  return ProductionTimelineSchema.parse({ schemaVersion: 1, revision: 1, frameRate: RATE, history: { undo: [], redo: [] },
    tracks: [{ id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: picture },
      ...tracks.map((track, i) => ({ id: `tr_${track.kind}${i}`, kind: track.kind, name: track.kind, order: i + 1, muted: false, clips: track.clips }))] });
}
const AR = (n: number) => `ar_01M8CVTCHECK00000000000${String(n).padStart(3, "0")}`;
const item = (items: CutCheck[], id: string) => items.find((candidate) => candidate.id === id);
const three = [shotClip(1, 0), shotClip(2, 120), shotClip(3, 240)];

describe("the checks on a cut: lines", () => {
  const p = production([{}, {}, {}]);
  const artifacts = [{ id: AR(1), links: ["film", "sh_1"] }, { id: AR(2), links: ["film", "sh_2"] }, { id: AR(3), links: ["film"] }];
  const line = (id: string, artifactId: string, start: number, frames = 60) => file(id, artifactId, start, frames);

  it("passes lines that sit under their own shots, and one that runs over the next is a split cut", () => {
    const cut = timeline(three, [{ kind: "dialogue", clips: [line("cl_l1", AR(1), 10), line("cl_l2", AR(2), 100, 80)] }]);
    assert.deepEqual(item(cutChecks({ production: p, timeline: cut, artifacts }), "lines"), { id: "lines", result: "pass", says: "2 under their shots" });
  });

  it("names a line lying wholly under another shot's picture: how a film was shown with a line over the wrong face", () => {
    const cut = timeline(three, [{ kind: "dialogue", clips: [line("cl_l1", AR(1), 10), line("cl_l2", AR(2), 250)] }]);
    assert.deepEqual(item(cutChecks({ production: p, timeline: cut, artifacts }), "lines"),
      { id: "lines", result: "fix", says: "shot 2's under shot 3", clipIds: ["cl_l2"] });
  });

  it("says when a line is tied to no shot, and holds a film cut straight to its shots", () => {
    const untied = timeline(three, [{ kind: "dialogue", clips: [line("cl_l3", AR(3), 10)] }]);
    assert.deepEqual(item(cutChecks({ production: p, timeline: untied, artifacts }), "lines"), { id: "lines", result: "fix", says: "1 tied to no shot", clipIds: ["cl_l3"] });
    const straight = production([{}, {}, {}], { look: { cutting: { splitCuts: false } } });
    const over = timeline(three, [{ kind: "dialogue", clips: [line("cl_l2", AR(2), 200, 80)] }]);
    assert.equal(item(cutChecks({ production: straight, timeline: over, artifacts }), "lines")?.says, "shot 2's runs past its shot");
    assert.equal(item(cutChecks({ production: p, timeline: over, artifacts }), "lines")?.result, "pass", "a split cut is a choice unless the look says otherwise");
  });

  it("leaves the item out when the cut lays no lines, and reads nothing of a cut with no story shot in it", () => {
    assert.equal(item(cutChecks({ production: p, timeline: timeline(three), artifacts }), "lines"), undefined);
    const reel = timeline([{ id: "cl_a", startFrame: 0, durationFrames: 90, source: { kind: "artifact", artifactId: AR(3), label: "reel.mp4" } }],
      [{ kind: "dialogue", clips: [line("cl_l1", AR(1), 10)] }]);
    assert.deepEqual(cutChecks({ production: p, timeline: reel, artifacts }), []);
  });
});

describe("the checks on a cut: room tone", () => {
  const p = production([{}, {}, {}]);
  const room = (id: string, artifactId: string, start: number, frames: number, sourceIn = 0) => file(id, artifactId, start, frames, sourceIn, "ambience");

  it("passes one room under the whole scene, made of pieces used once", () => {
    const cut = timeline(three, [{ kind: "ambience", clips: [room("cl_r1", AR(1), 0, 200), room("cl_r2", AR(2), 200, 160)] }]);
    assert.deepEqual(item(cutChecks({ production: p, timeline: cut }), "room"), { id: "room", result: "pass", says: "no gap, none repeated" });
  });

  it("finds a room looped under the scene: the same six seconds, and the same laugh, again and again", () => {
    const loop = Array.from({ length: 2 }, (_, i) => room(`cl_r${i}`, AR(1), i * 180, 180));
    assert.deepEqual(item(cutChecks({ production: p, timeline: timeline(three, [{ kind: "ambience", clips: loop }]) }), "room"),
      { id: "room", result: "fix", says: "0001.wav used 2 times", clipIds: ["cl_r1"] });
    // One clip split in two plays each stretch once.
    const split = timeline(three, [{ kind: "ambience", clips: [room("cl_ra", AR(1), 0, 180), room("cl_rb", AR(1), 180, 180, 180)] }]);
    assert.equal(item(cutChecks({ production: p, timeline: split }), "room")?.result, "pass");
  });

  it("finds the room dropping out under the scene, and a bed drawn longer than its file runs", () => {
    const hole = timeline(three, [{ kind: "ambience", clips: [room("cl_r1", AR(1), 0, 150), room("cl_r2", AR(2), 195, 165)] }]);
    assert.deepEqual(item(cutChecks({ production: p, timeline: hole }), "room"), { id: "room", result: "fix", says: "gap at 0:05 · 1.5 s" });
    // Drawn for twelve seconds, the file runs eight.
    const short = timeline(three, [{ kind: "ambience", clips: [room("cl_r1", AR(1), 0, 360)] }]);
    assert.equal(item(cutChecks({ production: p, timeline: short, artifacts: [{ id: AR(1), links: [], mediaInfo: { durationSec: 8 } }] }), "room")?.says, "gap at 0:08 · 4.0 s");
    const quiet = production([{}, {}, {}], { look: { sound: { roomTonePerPlace: false } } });
    assert.equal(item(cutChecks({ production: quiet, timeline: hole }), "room")?.result, "pass", "a look with no room a place is not held to one");
  });

  it("leaves the item out when the cut has no room at all", () => {
    assert.equal(item(cutChecks({ production: p, timeline: timeline(three, [{ kind: "music", clips: [file("cl_m", AR(1), 0, 360)] }]) }), "room"), undefined);
  });
});

describe("the checks on a cut: set-ups", () => {
  it("names two shots in a row from one camera position, which read as a jump or a zoom", () => {
    const p = production([{ position: 2 }, { position: 2 }, { position: 3 }]);
    assert.deepEqual(item(cutChecks({ production: p, timeline: timeline(three) }), "set-ups"), { id: "set-ups", result: "fix", says: "shots 1, 2", clipIds: ["cl_shot2"] });
    const apart = production([{ position: 2 }, { position: 3 }, { position: 2 }]);
    assert.deepEqual(item(cutChecks({ production: apart, timeline: timeline(three) }), "set-ups"), { id: "set-ups", result: "pass", says: "none twice running" });
    // In the cut's order, not the story's: shot 3 cut in between them breaks the pair.
    const reordered = timeline([shotClip(1, 0), shotClip(3, 120), shotClip(2, 240)]);
    assert.equal(item(cutChecks({ production: p, timeline: reordered }), "set-ups")?.result, "pass");
  });

  it("says nothing of a shot written to carry on from the one before, of one clip played straight on, or of a film cut to a song", () => {
    const carried = production([{ position: 2 }, { position: 2, continuity: { continuesPrevious: true } }, { position: 3 }]);
    assert.equal(item(cutChecks({ production: carried, timeline: timeline(three) }), "set-ups")?.result, "pass");
    // Two segments of one pass, cut where the first ends: no cut between them to jump.
    const base = { kind: "clip", provider: "test", model: "test", provenance: { canonRevision: 1, sheets: {}, sceneId: "sc_one", sceneVersion: 1 }, cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 }, dispatchedAt: AT };
    const pass = TakeSchema.parse({ ...base, id: "tk_01M8CVTCHECK00000000000001", coversShots: ["sh_1", "sh_2"], media: "pass.mp4" });
    const first = TakeSchema.parse({ ...base, id: "tk_01M8CVTCHECK00000000000002", coversShots: ["sh_1"], segment: { passTakeId: pass.id, inSec: 0, outSec: 4 } });
    const second = TakeSchema.parse({ ...base, id: "tk_01M8CVTCHECK00000000000003", coversShots: ["sh_2"], segment: { passTakeId: pass.id, inSec: 4, outSec: 8 } });
    const board = production([{ position: 2 }, { position: 2 }, { position: 3 }], { takes: [pass, first, second],
      selections: { sh_1: { acceptedTakeId: first.id, trimInSec: 0 }, sh_2: { acceptedTakeId: second.id, trimInSec: 0 } } });
    assert.equal(item(cutChecks({ production: board, timeline: timeline(three) }), "set-ups")?.result, "pass");
    // Trimmed, the same two segments have a cut between them.
    assert.equal(item(cutChecks({ production: board, timeline: timeline([shotClip(1, 0, 90), shotClip(2, 90), shotClip(3, 210)]) }), "set-ups")?.result, "fix");
    const video = production([{ position: 2 }, { position: 2 }], { look: { preset: "music-video" } });
    assert.equal(item(cutChecks({ production: video, timeline: timeline(three.slice(0, 2)) }), "set-ups"), undefined);
  });

  it("leaves the item out when no shot was staged from a position", () => {
    assert.equal(item(cutChecks({ production: production([{}, {}, {}]), timeline: timeline(three) }), "set-ups"), undefined);
  });
});

describe("the checks on a cut: the count", () => {
  it("counts what passed and what is to fix, and reads an unreadable cut as nothing rather than throwing", () => {
    const items: CutCheck[] = [{ id: "lines", result: "pass", says: "2 under their shots" }, { id: "room", result: "fix", says: "gap at 0:05 · 1.5 s" }];
    assert.deepEqual(cutChecksCount(items), { passed: 1, of: 2, toFix: 1 });
    assert.deepEqual(cutChecksCount([]), { passed: 0, of: 0, toFix: 0 });
    assert.deepEqual(cutChecks({ production: production([{}]), timeline: { tracks: null } as unknown as ProductionTimeline }), []);
  });
});
