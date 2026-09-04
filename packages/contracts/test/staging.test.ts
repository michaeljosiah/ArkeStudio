import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClientMessageSchema,
  effectiveStageBlocking,
  ShotSchema,
  ShotStagingSchema,
  MAX_STAGE_WALK_SPEED_MPS,
  STAGE_FRAME_RATE,
  stageShot,
  stageWalkSpeed,
  stageFrameCount,
  stagePlayblastIsStale,
  stagingBeats,
  stagingFov,
  stagingMoveWord,
  stagingPromptClause,
  stagingRetimed,
  type Shot,
  type ResolvedShotStaging,
  type ShotStaging,
} from "../src/index.js";

const shot = (extra: Partial<Shot>): Shot => ({
  id: "sh_12",
  number: 12,
  title: "Maren at the rail",
  description: "@maren-kest grips the rail of @the-vigil.",
  durationSec: 4,
  ...extra,
});

describe("the Stage's arithmetic", () => {
  it("stages a shot deterministically from its cast, sets and framing words", () => {
    const first = stageShot(shot({ camera: "MCU · slow push-in" }), { cast: ["maren-kest"], sets: ["The Vigil"], durationSec: 4 });
    const again = stageShot(shot({ camera: "MCU · slow push-in" }), { cast: ["maren-kest"], sets: ["The Vigil"], durationSec: 4 });
    assert.deepEqual(first, again, "the same shot stages the same way twice");
    assert.equal(first.version, 1);
    assert.deepEqual(first.cast, [{ sheetId: "maren-kest", x: -1.5, z: 0 }]);
    assert.equal(first.sets[0]?.name, "The Vigil");
    assert.equal(first.keys.length, 2);
    assert.equal(first.keys[0]?.anchor, "maren-kest");
    assert.equal(first.keys[0]?.track, "maren-kest");
    assert.equal(first.keys[1]?.t, 4);
    assert.ok(first.keys[1]!.p[2] < first.keys[0]!.p[2], "a push-in ends closer");
    assert.ok(ShotStagingSchema.safeParse(first).success, "what staging writes is what the schema reads");
    assert.ok(ShotSchema.safeParse({ ...shot({}), staging: first }).success);
  });

  it("blocks explicit cast performance from the shot text", () => {
    const staged = stageShot(shot({
      description: "@maren-kest sits at the counter while @ivo-rell walks across the hall.",
    }), { cast: ["maren-kest", "ivo-rell"], sets: ["Hall"], durationSec: 4 });
    assert.equal(staged.cast[0]?.pose, "sit");
    assert.equal(staged.cast[0]?.to, undefined);
    assert.equal(staged.cast[1]?.pose, undefined);
    assert.ok(staged.cast[1]?.to);
    assert.ok((stageWalkSpeed(staged.cast[1]!, 4) ?? Infinity) <= MAX_STAGE_WALK_SPEED_MPS);
    assert.ok(ShotStagingSchema.safeParse(staged).success);
    assert.equal(ShotStagingSchema.safeParse({
      ...staged,
      cast: [{ sheetId: "maren-kest", x: 0, z: 0, pose: "sit", to: [1, 0] }],
    }).success, false, "a static posture cannot also claim a walk");
    assert.match(stagingPromptClause(staged, (id) => id === "maren-kest" ? "Maren" : "Ivo", 4), /Ivo walks through the shot\. Maren is seated\./);
  });

  it("reads the move off the framing: static holds, orbit sweeps, crane rises, and a castless shot stays in the world", () => {
    const still = stageShot(shot({ framing: { size: "Wide", movement: "Static" } }), { cast: [], sets: [], durationSec: 6 });
    assert.equal(still.keys[0]?.anchor, undefined);
    assert.equal(stagingMoveWord(still.keys), "static");
    const orbit = stageShot(shot({ framing: { movement: "Slow orbit" } }), { cast: ["maren-kest"], sets: [], durationSec: 8 });
    assert.equal(orbit.keys.length, 3);
    assert.equal(stagingMoveWord(orbit.keys), "orbit");
    const crane = stageShot(shot({ framing: { movement: "Crane up" } }), { cast: ["maren-kest"], sets: [], durationSec: 5 });
    assert.equal(stagingMoveWord(crane.keys), "crane");
    const truck = stageShot(shot({ framing: { movement: "Tracking" } }), { cast: ["maren-kest"], sets: [], durationSec: 5 });
    assert.equal(stagingMoveWord(truck.keys), "truck");
  });

  it("derives an unclamped lens cone from a Super 35 gate cropped to the production aspect", () => {
    const rounded = (lens: string, aspect: string) => Math.round(stagingFov(lens, aspect) * 10) / 10;
    assert.deepEqual([24, 35, 50, 85, 135].map((mm) => rounded(`${mm}mm`, "16:9")), [32.5, 22.6, 15.9, 9.4, 5.9]);
    assert.deepEqual([24, 35, 50, 85, 135].map((mm) => rounded(`${mm}mm`, "9:16")), [42.5, 29.9, 21.1, 12.5, 7.9]);
    assert.equal(stagingFov(undefined, "16:9"), 34);
    assert.ok(stagingFov("1mm", "16:9") > 160, "a valid extreme lens is not clamped");
  });

  it("plans a fixed-rate, half-open playblast timeline", () => {
    assert.equal(STAGE_FRAME_RATE, 30);
    assert.equal(stageFrameCount(4), 120);
    assert.equal(stageFrameCount(1 / 60), 1);
    assert.equal(stageFrameCount(1.01), 31);
    assert.equal((stageFrameCount(4) - 1) / STAGE_FRAME_RATE, 119 / 30);
  });

  it("writes the move as timed beats in metres, with bearings from the subject's own facing", () => {
    const staging = {
      version: 1,
      cast: [{ sheetId: "maren-kest", x: 0, z: 5.5, to: [0, -6.5] as [number, number] }],
      sets: [],
      keys: [
        { t: 0, p: [0, 1.55, 3] as [number, number, number], l: [0, 1.25, 0] as [number, number, number], anchor: "maren-kest", track: "maren-kest" },
        { t: 5, p: [-2.55, 1.5, 0.2] as [number, number, number], l: [0, 1.25, 0] as [number, number, number], anchor: "maren-kest", track: "maren-kest" },
        { t: 10, p: [0.2, 4.4, 0.5] as [number, number, number], l: [0, 1.25, 0] as [number, number, number], anchor: "maren-kest", track: "maren-kest" },
        { t: 15, p: [0, 1.45, -2.9] as [number, number, number], l: [0, 1.25, 0] as [number, number, number], anchor: "maren-kest", track: "maren-kest" },
      ],
    };
    const beats = stagingBeats(staging, (id) => (id === "maren-kest" ? "Maren" : id), 15);
    assert.equal(beats.length, 4);
    // She walks toward -Z, so +Z is behind her and -X is her left.
    assert.match(beats[0]!, /^0\.0s — 3\.0m behind Maren, 1\.55m high, aimed at Maren$/);
    assert.match(beats[1]!, /to the left of Maren/);
    assert.match(beats[2]!, /above Maren/);
    assert.match(beats[3]!, /in front of Maren/);
    const clause = stagingPromptClause(staging, (id) => (id === "maren-kest" ? "Maren" : id), 15);
    assert.match(clause, /^Camera move, orbit, blocked out on the stage \(4 keys\)\. Maren walks through the shot\./);
    assert.ok(clause.includes(beats[3]!));
  });

  it("measures a tracked key from where the figure stands, not from the aim point the track overrides", () => {
    // Camera at z=3 looking at the origin, but tracking Maren who stands 5m off to the side and
    // walks nowhere: the distance is to her, and she is to the camera's side, not in front.
    const staging: ResolvedShotStaging = {
      version: 1,
      cast: [{ sheetId: "maren-kest", x: 5, z: 0 }],
      sets: [],
      keys: [
        { t: 0, p: [0, 1.5, 3], l: [0, 1.2, 0], track: "maren-kest" },
        { t: 4, p: [0, 1.5, 3], l: [0, 1.2, 0] },
      ],
    };
    const [tracked, free] = stagingBeats(staging, () => "Maren", 4);
    assert.match(tracked!, /^0.0s — 5.8m /, "the beat is measured to the figure the key tracks");
    assert.match(tracked!, /Maren, 1.50m high, aimed at Maren$/);
    assert.match(free!, /^4.0s — 3.0m in front of the aim point/, "an untracked key still measures to its aim point");
    // A walker is read where the key's time puts them along the path.
    const walking: ResolvedShotStaging = { ...staging, cast: [{ sheetId: "maren-kest", x: 0, z: 0, to: [0, -8] }] };
    const mid = stagingBeats({ ...walking, keys: [{ t: 2, p: [0, 1.5, 0], l: [0, 1.2, 0], track: "maren-kest" }, { t: 4, p: [0, 1.5, 0], l: [0, 1.2, 0] }] }, () => "Maren", 4);
    assert.match(mid[0]!, /^2.0s — 4.0m /, "halfway through a four-second shot she is 4m down an 8m walk");
  });

  it("reads a camera riding a walking figure as tracking, not static", () => {
    const keys = [
      { t: 0, p: [0, 1.5, 2] as [number, number, number], l: [0, 1.2, 0] as [number, number, number], anchor: "maren-kest", track: "maren-kest" },
      { t: 4, p: [0, 1.5, 2] as [number, number, number], l: [0, 1.2, 0] as [number, number, number], anchor: "maren-kest", track: "maren-kest" },
    ];
    assert.equal(stagingMoveWord(keys, [{ sheetId: "maren-kest", x: 0, z: 0, to: [0, -6] }]), "tracking");
    assert.equal(stagingMoveWord(keys, [{ sheetId: "maren-kest", x: 0, z: 0 }]), "static", "the same offset from a figure who holds is a static camera");
    assert.equal(stagingMoveWord(keys), "static", "without the cast the word is what the keys alone say");
  });

  it("warns instead of calling an implausible path a walk", () => {
    const figure = { sheetId: "maren-kest", x: 0, z: 0, to: [20, 0] as [number, number] };
    assert.equal(stageWalkSpeed(figure, 3), 20 / 3);
    assert.equal(stageWalkSpeed({ ...figure, to: [4.4, 0] }, 2), MAX_STAGE_WALK_SPEED_MPS, "the ceiling is still a walk");
    const staging: ResolvedShotStaging = {
      version: 1,
      cast: [figure],
      sets: [],
      keys: [
        { t: 0, p: [0, 1.5, 3], l: [0, 1, 0], track: "maren-kest" },
        { t: 10, p: [0, 1.5, 3], l: [0, 1, 0], track: "maren-kest" },
      ],
    };
    const beats = stagingBeats(staging, () => "Maren", 3);
    assert.match(beats[0]!, /Maren · 20\.0m in 3\.0s · 6\.67m\/s · too fast for a walk/);
    const clause = stagingPromptClause(staging, () => "Maren", 3);
    assert.doesNotMatch(clause, /Maren walks through the shot/);
    assert.match(clause, /Blocking warning/);
    assert.doesNotMatch(clause, /10\.0s/, "camera beats use the actual shot duration too");
    const limit = { ...staging, cast: [{ ...figure, to: [4.4, 0] as [number, number] }] };
    assert.doesNotMatch(stagingPromptClause(limit, () => "Maren", 2), /Blocking warning/);
    const over = { ...staging, cast: [{ ...figure, to: [4.42, 0] as [number, number] }] };
    assert.match(stagingPromptClause(over, () => "Maren", 2), /2\.21m\/s · too fast/);
    const barelyOver = { ...staging, cast: [{ ...figure, to: [6.61, 0] as [number, number] }] };
    assert.match(stagingPromptClause(barelyOver, () => "Maren", 3), /2\.21m\/s · too fast/);
  });

  it("holds a staging to the shot's length: the end key moves to the duration and interior keys keep ahead of it", () => {
    const staging: ShotStaging = {
      version: 1,
      cast: [],
      sets: [],
      keys: [{ t: 0, p: [0, 1.5, 4], l: [0, 1, 0] }, { t: 2, p: [0, 1.5, 2], l: [0, 1, 0] }, { t: 8, p: [0, 1.5, -2], l: [0, 1, 0] }],
    };
    assert.deepEqual(stagingRetimed(staging, 4).keys.map((key) => key.t), [0, 2, 4], "the end key is the end pose");
    assert.deepEqual(stagingRetimed(staging, 1).keys.map((key) => key.t), [0, 0.25, 1], "a move that no longer fits is scaled, so no two keys share a moment");
    const eight: ShotStaging = { ...staging, keys: Array.from({ length: 8 }, (_, index) => ({ t: index, p: [0, 1.5, 4 - index] as [number, number, number], l: [0, 1, 0] as [number, number, number] })) };
    const times = stagingRetimed(eight, 0.5).keys.map((key) => key.t);
    assert.ok(times.every((t, index) => index === 0 || t > times[index - 1]!), `eight keys into half a second stay strictly ordered: ${times.join(",")}`);
    const dense: ShotStaging = { ...staging, keys: [0, 1, 2, 100].map((t) => ({ t, p: [0, 1.5, 4 - t / 25] as [number, number, number], l: [0, 1, 0] as [number, number, number] })) };
    assert.deepEqual(stagingRetimed(dense, 0.5).keys.map((key) => key.t), [0, 0.01, 0.02, 0.5], "rounding never lands two keys on one moment");
    assert.deepEqual(stagingRetimed(dense, 0.02).keys.map((key) => key.t), [0, 0.01, 0.02], "a key with no moment left before the end folds into it");
    assert.equal(stagingRetimed(staging, 8), staging, "nothing to move returns the same staging");
    assert.equal(stagingRetimed({ ...staging, keys: [] }, 4).keys.length, 0);
  });

  it("keeps the schema a read path: a staging with one key or no keys still parses", () => {
    assert.ok(ShotStagingSchema.safeParse({ version: 1, cast: [], sets: [], keys: [] }).success);
    assert.ok(ShotStagingSchema.safeParse({ version: 1, keys: [] }).success, "a camera may inherit scene blocking");
    assert.equal(ShotStagingSchema.safeParse({ version: 1, cast: [], keys: [] }).success, false, "an override is whole");
    assert.ok(ShotStagingSchema.safeParse({ version: 3, cast: [], sets: [], keys: [{ t: 0, p: [0, 1, 2], l: [0, 1, 0] }], playblast: { artifactId: "ar_01J8G0000000000000000000A1", version: 2 } }).success);
    assert.ok(ShotStagingSchema.safeParse({ version: 3, cast: [], sets: [], keys: [{ t: 0, p: [0, 1, 2], l: [0, 1, 0] }], playblast: { artifactId: "ar_01J8G0000000000000000000A1", openingFrameArtifactId: "ar_01J8G0000000000000000000A2", version: 3 } }).success);
    assert.equal(ShotStagingSchema.safeParse({ version: 0, cast: [], sets: [], keys: [] }).success, false);
  });

  it("resolves shared blocking without changing legacy shot overrides", () => {
    const scene = { blocking: { version: 3, cast: [{ sheetId: "shared", x: 1, z: 2 }], sets: [] } };
    const inherited = { version: 1, keys: [] };
    const local = { version: 2, cast: [] as [], sets: [] as [], keys: [] };
    assert.deepEqual(effectiveStageBlocking(scene, inherited).identity, { owner: "scene", version: 3 });
    assert.deepEqual(effectiveStageBlocking(scene, inherited).cast.map((figure) => figure.sheetId), ["shared"]);
    assert.deepEqual(effectiveStageBlocking(scene, local), { cast: [], sets: [], identity: { owner: "shot" } });
  });

  it("makes inherited playblasts stale when shared blocking moves", () => {
    const pin = {
      artifactId: "ar_01J8G0000000000000000000A1",
      version: 1,
      blocking: { owner: "scene" as const, version: 2 },
    };
    const staging = { version: 1, keys: [], playblast: pin };
    const shown = { durationSec: 4, aspect: "16:9", lens: undefined };
    assert.equal(stagePlayblastIsStale({ blocking: { version: 2, cast: [], sets: [] } }, staging, shown), false);
    assert.equal(stagePlayblastIsStale({ blocking: { version: 3, cast: [], sets: [] } }, staging, shown), true);
    const legacyLocal = { ...staging, cast: [], sets: [], playblast: { artifactId: pin.artifactId, version: 1 } };
    assert.equal(stagePlayblastIsStale({ blocking: { version: 9, cast: [], sets: [] } }, legacyLocal, shown), false);
  });

  it("keeps Stage authorship on the edit-stage wire command", () => {
    const message = {
      kind: "scene-command",
      worldId: "01J8G0000000000000000000W1",
      productionId: "saltlight",
      sceneFile: "04-the-verse-rises",
      sceneId: "sc_04",
      baseVersion: 2,
      command: { kind: "edit-stage", shotId: "sh_12", staging: { keys: [] } },
    };
    assert.ok(ClientMessageSchema.safeParse(message).success);
    assert.ok(ClientMessageSchema.safeParse({ ...message, command: { kind: "edit-stage", shotId: "sh_12", staging: null } }).success);
    assert.equal(ClientMessageSchema.safeParse({
      ...message,
      command: { kind: "edit-stage", shotId: "sh_12", staging: { version: 1, keys: [] } },
    }).success, false, "the coordinator, not the caller, owns camera versions");
    assert.equal(ClientMessageSchema.safeParse({
      ...message,
      command: { kind: "edit-shot", shotId: "sh_12", change: { staging: { version: 1, keys: [] } } },
    }).success, false);
  });

  it("requires both files in a Stage export", () => {
    const message = {
      kind: "stage-playblast",
      worldId: "01J8G0000000000000000000W1",
      productionId: "saltlight",
      sceneFile: "04-the-verse-rises",
      sceneId: "sc_04",
      baseVersion: 2,
      shotId: "sh_12",
      stagingVersion: 1,
      durationSec: 4,
      aspect: "16:9",
      sourcePath: "C:/spool/playblast.mp4",
      openingFrameSourcePath: "C:/spool/opening-frame.png",
    };
    assert.deepEqual(ClientMessageSchema.parse(message), message);
    const { openingFrameSourcePath: _openingFrameSourcePath, ...withoutFrame } = message;
    assert.equal(ClientMessageSchema.safeParse(withoutFrame).success, false);
  });
});
