import { sampleStageCamera, stageCameraKeyAt, stageObjectAt } from "./stage-camera.js";
import {
  MAX_STAGE_WALK_SPEED_MPS,
  STAGE_FRAMED_HEIGHT,
  STAGE_GAIT_SPEEDS,
  stageBearing,
  stageWalkSpeed,
  stageFigureAt,
  stagePerformanceDeparture,
  stageSpeedWarnings,
  stagingFov,
  stagingMotionWord,
  stagingRetimed,
  type ResolvedShotStaging,
} from "./staging.js";
import { parseAspect } from "./manifest.js";
import type { StagePose, StagingFigure } from "./scene.js";
import { stagePoseHeight, stagePoseVerb, stageTurnWarnings } from "./stage-pose.js";
import type { BenchReferenceToken } from "./bench.js";

/**
 * The blockout as a video model reads it: shot size, side and angle in a camera operator's
 * words, the action as timed lines named against the people and things on the set, and one
 * line saying how closely to follow the blockout video (issue 1817). World coordinates never
 * reach the prompt — a generator cannot use "(1.23, 1.50, −3.20) m", and the numbers it was
 * given used to crowd out the cut list it can use. The measured speed warnings stay, because
 * R-34 requires the prompt never to state a walk the blocking does not support.
 */

/** How closely the generator follows the blockout video. */
export const STAGE_FOLLOWS = ["camera-action", "camera"] as const;
export type StageFollow = (typeof STAGE_FOLLOWS)[number];
export const STAGE_FOLLOW_LABELS: Record<StageFollow, string> = { "camera-action": "Camera + action", camera: "Camera only" };

export type StageShotSize = keyof typeof STAGE_FRAMED_HEIGHT;
const SIZE_ORDER: readonly StageShotSize[] = ["extreme close-up", "close-up", "medium close-up", "medium", "wide", "extreme wide"];

/** The size word for a frame `framedHeight` tall on a subject `subjectHeight` tall: the nearest band of the first pass's table. */
export function stageShotSize(framedHeight: number, subjectHeight: number): StageShotSize {
  const fraction = framedHeight / Math.max(.1, subjectHeight);
  let best: StageShotSize = "medium";
  for (const size of SIZE_ORDER) if (Math.abs(Math.log(fraction / STAGE_FRAMED_HEIGHT[size])) < Math.abs(Math.log(fraction / STAGE_FRAMED_HEIGHT[best]))) best = size;
  return best;
}

export type StageCameraAngle = "eye level" | "low angle" | "high angle" | "overhead";
export interface StageCameraWords {
  size: StageShotSize;
  /** The figure the frame is on, by sheet; null when the lens looks at no one. */
  subject: string | null;
  /** Where the camera stands, from the subject's own facing ("in front of", "behind", …). */
  side: string | null;
  angle: StageCameraAngle;
}

/** A posed figure is shorter in frame than its sheet height; the size word must judge what the lens sees. */
function framedSubjectHeight(figure: StagingFigure, pose: StagePose): number {
  return (figure.height ?? 1.8) * stagePoseHeight(pose);
}

/** What the camera shows at one moment, in words. */
export function stageCameraWordsAt(staging: ResolvedShotStaging, at: number, durationSec: number, aspect: string, lens: string | undefined): StageCameraWords {
  const pose = sampleStageCamera(staging, at, durationSec);
  const keyed = staging.keys.find(k => k.track !== undefined)?.track ?? staging.keys.find(k => k.anchor !== undefined)?.anchor;
  const keyedFigure = keyed !== undefined && staging.cast.some(f => f.sheetId === keyed) ? keyed : undefined;
  // An unkeyed camera is on whoever stands nearest the line it looks along.
  const aim = [pose.l[0] - pose.p[0], pose.l[2] - pose.p[2]];
  const aimLength = Math.hypot(aim[0]!, aim[1]!) || 1;
  const nearest = keyedFigure ?? staging.cast
    .map(figure => {
      const state = stageFigureAt(figure, staging.performances, at, durationSec, staging.objectMotions);
      const along = ((state.x - pose.p[0]) * aim[0]! + (state.z - pose.p[2]) * aim[1]!) / aimLength;
      const across = Math.abs((state.x - pose.p[0]) * aim[1]! - (state.z - pose.p[2]) * aim[0]!) / aimLength;
      return { id: figure.sheetId, along, across };
    })
    .filter(c => c.along > 0 && c.across < 1.2)
    .sort((a, b) => a.across - b.across || a.along - b.along)[0]?.id;
  const ratio = parseAspect(aspect) ?? 16 / 9;
  const key = stageCameraKeyAt(staging, at, durationSec, stagingFov(lens, aspect), ratio);
  const fov = key.focalMm === undefined ? stagingFov(lens, aspect) : stagingFov(`${key.focalMm}mm`, aspect);
  const rise = pose.p[1] - pose.l[1];
  const flat = Math.hypot(pose.p[0] - pose.l[0], pose.p[2] - pose.l[2]);
  const pitch = Math.atan2(rise, flat) * 180 / Math.PI;
  const angle: StageCameraAngle = pitch > 55 ? "overhead" : pitch > 12 ? "high angle" : pitch < -10 ? "low angle" : "eye level";
  const figure = nearest === undefined ? undefined : staging.cast.find(f => f.sheetId === nearest);
  if (!figure) {
    const distance = Math.hypot(pose.p[0] - pose.l[0], rise, pose.p[2] - pose.l[2]);
    return { size: stageShotSize(2 * distance * Math.tan(fov * Math.PI / 360), 1.8), subject: null, side: null, angle };
  }
  const state = stageFigureAt(figure, staging.performances, at, durationSec, staging.objectMotions);
  const distance = Math.hypot(pose.p[0] - state.x, pose.p[2] - state.z);
  const facing = state.facing * Math.PI / 180;
  return {
    size: stageShotSize(2 * distance * Math.tan(fov * Math.PI / 360), framedSubjectHeight(figure, state.pose)),
    subject: figure.sheetId,
    side: stageBearing(pose.p[0] - state.x, pose.p[2] - state.z, rise, [Math.sin(facing), Math.cos(facing)]),
    angle,
  };
}

const SIDE_WORDS: Record<string, (name: string) => string> = {
  "in front of": () => "from the front",
  behind: () => "from behind",
  "to the left of": name => `from ${name}’s left`,
  "to the right of": name => `from ${name}’s right`,
  above: () => "from above",
  "on top of": () => "from above",
};
const span = (from: number, to: number) => `${from.toFixed(1)}–${to.toFixed(1)} s`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The camera across the shot in one line: size on whom, from where, at what angle, doing what. */
export function stageCameraLine(staging: ResolvedShotStaging, nameOf: (sheetId: string) => string, durationSec: number, aspect: string, lens: string | undefined, offset = 0): string {
  const start = stageCameraWordsAt(staging, 0, durationSec, aspect, lens);
  const end = stageCameraWordsAt(staging, durationSec, durationSec, aspect, lens);
  const move = stagingMotionWord(staging, durationSec);
  const who = start.subject === null ? "" : ` on ${nameOf(start.subject)}`;
  const side = start.side === null || start.subject === null ? "" : `, ${SIDE_WORDS[start.side]?.(nameOf(start.subject)) ?? start.side}`;
  const motion = move === "static" ? "locked off" : move;
  const ending = end.size === start.size ? "" : `, ending ${end.size}`;
  // Ease is how a move starts and lands; a generator reads it as the move being gentle, not as numbers.
  const first = staging.keys[0], last = staging.keys.at(-1);
  const eased = move === "static" ? "" : (first?.easeOut ?? 0) > 0 && (last?.easeIn ?? 0) > 0 ? ", easing in and out"
    : (first?.easeOut ?? 0) > 0 ? ", easing out of the start" : (last?.easeIn ?? 0) > 0 ? ", settling at the end" : "";
  return `${span(offset, offset + durationSec)} · ${capital(start.size)}${who}${side}, ${start.angle}, ${motion}${ending}${eased}.`;
}

/** What a mark's hand or look is on, in the prompt's words: a person by name, a set as "the counter". */
function targetOf(staging: ResolvedShotStaging, key: { hand?: { on: string }; look?: string }, nameOf: (sheetId: string) => string): string | null {
  const on = key.hand?.on ?? key.look;
  if (on === undefined) return null;
  return staging.cast.some((figure) => figure.sheetId === on) ? nameOf(on) : `the ${on}`;
}

/** The named thing a point is at: a figure within 1.6 m, preferred, else a set item whose footprint is within 1 m. */
function placeNear(staging: ResolvedShotStaging, self: string, x: number, z: number, at: number, durationSec: number, nameOf: (sheetId: string) => string): string | null {
  let best: { name: string; distance: number } | null = null;
  for (const figure of staging.cast) {
    if (figure.sheetId === self) continue;
    const state = stageFigureAt(figure, staging.performances, at, durationSec, staging.objectMotions);
    // A person beside the mark is what the action is about: "walks to Ade" over "walks to the
    // armchair" he sits in, so a figure's distance counts for less than furniture's.
    const distance = Math.hypot(state.x - x, state.z - z);
    if (distance < 1.6 && (!best || distance * .6 < best.distance)) best = { name: nameOf(figure.sheetId), distance: distance * .6 };
  }
  for (const set of staging.sets) {
    const origin = set.group ? stageObjectAt(staging.objectMotions, set.group, at).p : [0, 0, 0];
    const dx = Math.max(0, Math.abs(origin[0]! + set.x - x) - set.w / 2), dz = Math.max(0, Math.abs(origin[2]! + set.z - z) - set.d / 2);
    const distance = Math.hypot(dx, dz) + .4;
    // A room the point stands inside is not where anyone is going: it names nothing.
    if (set.w > 5 && set.d > 5 && dx === 0 && dz === 0) continue;
    if (distance < 1.4 && (!best || distance < best.distance)) best = { name: `the ${set.name}`, distance };
  }
  return best?.name ?? null;
}

/** One line per thing that happens, timed: walks with where from and to, then each change of pose. */
export function stageActionLines(staging: ResolvedShotStaging, nameOf: (sheetId: string) => string, durationSec: number, offset = 0): Array<{ at: number; line: string }> {
  const lines: Array<{ at: number; line: string }> = [];
  for (const figure of staging.cast) {
    const name = nameOf(figure.sheetId);
    const keys = staging.performances?.find(p => p.sheetId === figure.sheetId)?.keys;
    if (!keys?.length) {
      if (figure.to) {
        const from = placeNear(staging, figure.sheetId, figure.x, figure.z, 0, durationSec, nameOf);
        const to = placeNear(staging, figure.sheetId, figure.to[0], figure.to[1], durationSec, durationSec, nameOf);
        // R-34: a path no one could walk is never called a walk; the measured warning says why.
        const verb = (stageWalkSpeed(figure, durationSec) ?? 0) > MAX_STAGE_WALK_SPEED_MPS ? "moves" : "walks";
        lines.push({ at: 0, line: `${span(offset, offset + durationSec)} · ${name} ${verb}${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}.` });
      } else {
        const at = placeNear(staging, figure.sheetId, figure.x, figure.z, 0, durationSec, nameOf);
        lines.push({ at: 0, line: `${span(offset, offset + durationSec)} · ${name} ${stagePoseVerb(figure.pose ?? "stand", null)}${at ? ` at ${at}` : ""}.` });
      }
      continue;
    }
    // A pose is said where the figure holds it (a wait, a mark it stays on, the end) or where it
    // changes; standing that is only the start of a walk is the walk. Consecutive holds in one
    // pose are one line, so a shuffle of a centimetre between two marks does not split a wait.
    let pose: StagePose = figure.pose ?? "stand";
    let open: { from: number; to: number; pose: StagePose; place: string | null; target: string | null } | null = null;
    const close = () => {
      if (open) lines.push({ at: open.from, line: `${span(offset + open.from, offset + open.to)} · ${name} ${stagePoseVerb(open.pose, open.target)}${open.place && open.target === null ? ` at ${open.place}` : ""}.` });
      open = null;
    };
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!, next = keys[index + 1];
      const keyPose: StagePose = key.pose ?? pose;
      const target = targetOf(staging, key, nameOf);
      const changed = keyPose !== pose;
      pose = keyPose;
      const travel = next ? Math.hypot(next.x - key.x, next.z - key.z) : 0;
      const departure = next && travel >= .05 ? stagePerformanceDeparture(key, next) : (next?.t ?? durationSec);
      if (departure - key.t >= .25 || changed || target !== null) {
        const held = open as { pose: StagePose; to: number; target: string | null } | null;
        if (held !== null && held.pose === keyPose && held.target === target && Math.abs(held.to - key.t) < .01) held.to = departure;
        else { close(); open = { from: key.t, to: Math.max(departure, key.t), pose: keyPose, place: placeNear(staging, figure.sheetId, key.x, key.z, key.t, durationSec, nameOf), target }; }
      }
      if (!next || travel < .05) continue;
      close();
      const from = placeNear(staging, figure.sheetId, key.x, key.z, key.t, durationSec, nameOf);
      const to = placeNear(staging, figure.sheetId, next.x, next.z, next.t, durationSec, nameOf);
      const gait = key.gait ?? "walk";
      const tooFast = next.t > departure && travel / (next.t - departure) > STAGE_GAIT_SPEEDS[gait];
      lines.push({ at: departure, line: `${span(offset + departure, offset + next.t)} · ${name} ${tooFast ? "move" : gait}s${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}.` });
    }
    close();
  }
  for (const motion of staging.objectMotions ?? []) {
    const first = motion.keys[0]!, last = motion.keys.at(-1)!;
    const travel = Math.hypot(last.p[0] - first.p[0], last.p[1] - first.p[1], last.p[2] - first.p[2]);
    if (travel >= .05) lines.push({ at: first.t, line: `${span(offset + first.t, offset + last.t)} · the ${motion.group} moves.` });
  }
  return lines.sort((a, b) => a.at - b.at);
}

/** How closely to follow the blockout video, as the generator reads it. */
export function stagingFollowLine(video: string, follow: StageFollow): string {
  return follow === "camera"
    ? `Use @${video} only for camera position and movement. The figures in it are placeholders; do not copy their poses or body mechanics.`
    : `Follow @${video} precisely for camera position, movement, timing and blocking.`;
}

export interface StagePromptOptions {
  /** The production aspect; framing words are judged through the same cropped gate as the viewport. */
  aspect?: string;
  /** The shot's lens words ("35 mm"); a key's own focal length wins. */
  lens?: string;
  /** The label the dispatch gives the blockout video ("Video 1"), when it rides. */
  video?: string;
  follow?: StageFollow;
  /** Seconds before this shot in a board's cut, so every line is on the board's clock. */
  offset?: number;
}

/** The blockout's lines for a brief: the camera, the timed action, any measured warning, then how closely to follow the video. */
export function stagingPromptClause(
  staging: ResolvedShotStaging,
  nameOf: (sheetId: string) => string,
  durationSec: number,
  options: StagePromptOptions = {},
): string {
  staging = stagingRetimed(staging, durationSec) as ResolvedShotStaging;
  const offset = options.offset ?? 0;
  return [
    stageCameraLine(staging, nameOf, durationSec, options.aspect ?? "16:9", options.lens, offset),
    ...stageActionLines(staging, nameOf, durationSec, offset).map(entry => entry.line),
    ...stageSpeedWarnings(staging, nameOf, durationSec),
    ...stageTurnWarnings(staging, nameOf),
    ...(options.video ? [stagingFollowLine(options.video, options.follow ?? "camera-action")] : []),
  ].join("\n");
}

/** The figure the camera frames at its first key, when the Stage's words name one. */
export function stageCameraSubject(staging: ResolvedShotStaging, durationSec: number, aspect: string, lens: string | undefined): string | null {
  return stageCameraWordsAt(staging, 0, durationSec, aspect, lens).subject;
}

const FOLLOW_LINE = /^(?:Use @(Video [1-9][0-9]*) only for camera position and movement\. The figures in it are placeholders; do not copy their poses or body mechanics\.|Follow @(Video [1-9][0-9]*) precisely for camera position, movement, timing and blocking\.)$/gm;

/**
 * The brief with its follow line said the other way. Only a line the Stage wrote is rewritten;
 * a brief whose author took the line out keeps its own words, and the take still records the choice.
 */
export function stageBriefWithFollow(brief: string, follow: StageFollow): string {
  return brief.replace(FOLLOW_LINE, (_line, a: string | undefined, b: string | undefined) => stagingFollowLine((a ?? b)!, follow));
}

/** One Stage follow line, matched alone (FOLLOW_LINE is global and keeps its place between calls). */
const ONE_FOLLOW_LINE = new RegExp(FOLLOW_LINE.source);
const ANY_FOLLOW_LINE = new RegExp(FOLLOW_LINE.source, "m");

/** Whether the brief still says, in the Stage's own line, how to follow its blockout video. */
export function stageBriefFollows(brief: string): boolean {
  return ANY_FOLLOW_LINE.test(brief);
}
/** The References paragraph the Stage writes: one line, every entry a cited reference. */
const REFERENCES_PARAGRAPH = /^References: @[^\n]*\.$/;
/** A timed Stage line ("0.0–4.0 s · …"): a brief without one has no Stage lines to keep in step. */
const TIMED_LINE = /^\d+\.\d–\d+\.\d s · /m;

/**
 * What a staged subject's brief cites on the route its references ride now (issue 1817): the
 * riding pictures of cast and the blockout video, in the subject's reference order, worded as the
 * prefill words them, and the video's label when it rides.
 */
export function stageRoutingCitations(
  references: readonly BenchReferenceToken[],
  riding: readonly string[],
  nameOf: (sheetId: string) => string,
): { cited: string[]; video: string | null } {
  const rides = new Set(riding);
  const cited = references
    .filter((entry) => rides.has(entry.token) && (entry.sheetId !== undefined || entry.kind === "video"))
    .map((entry) => `@${entry.token} ${entry.kind === "video" ? "the blockout" : nameOf(entry.sheetId!)}`);
  const video = references.find((entry) => entry.kind === "video" && rides.has(entry.token))?.token ?? null;
  return { cited, video };
}

/**
 * The brief's Stage-written lines kept in step with the references riding now (issue 1817).
 * Switching models reroutes a staged subject's references: a line citing one that no longer
 * rides is refused at dispatch, and a blockout video that starts riding without its follow line
 * is followed by nothing. So the References paragraph cites exactly what rides (written before
 * the timed lines when it was absent, dropped when nothing rides), and the follow line is there
 * exactly when the video rides, closing the timed lines. A brief with no timed Stage line is the
 * author's, and an author's own words are never rewritten.
 */
export function stageBriefForRouting(
  brief: string,
  routing: { cited: readonly string[]; video: string | null; follow: StageFollow },
): string {
  if (!TIMED_LINE.test(brief)) return brief;
  const references = routing.cited.length === 0 ? null : `References: ${routing.cited.join(" · ")}.`;
  let paragraphs = brief.split("\n\n");
  const at = paragraphs.findIndex((paragraph) => REFERENCES_PARAGRAPH.test(paragraph));
  if (at >= 0) {
    if (references === null) paragraphs.splice(at, 1);
    else paragraphs[at] = references;
  } else if (references !== null) {
    const timed = paragraphs.findIndex((paragraph) => TIMED_LINE.test(paragraph));
    paragraphs.splice(timed, 0, references);
  }
  let followed = false;
  paragraphs = paragraphs.map((paragraph) => paragraph.split("\n").flatMap((line) => {
    if (!ONE_FOLLOW_LINE.test(line)) return [line];
    if (routing.video === null || followed) return [];
    followed = true;
    return [stagingFollowLine(routing.video, routing.follow)];
  }).join("\n")).filter((paragraph) => paragraph !== "");
  if (routing.video !== null && !followed) {
    const last = paragraphs.reduce((found, paragraph, index) => (TIMED_LINE.test(paragraph) ? index : found), -1);
    paragraphs[last] = `${paragraphs[last]}\n${stagingFollowLine(routing.video, routing.follow)}`;
  }
  return paragraphs.join("\n\n");
}
