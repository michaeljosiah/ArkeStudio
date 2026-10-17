import { STAGE_CAMERA_NEAR, STAGE_FRAMED_HEIGHT, stageFigureAt, stagingFov, type ResolvedShotStaging } from "./staging.js";
import type { StageFrameWords, StagePose, StagingKey } from "./scene.js";
import { stagePoseHeight } from "./stage-pose.js";

/**
 * The camera in words (issue 1820, design turn 228a): who the frame is on, how big, from what
 * angle and which side, through which lens. The model and the person both direct; this module does
 * the trigonometry — distance from the framed height through the same cropped Super 35 gate the
 * viewport uses, height from the angle, side from the subject's own facing — so a key written as
 * words lands where the words say at any lens, and resolves again when the lens or the shot's
 * length changes. The resolved position is still stored on the key; the words ride beside it.
 */

export const STAGE_FRAME_SIZE_LABELS: ReadonlyArray<[StageFrameWords["size"], string]> = [["wide", "Wide"], ["medium", "Med"], ["medium close-up", "MCU"], ["close-up", "CU"]];
export const STAGE_FRAME_ANGLE_LABELS: ReadonlyArray<[StageFrameWords["angle"], string]> = [["eye", "Eye"], ["low", "Low"], ["high", "High"], ["top", "Top"]];
export const STAGE_FRAME_SIDE_LABELS: ReadonlyArray<[StageFrameWords["side"], string]> = [["front", "Front"], ["behind", "Behind"], ["left", "Left"], ["right", "Right"], ["over", "Over the shoulder"]];

/** How tall a figure stands in frame in a pose: the size word judges what the lens sees. */
function posedHeight(height: number, pose: StagePose): number {
  return height * stagePoseHeight(pose);
}

/**
 * The key the words describe at time `t`: anchored to the subject and tracking it, so a framing
 * written once holds while the subject moves. Over the shoulder stands behind the other figure
 * instead, in world space, because it is about two people. Null when the subject is not on stage.
 */
export function stageFrameKey(
  staging: ResolvedShotStaging,
  words: StageFrameWords,
  t: number,
  durationSec: number,
  aspect: string,
  shotLens: string | undefined,
): StagingKey | null {
  const figure = staging.cast.find((candidate) => candidate.sheetId === words.subject);
  if (!figure) return null;
  const state = stageFigureAt(figure, staging.performances, t, durationSec, staging.objectMotions);
  const height = figure.height ?? 1.8;
  const framed = posedHeight(height, state.pose);
  const lens = words.focalMm === undefined ? shotLens : `${words.focalMm}mm`;
  const fov = stagingFov(lens, words.aspect ?? aspect) * Math.PI / 180;
  const distance = Math.max(framed * STAGE_FRAMED_HEIGHT[words.size] / (2 * Math.tan(fov / 2)), height / 4 + STAGE_CAMERA_NEAR);
  // Eyes sit at about 93% of a figure's posed height; wide frames aim lower to hold the body.
  const eye = framed * .93;
  const aim = words.size === "wide" || words.size === "extreme wide" ? framed * .55 : words.size === "medium" ? framed * .75 : eye;
  const facing = state.facing * Math.PI / 180;
  const forward: [number, number] = [Math.sin(facing), Math.cos(facing)];
  // The subject's own left: the bearing the prompt words use (stageBearing).
  const left: [number, number] = [forward[1], -forward[0]];
  const base = { t, ...(words.focalMm === undefined ? {} : { focalMm: words.focalMm }), frame: words };
  if (words.side === "over") {
    const other = staging.cast.find((candidate) => candidate.sheetId === words.over);
    if (!other) return null;
    const there = stageFigureAt(other, staging.performances, t, durationSec, staging.objectMotions);
    const towards = [state.x - there.x, state.z - there.z];
    const span = Math.hypot(towards[0]!, towards[1]!) || 1;
    const unit = [towards[0]! / span, towards[1]! / span];
    // Behind the near figure's right shoulder, a little above it, looking past it at the subject.
    const shoulder = posedHeight(other.height ?? 1.8, there.pose) * .85;
    const back = Math.max(.6, distance - span);
    return {
      ...base,
      p: [there.x - unit[0]! * back - unit[1]! * .35, there.y + shoulder + .1, there.z - unit[1]! * back + unit[0]! * .35],
      l: [0, aim, 0],
      track: words.subject,
    };
  }
  const direction = words.side === "front" ? forward : words.side === "behind" ? [-forward[0], -forward[1]] : words.side === "left" ? left : [-left[0], -left[1]];
  const rise = words.angle === "low" ? .6 - aim : words.angle === "high" ? 1 : words.angle === "top" ? distance * .9 : eye - aim;
  const flat = words.angle === "top" ? distance * .35 : words.angle === "high" ? Math.sqrt(Math.max(.01, distance * distance - 1)) : distance;
  return {
    ...base,
    p: [direction[0]! * flat, aim + rise, direction[1]! * flat],
    l: [0, aim, 0],
    anchor: words.subject,
    anchorSpace: "world",
    track: words.subject,
  };
}

/**
 * Every worded key resolved again — after a retime or a change of lens — keeping its time, ease,
 * roll and words. Keys without words are untouched; a key whose subject has left the stage keeps
 * its last position rather than vanishing.
 */
export function stageReframed(staging: ResolvedShotStaging, durationSec: number, aspect: string, shotLens: string | undefined): ResolvedShotStaging {
  if (!staging.keys.some((key) => key.frame !== undefined)) return staging;
  return {
    ...staging,
    keys: staging.keys.map((key) => {
      if (key.frame === undefined) return key;
      const resolved = stageFrameKey(staging, key.frame, key.t, durationSec, aspect, shotLens);
      if (resolved === null) return key;
      return {
        ...resolved,
        ...(key.easeIn === undefined ? {} : { easeIn: key.easeIn }),
        ...(key.easeOut === undefined ? {} : { easeOut: key.easeOut }),
        ...(key.roll === undefined ? {} : { roll: key.roll }),
      };
    }),
  };
}

/** Whether a key still is what its words say; a hand edit that moved it drops them. */
export function stageKeyMatchesWords(key: StagingKey, resolved: StagingKey | null): boolean {
  if (resolved === null) return false;
  const near = (a: readonly number[], b: readonly number[]) => a.every((value, index) => Math.abs(value - b[index]!) < .02);
  return near(key.p, resolved.p) && near(key.l, resolved.l) && key.anchor === resolved.anchor && key.track === resolved.track;
}
