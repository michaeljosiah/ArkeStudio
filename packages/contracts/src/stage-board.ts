import { orderedShots, type SceneRecord } from "./scene-flow.js";
import { DEFAULT_SHOT_SEC, effectiveFraming, type Shot } from "./scene.js";
import { resolvedShotStaging, stageFigureAt, stageLineCrossings, stageSourceFingerprintInput, stagingRetimed, STAGE_CAMERA_EVALUATOR_VERSION, type ResolvedShotStaging, type StageLineFinding } from "./staging.js";
import { stageBasePose } from "./stage-pose.js";
import { stagingFollowLine, stagingPromptClause, type StageFollow } from "./stage-prompt.js";

/**
 * A board on the Stage (issue 1824, design turn 228g): its shots cut together on one clock over
 * the scene's shared action, each with its own camera. The cut list, the line check across the
 * cuts, the animatic's pin and staleness, and the board's lines for the video model all read the
 * same member list, in the board's order.
 */

export interface StageBoardCut {
  shotId: string;
  number: number;
  title: string;
  /** Seconds on the board's clock. */
  from: number;
  to: number;
}

/** The board's cuts on its own clock, in member order; a member no longer in the scene is skipped. */
export function stageBoardCuts(scene: SceneRecord, members: readonly string[]): StageBoardCut[] {
  const shots = orderedShots(scene);
  const cuts: StageBoardCut[] = [];
  let clock = 0;
  for (const id of members) {
    const shot = shots.find((candidate) => candidate.id === id);
    if (!shot) continue;
    const length = shot.durationSec ?? DEFAULT_SHOT_SEC;
    cuts.push({ shotId: shot.id, number: shot.number, title: shot.title, from: clock, to: clock + length });
    clock += length;
  }
  return cuts;
}

/** The cut a moment on the board's clock falls in, and the time within that shot. */
export function stageBoardAt(cuts: readonly StageBoardCut[], at: number): { cut: StageBoardCut; local: number; index: number } | null {
  if (cuts.length === 0) return null;
  const index = Math.max(0, cuts.findIndex((cut, i) => at < cut.to || i === cuts.length - 1));
  const cut = cuts[index]!;
  return { cut, local: Math.min(cut.to - cut.from, Math.max(0, at - cut.from)), index };
}

/**
 * What the animatic was rendered from — every member's own fingerprint input, the aspect and the
 * evaluator — as the text the coordinator hashes for the pin. Contracts runs in the browser too,
 * so the hash is taken where node:crypto is.
 */
export function stageBoardFingerprintInput(scene: SceneRecord, members: readonly string[], aspect: string): string {
  const shots = orderedShots(scene);
  const inputs = members.map((id) => {
    const shot = shots.find((candidate) => candidate.id === id);
    return shot === undefined ? `missing:${id}` : stageSourceFingerprintInput(scene, shot, aspect);
  });
  return JSON.stringify([STAGE_CAMERA_EVALUATOR_VERSION, aspect, inputs]);
}

/** Each member's staging as it stands: what an animatic pin records and is checked against. */
export function stageBoardStagings(scene: SceneRecord, members: readonly string[]): Array<{ shotId: string; version: number; durationSec: number; lens: string }> | null {
  const shots = orderedShots(scene);
  const out: Array<{ shotId: string; version: number; durationSec: number; lens: string }> = [];
  for (const id of members) {
    const shot = shots.find((candidate) => candidate.id === id);
    if (!shot?.staging) return null;
    out.push({ shotId: id, version: shot.staging.version, durationSec: shot.durationSec ?? DEFAULT_SHOT_SEC, lens: effectiveFraming(scene, shot).lens ?? "" });
  }
  return out;
}

export type StageBoardAnimatic = NonNullable<NonNullable<SceneRecord["boards"]>["animatics"]>[number];
const sameMembers = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/** The board's filed animatic, if any. */
export function stageBoardAnimatic(scene: SceneRecord, members: readonly string[]): StageBoardAnimatic | null {
  return scene.boards?.animatics?.find((pin) => sameMembers(pin.members, members)) ?? null;
}

/** Whether the filed animatic still shows this board: same members, staging, lengths, lenses and aspect. */
export function stageBoardAnimaticIsStale(scene: SceneRecord, pin: StageBoardAnimatic, aspect: string): boolean {
  if (pin.aspect !== aspect || pin.evaluatorVersion !== STAGE_CAMERA_EVALUATOR_VERSION) return true;
  const now = stageBoardStagings(scene, pin.members);
  return now === null || JSON.stringify(now) !== JSON.stringify(pin.stagings);
}

/** 180° crossings between consecutive members of the board, named by shot pair. */
export function stageBoardLineFindings(scene: SceneRecord, members: readonly string[], aspect: string): StageLineFinding[] {
  const pairs = new Set(members.slice(1).map((id, index) => `${members[index]}|${id}`));
  return stageLineCrossings(scene, aspect).filter((finding) => {
    const [a, b] = finding.shotIds;
    return a !== undefined && b !== undefined && (pairs.has(`${a}|${b}`) || pairs.has(`${b}|${a}`));
  });
}

/** A figure that is somewhere else, or in another posture, on either side of a cut. */
export interface StageBoardJump {
  sheetId: string;
  /** The shot the cut goes to. */
  shotId: string;
  number: number;
  /** Seconds on the board's clock. */
  at: number;
  distance: number;
  posture: boolean;
}

/**
 * Continuity across the board's cuts when its action is shared: where each figure ends one shot
 * against where it starts the next. Coverage of one action cuts on the same moment, so a figure
 * that moves more than a stride, or changes between standing, sitting and lying, has jumped.
 */
export function stageBoardJumps(scene: SceneRecord, members: readonly string[], tolerance = 0.3): StageBoardJump[] {
  const shots = orderedShots(scene);
  const cuts = stageBoardCuts(scene, members);
  const jumps: StageBoardJump[] = [];
  const staged = (id: string): { staging: ResolvedShotStaging; length: number } | null => {
    const shot = shots.find((candidate) => candidate.id === id);
    if (!shot?.staging) return null;
    const length = shot.durationSec ?? DEFAULT_SHOT_SEC;
    return { staging: stagingRetimed(resolvedShotStaging(scene, shot.staging), length) as ResolvedShotStaging, length };
  };
  for (let index = 1; index < cuts.length; index += 1) {
    const before = staged(cuts[index - 1]!.shotId);
    const after = staged(cuts[index]!.shotId);
    if (before === null || after === null) continue;
    for (const figure of after.staging.cast) {
      const earlier = before.staging.cast.find((candidate) => candidate.sheetId === figure.sheetId);
      if (earlier === undefined) continue;
      const end = stageFigureAt(earlier, before.staging.performances, before.length, before.length, before.staging.objectMotions);
      const start = stageFigureAt(figure, after.staging.performances, 0, after.length, after.staging.objectMotions);
      const distance = Math.hypot(end.x - start.x, end.z - start.z);
      const posture = stageBasePose(end.pose) !== stageBasePose(start.pose);
      if (distance > tolerance || posture) jumps.push({ sheetId: figure.sheetId, shotId: cuts[index]!.shotId, number: cuts[index]!.number, at: cuts[index]!.from, distance, posture });
    }
  }
  return jumps;
}

/**
 * The board's lines for a video model: each staged member's camera and action on the board's
 * clock, then — when the animatic rides — one follow line for the whole board.
 */
export function stagingBoardClause(
  scene: SceneRecord,
  members: readonly string[],
  nameOf: (sheetId: string) => string,
  aspect: string,
  options: { video?: string; follow?: StageFollow } = {},
): string {
  const shots = orderedShots(scene);
  const parts: string[] = [];
  for (const cut of stageBoardCuts(scene, members)) {
    const shot = shots.find((candidate) => candidate.id === cut.shotId) as Shot;
    if (!shot.staging) continue;
    const lens = effectiveFraming(scene, shot).lens;
    parts.push(stagingPromptClause(resolvedShotStaging(scene, shot.staging), nameOf, cut.to - cut.from, { aspect, ...(lens === undefined ? {} : { lens }), offset: cut.from }));
  }
  // The shot's own follow line, so the Bench's Follow choice rewrites a board's as it does a shot's.
  if (options.video !== undefined && parts.length > 0) parts.push(stagingFollowLine(options.video, options.follow ?? "camera-action"));
  return parts.join("\n");
}
