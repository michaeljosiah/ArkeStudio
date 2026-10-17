import { stageFigureAt, stagePerformanceDeparture, type ResolvedShotStaging } from "./staging.js";
import { stageObjectAt } from "./stage-camera.js";
import type { StageContact, StagePerformanceKey, StagePose } from "./scene.js";

/**
 * Poses, contacts and turns (issue 1821, design turn 228d). A figure holds a named pose at a
 * mark; a hand can be put on someone or something, and the jointed figure's arm reaches it; a
 * head can look at someone. These are the parts every renderer and the prompt read the same way.
 */

export const STAGE_POSE_LABELS: Record<StagePose, string> = {
  stand: "Stand", sit: "Sit", lie: "Lie", "lean-on": "Lean on", reach: "Reach", point: "Point", wipe: "Wipe",
  crouch: "Crouch", stumble: "Stumble", fall: "Fall", "arms-crossed": "Arms crossed", phone: "Phone to ear",
  carry: "Carry", "hands-on-hips": "Hands on hips",
};

/** The capsule posture a named pose falls back to in Greybox, where figures are not jointed. */
export function stageBasePose(pose: StagePose): "stand" | "sit" | "lie" {
  return pose === "sit" || pose === "crouch" ? "sit" : pose === "lie" || pose === "fall" ? "lie" : "stand";
}

/** How tall a figure stands in frame in a pose, as a fraction of its height. */
export function stagePoseHeight(pose: StagePose): number {
  return pose === "sit" ? .72 : pose === "crouch" ? .6 : pose === "lie" || pose === "fall" ? .3 : pose === "lean-on" ? .88 : 1;
}

/** A pose as the prompt says it: "leans on Ade", "points at the lifts". */
export function stagePoseVerb(pose: StagePose, target: string | null): string {
  const on = target === null ? "" : target;
  switch (pose) {
    case "stand": return "stands";
    case "sit": return "sits";
    case "lie": return "lies down";
    case "lean-on": return target === null ? "leans" : `leans on ${on}`;
    case "reach": return target === null ? "reaches out" : `reaches for ${on}`;
    case "point": return target === null ? "points" : `points at ${on}`;
    case "wipe": return target === null ? "wipes down a surface" : `wipes down ${on}`;
    case "crouch": return "crouches";
    case "stumble": return "stumbles";
    case "fall": return "falls";
    case "arms-crossed": return "stands with arms crossed";
    case "phone": return "holds a phone to the ear";
    case "carry": return "carries something";
    case "hands-on-hips": return "stands, hands on hips";
  }
}

/** The mark whose pose, hand and look hold at a moment: the latest one reached. */
export function stageMarkAt(staging: ResolvedShotStaging, sheetId: string, at: number): StagePerformanceKey | null {
  const keys = staging.performances?.find((track) => track.sheetId === sheetId)?.keys;
  if (!keys?.length) return null;
  let index = 0;
  while (index < keys.length - 1 && keys[index + 1]!.t <= at) index++;
  return keys[index]!.t <= at ? keys[index]! : null;
}

/**
 * Where a named thing is for a hand or a look at a moment: a figure's part (shoulder, head, hand,
 * waist) from its posed height and facing, or a set's top, nearest the figure reaching for it.
 */
export function stagePlaceOf(staging: ResolvedShotStaging, name: string, part: StageContact["part"], from: { x: number; z: number }, at: number, durationSec: number): [number, number, number] | null {
  const figure = staging.cast.find((candidate) => candidate.sheetId === name);
  if (figure) {
    const state = stageFigureAt(figure, staging.performances, at, durationSec, staging.objectMotions);
    const height = (figure.height ?? 1.8) * stagePoseHeight(state.pose);
    const facing = state.facing * Math.PI / 180;
    // The figure's own left, as the bearing words use it.
    const left = [Math.cos(facing), -Math.sin(facing)] as const;
    const side = part === "right shoulder" ? -1 : part === "left shoulder" ? 1 : 0;
    const y = part === "head" ? height * .93 : part === "hand" ? height * .45 : part === "waist" ? height * .55 : height * .82;
    return [state.x + left[0] * .2 * side, state.y + y, state.z + left[1] * .2 * side];
  }
  const set = staging.sets.find((candidate) => candidate.name === name);
  if (!set) return null;
  const origin = set.group ? stageObjectAt(staging.objectMotions, set.group, at).p : [0, 0, 0];
  const x = Math.min(origin[0]! + set.x + set.w / 2, Math.max(origin[0]! + set.x - set.w / 2, from.x));
  const z = Math.min(origin[2]! + set.z + set.d / 2, Math.max(origin[2]! + set.z - set.d / 2, from.z));
  return [x, origin[1]! + (set.y ?? 0) + set.h, z];
}

/** Where a figure's hand goes at a moment, if a mark puts it on someone or something. */
export function stageContactAt(staging: ResolvedShotStaging, sheetId: string, at: number, durationSec: number): { side: StageContact["side"]; point: [number, number, number] } | null {
  const mark = stageMarkAt(staging, sheetId, at);
  if (!mark?.hand) return null;
  const figure = staging.cast.find((candidate) => candidate.sheetId === sheetId);
  if (!figure) return null;
  const state = stageFigureAt(figure, staging.performances, at, durationSec, staging.objectMotions);
  const point = stagePlaceOf(staging, mark.hand.on, mark.hand.part, state, at, durationSec);
  return point === null ? null : { side: mark.hand.side, point };
}

/** Where a figure looks at a moment, if a mark says. */
export function stageLookAt(staging: ResolvedShotStaging, sheetId: string, at: number, durationSec: number): [number, number, number] | null {
  const mark = stageMarkAt(staging, sheetId, at);
  if (!mark?.look) return null;
  const figure = staging.cast.find((candidate) => candidate.sheetId === sheetId);
  if (!figure) return null;
  const state = stageFigureAt(figure, staging.performances, at, durationSec, staging.objectMotions);
  return stagePlaceOf(staging, mark.look, "head", state, at, durationSec);
}

/** Degrees per second past which a turn reads as a spin, not a turn. */
export const STAGE_TURN_LIMIT_DPS = 180;

export interface StageTurn { sheetId: string; from: number; to: number; degrees: number; rate: number }

/** Every turn between marks faster than a person turns. */
export function stageFastTurns(staging: ResolvedShotStaging): StageTurn[] {
  const turns: StageTurn[] = [];
  for (const track of staging.performances ?? []) {
    for (let index = 0; index < track.keys.length - 1; index++) {
      const a = track.keys[index]!, b = track.keys[index + 1]!;
      if (a.facing === undefined || b.facing === undefined) continue;
      const degrees = Math.abs(((b.facing - a.facing + 540) % 360) - 180);
      const from = stagePerformanceDeparture(a, b);
      const span = b.t - from;
      const rate = span <= 0 ? Number.POSITIVE_INFINITY : degrees / span;
      if (degrees >= 10 && rate > STAGE_TURN_LIMIT_DPS) turns.push({ sheetId: track.sheetId, from, to: b.t, degrees, rate });
    }
  }
  return turns;
}

export function stageTurnWarnings(staging: ResolvedShotStaging, nameOf: (sheetId: string) => string): string[] {
  return stageFastTurns(staging).map((turn) => `Turning warning — ${nameOf(turn.sheetId)} · ${Math.round(turn.degrees)}° in ${(turn.to - turn.from).toFixed(1)}s · ${Math.round(turn.rate)}°/s · too fast to read (${turn.from.toFixed(2)}–${turn.to.toFixed(2)}s); add time`);
}
