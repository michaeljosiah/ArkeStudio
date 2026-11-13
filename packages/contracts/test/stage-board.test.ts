import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SceneSchema,
  STAGE_CAMERA_EVALUATOR_VERSION,
  STAGE_FRAME_RATE,
  stageBoardAnimatic,
  stageBoardAnimaticIsStale,
  stageBoardAt,
  stageBoardCuts,
  stageBoardFingerprintInput,
  stageBoardJumps,
  stageBoardLineFindings,
  stageBoardStagings,
  stageFrameCount,
  stagingBoardClause,
  stagingFollowLine,
} from "../src/index.js";

// Design turn 229g's board, cut down: a wide, Ade, then Ife from the lifts, all over one action.
function board() {
  return SceneSchema.parse({
    id: "sc_lobby", number: 1, slug: "lobby", title: "Lobby", status: "draft", version: 6,
    blocking: { version: 1, cast: [{ sheetId: "ade", x: -1, z: 0 }, { sheetId: "ife", x: 1, z: 0 }], sets: [] },
    shots: [
      { id: "sh_1", number: 1, title: "Wide", description: "Wide", durationSec: 2, framing: { lens: "18 mm" } },
      { id: "sh_2", number: 2, title: "Ade", description: "Ade", durationSec: 4 },
      { id: "sh_3", number: 3, title: "Ife", description: "Ife", durationSec: 4 },
    ].map((shot) => ({
      ...shot,
      staging: { version: 1, keys: [{ t: 0, p: [0, 1.5, 4], l: [0, 1, 0] }, { t: shot.durationSec, p: [0, 1.5, 4], l: [0, 1, 0] }] },
    })),
  });
}
const members = ["sh_1", "sh_2", "sh_3"];
const nameOf = (id: string) => ({ ade: "Ade", ife: "Ife" })[id] ?? id;

describe("a board on the Stage (issue 1824)", () => {
  it("cuts its members on one clock, in board order, to whole frames", () => {
    const cuts = stageBoardCuts(board(), members);
    assert.deepEqual(cuts.map((cut) => [cut.number, cut.from, cut.to]), [[1, 0, 2], [2, 2, 6], [3, 6, 10]]);
    const here = stageBoardAt(cuts, 6.4)!;
    assert.equal(here.cut.shotId, "sh_3");
    assert.ok(Math.abs(here.local - 0.4) < 1e-9);
    assert.equal(stageBoardAt(cuts, 10)!.index, 2, "the end of the board is the last cut's end");
    // Every cut's length is a whole number of frames, so the animatic's cuts land on the boundaries.
    let frame = 0;
    for (const cut of cuts) {
      assert.equal(frame, Math.round(cut.from * STAGE_FRAME_RATE));
      frame += stageFrameCount(cut.to - cut.from);
    }
  });

  it("reads its filed animatic as stale when any member moves, or the aspect does", () => {
    const scene = board();
    const stagings = stageBoardStagings(scene, members)!;
    assert.deepEqual(stagings.map((entry) => [entry.shotId, entry.version, entry.durationSec, entry.lens]), [["sh_1", 1, 2, "18 mm"], ["sh_2", 1, 4, ""], ["sh_3", 1, 4, ""]]);
    const pin = { members, artifactId: "ar_01HZZZZZZZZZZZZZZZZZZZZZZZ", sourceFingerprint: "a".repeat(64), stagings, blockingVersion: scene.blocking!.version, evaluatorVersion: STAGE_CAMERA_EVALUATOR_VERSION, durationSec: 10, aspect: "9:16" };
    scene.boards = { splits: [], merges: [], animatics: [pin] };
    assert.equal(stageBoardAnimatic(scene, members), pin);
    assert.equal(stageBoardAnimatic(scene, ["sh_1", "sh_2"]), null, "keyed by the exact members");
    assert.equal(stageBoardAnimaticIsStale(scene, pin, "9:16"), false);
    assert.equal(stageBoardAnimaticIsStale(scene, pin, "16:9"), true);
    // A light, the plate, the atmosphere or a set moved on the scene's blocking leaves every shot's
    // staging as it was, and still changes what the animatic shows.
    scene.blocking!.version += 1;
    assert.equal(stageBoardAnimaticIsStale(scene, pin, "9:16"), true, "a shared blocking edit marks it stale");
    scene.blocking!.version -= 1;
    const before = stageBoardFingerprintInput(scene, members, "9:16");
    scene.shots[1]!.staging!.version = 2;
    assert.equal(stageBoardAnimaticIsStale(scene, pin, "9:16"), true, "a shot edit marks the board's animatic stale");
    scene.shots[1]!.staging!.version = 1;
    scene.shots[2]!.durationSec = 5;
    assert.equal(stageBoardAnimaticIsStale(scene, pin, "9:16"), true, "and so does a retime");
    assert.notEqual(stageBoardFingerprintInput(scene, members, "9:16"), before);
    delete scene.shots[2]!.staging;
    assert.equal(stageBoardStagings(scene, members), null, "an unstaged member stages no board");
  });

  it("reports a deliberate crossing between consecutive cuts, by shot pair", () => {
    const scene = board();
    assert.deepEqual(stageBoardLineFindings(scene, members, "16:9"), []);
    // Shot 3's camera goes round to the far side of Ade and Ife: the cut from 2 to 3 jumps the line.
    for (const key of scene.shots[2]!.staging!.keys) key.p = [0, 1.5, -4];
    const findings = stageBoardLineFindings(scene, members, "16:9");
    assert.ok(findings.length > 0);
    assert.ok(findings.every((finding) => finding.shotIds.includes("sh_3")));
    assert.deepEqual(stageBoardLineFindings(scene, ["sh_1", "sh_2"], "16:9"), [], "a pair outside the board is not its finding");
  });

  it("finds a figure somewhere else across a cut when the action is shared", () => {
    const scene = board();
    assert.deepEqual(stageBoardJumps(scene, members), []);
    scene.shots[0]!.staging!.performances = [{ sheetId: "ife", keys: [{ t: 0, x: 1, z: 0 }, { t: 2, x: 3, z: 0 }] }];
    const jumps = stageBoardJumps(scene, members);
    assert.equal(jumps.length, 1);
    assert.deepEqual([jumps[0]!.sheetId, jumps[0]!.number, jumps[0]!.at, jumps[0]!.posture], ["ife", 2, 2, false]);
    assert.ok(Math.abs(jumps[0]!.distance - 2) < 1e-6);
    scene.shots[1]!.staging!.performances = [{ sheetId: "ife", keys: [{ t: 0, x: 3, z: 0, pose: "sit" }] }];
    const posture = stageBoardJumps(scene, members);
    assert.equal(posture.length, 2, "she sits at the cut to 2, and stands again at the cut to 3");
    assert.ok(posture.every((jump) => jump.posture));
  });

  it("puts a later cut's warnings on the board's clock with its lines", () => {
    const scene = board();
    // Ife covers 6 m in the third cut's first second: too fast for a walk.
    scene.shots[2]!.staging!.performances = [{ sheetId: "ife", keys: [{ t: 0, x: 1, z: 0 }, { t: 1, x: 7, z: 0 }, { t: 4, x: 7, z: 0 }] }];
    const clause = stagingBoardClause(scene, members, nameOf, "9:16");
    assert.match(clause, /Blocking warning — Ife .*\(6\.00–7\.00s\)/, "the third cut starts at 6.0 s on the board");
    assert.doesNotMatch(clause, /\(0\.00–1\.00s\)/);
  });

  it("writes the board as one timed cut list, with the shot's own follow line when the animatic rides", () => {
    const scene = board();
    const clause = stagingBoardClause(scene, members, nameOf, "9:16");
    assert.match(clause, /^0\.0–2\.0 s · /m);
    assert.match(clause, /^2\.0–6\.0 s · /m);
    assert.match(clause, /^6\.0–10\.0 s · /m);
    assert.doesNotMatch(clause, /@Video/);
    const riding = stagingBoardClause(scene, members, nameOf, "9:16", { video: "Video 1", follow: "camera" });
    assert.equal(riding.split("\n").at(-1), stagingFollowLine("Video 1", "camera"));
  });
});
