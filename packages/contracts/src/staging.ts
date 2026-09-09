import { PerspectiveCamera, Vector3 } from "three";
import { DEFAULT_SHOT_SEC, effectiveFraming } from "./scene.js";
import { orderedShots } from "./scene-flow.js";
import { stagePathPoint, stageWorldPoint, stageCameraKeyAt, sampleStageCamera, stageTargetTransform, stageObjectAt, stageLocalPoint } from "./stage-camera.js";
import type { Shot, ShotStaging, StageRig, StagingFigure, StagingKey, StagingSet, StagePerformance, StageObjectMotion, StageReferenceFrame, StageGait, StagePerformanceKey } from "./scene.js";
import type { SceneRecord } from "./scene-flow.js";
import { parseAspect } from "./manifest.js";

/**
 * The Stage's pure arithmetic: where a fresh staging puts things, what a key list amounts to in
 * words, and the timed beats a prompt can carry. Shared by the client (the viewport and the
 * panel readouts) and the coordinator (the bench prefill), so the numbers a person reads on
 * the panel are the numbers the generator is told.
 *
 * Camera positions curve through keys; key ease maps time onto distance along each leg.
 */

const SUPER_35_WIDTH_MM = 24.89;
const SUPER_35_HEIGHT_MM = 18.66;
export const STAGE_FRAME_RATE = 30;
export const STAGE_CAMERA_NEAR = .1;
/** Ordered for admission: an end-frame route receives the pair before optional key/overview stills. */
export function stageReferenceFrames(keys: readonly { t: number }[], durationSec: number): StageReferenceFrame[] {
  return [
    { kind: "last", at: (stageFrameCount(durationSec) - 1) / STAGE_FRAME_RATE },
    ...keys.filter(key => key.t > 0 && key.t < durationSec).map(key => ({ kind: "key" as const, at: key.t })),
    { kind: "overview", at: 0 },
  ];
}
export const MAX_STAGE_WALK_SPEED_MPS = 2.2;
export const STAGE_RIGS: readonly StageRig[] = ["sticks", "dolly", "steadicam", "handheld", "crane", "drone", "car-mount"];

const RIG_PROFILE: Record<StageRig, { pos: number; rot: number; frequency: number; octaves: number }> = {
  sticks: { pos: 0, rot: 0, frequency: 0, octaves: 1 },
  dolly: { pos: 0.005, rot: 0.0005, frequency: 0.4, octaves: 1 },
  steadicam: { pos: 0.03, rot: 0.004, frequency: 0.5, octaves: 2 },
  handheld: { pos: 0.045, rot: 0.018, frequency: 1.8, octaves: 3 },
  crane: { pos: 0.01, rot: 0.001, frequency: 0.3, octaves: 1 },
  drone: { pos: 0.05, rot: 0.002, frequency: 0.25, octaves: 2 },
  "car-mount": { pos: 0.02, rot: 0.006, frequency: 2.5, octaves: 3 },
};

/** Stable unsigned seed for a shot id; no wall clock enters a Stage rig. */
export function stageRigSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function random(seed: number, channel: number, cell: number): number {
  let value = seed ^ Math.imul(channel + 1, 0x9e3779b1) ^ Math.imul(cell, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff * 2 - 1;
}

function rigNoise(seed: number, channel: number, at: number, frequency: number, octaves: number): number {
  let total = 0;
  let weight = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const scale = 2 ** octave;
    const phase = at * frequency * scale;
    const cell = Math.floor(phase);
    const f = phase - cell;
    const smooth = f * f * (3 - 2 * f);
    const amplitude = 1 / scale;
    total += (random(seed, channel + octave * 7, cell) * (1 - smooth) + random(seed, channel + octave * 7, cell + 1) * smooth) * amplitude;
    weight += amplitude;
  }
  return weight === 0 ? 0 : total / weight;
}

export function stageRigOffset(
  rig: StageRig | undefined,
  seed: number | undefined,
  intensity: number | undefined,
  at: number,
): { position: [number, number, number]; rotation: [number, number, number] } {
  const profile = RIG_PROFILE[rig ?? "sticks"];
  const amount = intensity ?? 1;
  if (amount === 0 || (profile.pos === 0 && profile.rot === 0)) {
    return { position: [0, 0, 0], rotation: [0, 0, 0] };
  }
  const noise = (channel: number) => rigNoise(seed ?? 0, channel, at, profile.frequency, profile.octaves);
  return {
    position: [noise(0) * profile.pos * amount, noise(1) * profile.pos * 0.7 * amount, noise(2) * profile.pos * amount],
    rotation: [noise(3) * profile.rot * amount, noise(4) * profile.rot * amount, noise(5) * profile.rot * 0.35 * amount],
  };
}

/** Distance fraction along one leg after its two mark-owned ease regions are applied. */
export function stagingEase(from: Pick<StagingKey, "easeOut">, to: Pick<StagingKey, "easeIn">, linear: number): number {
  const k = Math.max(0, Math.min(1, linear));
  let a = from.easeOut ?? 0;
  let b = to.easeIn ?? 0;
  const overlap = a + b;
  if (overlap > 1) {
    a /= overlap;
    b /= overlap;
  }
  const velocity = 1 / (1 - a / 2 - b / 2);
  if (a > 0 && k < a) return velocity * k * k / (2 * a);
  if (b > 0 && k > 1 - b) return 1 - velocity * (1 - k) * (1 - k) / (2 * b);
  return velocity * (k - a / 2);
}

export type EffectiveStageBlocking = {
  cast: StagingFigure[];
  sets: StagingSet[];
  identity: { owner: "scene"; version: number | null } | { owner: "shot" };
};

export type ResolvedShotStaging = Omit<ShotStaging, "cast" | "sets"> & {
  cast: StagingFigure[];
  sets: StagingSet[];
};

/** A legacy inline block is a complete shot override; otherwise the scene owns the action. */
export function effectiveStageBlocking(
  scene: Pick<SceneRecord, "blocking">,
  staging: ShotStaging | undefined,
): EffectiveStageBlocking {
  if (staging?.cast !== undefined && staging.sets !== undefined) {
    return { cast: staging.cast, sets: staging.sets, identity: { owner: "shot" } };
  }
  const blocking = scene.blocking;
  return blocking === undefined
    ? { cast: [], sets: [], identity: { owner: "scene", version: null } }
    : { cast: blocking.cast, sets: blocking.sets, identity: { owner: "scene", version: blocking.version } };
}

export function resolvedShotStaging(scene: Pick<SceneRecord, "blocking">, staging: ShotStaging): ResolvedShotStaging {
  const blocking = effectiveStageBlocking(scene, staging);
  return { ...staging, cast: blocking.cast, sets: blocking.sets };
}

/** Canonical bytes of the existing playblast fingerprint, shared by filing, Bench and Preview (#1050). */
export function stageSourceFingerprintInput(scene: SceneRecord, shot: Shot, aspect: string): string {
  if (!shot.staging) return "";
  const { playblast: _playblast, authorship: _authorship, ...staging } = resolvedShotStaging(scene, shot.staging);
  return JSON.stringify({ staging, durationSec: shot.durationSec ?? DEFAULT_SHOT_SEC, lens: effectiveFraming(scene, shot).lens ?? "", aspect });
}

/** Whether a filed Stage image no longer depicts this camera, blocking, lens, or duration. */
export function stagePlayblastIsStale(
  scene: Pick<SceneRecord, "blocking">,
  staging: ShotStaging,
  shown: { durationSec: number; aspect: string; lens: string | undefined },
): boolean {
  const pinned = staging.playblast;
  if (pinned === undefined) return false;
  const current = effectiveStageBlocking(scene, staging).identity;
  const blockingMoved = current.owner === "shot"
    ? pinned.blocking !== undefined && pinned.blocking.owner !== "shot"
    : pinned.blocking === undefined || pinned.blocking.owner !== "scene" || pinned.blocking.version !== current.version;
  return pinned.version !== staging.version || blockingMoved ||
    (pinned.durationSec !== undefined && pinned.durationSec !== shown.durationSec) ||
    (pinned.aspect !== undefined && pinned.aspect !== shown.aspect) ||
    (pinned.lens !== undefined && pinned.lens !== (shown.lens ?? "")) ||
    (pinned.rig !== undefined && pinned.rig !== staging.rig) ||
    (pinned.seed !== undefined && pinned.seed !== staging.seed) ||
    (pinned.rigIntensity !== undefined && pinned.rigIntensity !== staging.rigIntensity);
}

/** Fixed-rate export is half-open: frame i samples i/fps, never an extra frame at the end. */
export function stageFrameCount(durationSec: number): number {
  return Math.max(1, Math.ceil(durationSec * STAGE_FRAME_RATE - 1e-9));
}

/** Vertical field of view on a Super 35 gate cropped to the production aspect. */
export function stagingFov(lens: string | undefined, aspect: string): number {
  const millimetres = Number.parseFloat(/([\d.]+)\s*mm/i.exec(lens ?? "")?.[1] ?? "");
  if (!Number.isFinite(millimetres) || millimetres <= 0) return 34;
  const ratio = parseAspect(aspect) ?? 16 / 9;
  const usedHeight = Math.min(SUPER_35_HEIGHT_MM, SUPER_35_WIDTH_MM / ratio);
  return (2 * Math.atan(usedHeight / (2 * millimetres)) * 180) / Math.PI;
}

/** Inverse of the active Super 35 gate, used when a lens-animation key inherits the shot lens. */
export function stagingFocalForFov(fov: number, aspect: number): number {
  return Math.min(SUPER_35_HEIGHT_MM,SUPER_35_WIDTH_MM/aspect)/(2*Math.tan(fov*Math.PI/360));
}

/** Frame height as a fraction of a standing subject, retaining the first pass's size ranges (#1047). */
export const STAGE_FRAMED_HEIGHT = { "extreme close-up": .3, "close-up": .55, medium: .9, wide: 1.5, "extreme wide": 2.5 } as const;

/** Solve the subject-plane height through the same cropped Super 35 lens as the viewport. */
function distanceFor(size: string | undefined, camera: string | undefined, lens: string | undefined, aspect: string, subjectHeight: number): number {
  const words = `${size ?? ""} ${camera ?? ""}`.toLowerCase();
  const fraction = /extreme close|ecu/.test(words) ? STAGE_FRAMED_HEIGHT["extreme close-up"]
    : /close|mcu|\bcu\b/.test(words) ? STAGE_FRAMED_HEIGHT["close-up"]
    : /extreme wide|ews/.test(words) ? STAGE_FRAMED_HEIGHT["extreme wide"]
    : /wide|\bws\b/.test(words) ? STAGE_FRAMED_HEIGHT.wide : STAGE_FRAMED_HEIGHT.medium;
  return subjectHeight * fraction / (2 * Math.tan(stagingFov(lens, aspect) * Math.PI / 360));
}

function heightFor(angle: string | undefined): number {
  const words = (angle ?? "").toLowerCase();
  if (/overhead|top/.test(words)) return 4.4;
  if (/high/.test(words)) return 2.6;
  if (/low|worm/.test(words)) return 0.7;
  return 1.55;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function key(t: number, p: readonly [number, number, number], l: readonly [number, number, number], subject: string | null): StagingKey {
  return {
    t: round(t),
    p: [round(p[0]), round(p[1]), round(p[2])],
    l: [round(l[0]), round(l[1]), round(l[2])],
    ...(subject === null ? {} : { anchor: subject, track: subject }),
  };
}

function figureAction(description: string, sheetId: string, cast: readonly string[]): string {
  const words = description.toLowerCase();
  const mention = `@${sheetId.toLowerCase()}`;
  const start = words.indexOf(mention);
  if (start < 0) return "";
  const after = words.slice(start + mention.length);
  const sentenceStart = Math.max(words.lastIndexOf(".", start), words.lastIndexOf("!", start), words.lastIndexOf("?", start)) + 1;
  const castMentions = cast.map((id) => `@${id.toLowerCase()}`);
  const hasPreviousCast = castMentions.some((candidate) => words.lastIndexOf(candidate, start - 1) >= sentenceStart);
  const ends = [140];
  for (const candidate of castMentions) {
    const at = after.indexOf(candidate);
    if (at >= 0) ends.push(at);
  }
  const punctuation = after.search(/[.!?]/);
  if (punctuation >= 0) ends.push(punctuation);
  const prefix = hasPreviousCast ? "" : words.slice(sentenceStart, start);
  return `${prefix} ${after.slice(0, Math.min(...ends))}`;
}

const PROP_PROFILES: ReadonlyArray<{
  pattern: RegExp;
  name: string;
  w: number;
  h: number;
  d: number;
  beside: boolean;
}> = [
  { pattern: /\bchairs?\b/, name: "chair", w: 0.5, h: 0.45, d: 0.5, beside: false },
  { pattern: /\btables?\b/, name: "table", w: 1.4, h: 0.75, d: 0.8, beside: true },
  { pattern: /\bdesks?\b/, name: "desk", w: 1.4, h: 0.75, d: 0.7, beside: true },
  { pattern: /\bcounters?\b/, name: "counter", w: 2, h: 0.9, d: 0.7, beside: true },
  { pattern: /\bbeds?\b/, name: "bed", w: 1.5, h: 0.5, d: 2, beside: false },
  { pattern: /\b(?:sofas?|couches?)\b/, name: "sofa", w: 1.8, h: 0.45, d: 0.8, beside: false },
  { pattern: /\bbench(?:es)?\b/, name: "bench", w: 1.4, h: 0.45, d: 0.45, beside: false },
  { pattern: /\bstools?\b/, name: "stool", w: 0.4, h: 0.45, d: 0.4, beside: false },
];

function stagingProp(action: string, x: number, z: number): StagingSet | null {
  const found = PROP_PROFILES
    .map((profile) => ({ profile, at: action.search(profile.pattern) }))
    .filter((candidate) => candidate.at >= 0)
    .sort((left, right) => left.at - right.at)[0]?.profile;
  if (found === undefined) return null;
  return {
    name: found.name,
    x,
    z: round(z + (found.beside ? found.d / 2 + 0.25 : 0)),
    w: found.w,
    h: found.h,
    d: found.d,
  };
}

/**
 * A first staging, from nothing but the shot: cast in a loose line facing the lens, one massing
 * box per named location, and a camera move read off the framing words. Deterministic on
 * purpose — the same shot stages the same way twice, so a re-stage is a reset and not a
 * surprise — and every value here is a starting point for the gizmo, not a verdict.
 */
export function stageShot(
  shot: Shot,
  input: { cast: readonly string[]; sets: readonly string[]; durationSec: number; framing?: Shot["framing"]; aspect?: string; subjectHeight?: number },
): ResolvedShotStaging {
  const framing = input.framing ?? shot.framing;
  const blocked = input.cast.slice(0, 5).map((sheetId, index) => {
    const x = round(-1.5 + index * 1.5 - (Math.min(input.cast.length, 5) - 1) * 0.75);
    const z = index % 2 === 0 ? 0 : -0.5;
    const action = figureAction(shot.description, sheetId, input.cast);
    const pose = /\b(?:sits?|sitting|seated|takes? (?:a )?seat)\b/.test(action)
      ? "sit" as const
      : /\b(?:lies?|lying|reclines?|reclining|prone|supine)\b/.test(action)
        ? "lie" as const
        : undefined;
    const walking = pose === undefined && /\b(?:walks?|walking|paces?|pacing|crosses?|crossing)\b/.test(action);
    const distance = Math.min(2.4, Math.max(0.7, input.durationSec * 1.2));
    const figure: StagingFigure = {
      sheetId,
      x,
      z,
      ...(pose === undefined ? {} : { pose }),
      ...(walking ? { to: [x, round(z - distance)] as [number, number] } : {}),
    };
    return { figure, prop: stagingProp(action, x, z) };
  });
  const cast = blocked.map(({ figure }) => figure);
  const locations = input.sets.map((name, index) => ({
    name,
    x: index === 0 ? -3.4 : 4.2 + (index - 1) * 3.2,
    z: -3.4,
    w: index === 0 ? 4.4 : 2.6,
    h: index === 0 ? 2.9 : 2.1,
    d: 1.1,
  }));
  const sets = [...locations, ...blocked.flatMap(({ prop }) => prop === null ? [] : [prop])];
  const subject = cast[0]?.sheetId ?? null;
  const subjectHeight = input.subjectHeight ?? cast[0]?.height ?? 1.8;
  // Clear the figure volume as well as the near plane; some wide lenses cannot fit an ECU.
  const minimumDistance = STAGE_CAMERA_NEAR + subjectHeight / 4;
  const distance = Math.max(minimumDistance, distanceFor(framing?.size, shot.camera, framing?.lens, input.aspect ?? "16:9", subjectHeight));
  const height = heightFor(framing?.angle);
  const aimHeight = subject === null ? 1.1 : subjectHeight * (1.25 / 1.8);
  const dur = Math.max(0.5, input.durationSec);
  const move = readCameraMove(`${framing?.movement ?? ""} ${shot.camera ?? ""}`);

  // The position path and the aim path are composed independently, each from its own clause,
  // so "push-in with a pan right" pushes AND pans, and the direction word beside one component
  // never flips another (issue 886). Start on the axis: the camera stands `distance` back at
  // `height`, and what follows moves one coordinate at a time.
  const from: [number, number, number] = [0, height, distance];
  const to: [number, number, number] = [0, height, distance];
  if (move.dolly !== null) to[2] = Math.max(minimumDistance, distance * move.dolly);
  if (move.crane !== null) {
    const low = Math.max(0.6, height - 0.6);
    const high = height + 1.4;
    from[1] = move.crane === "up" ? low : high;
    to[1] = move.crane === "up" ? high : low;
    to[2] = Math.max(minimumDistance, to[2] * 0.9);
  }
  if (move.truck !== null) {
    // The camera looks down -Z, so +X is its right.
    const reach = distance * 0.35;
    from[0] = move.truck === "right" ? -reach : reach;
    to[0] = -from[0];
  }
  const aimFrom: [number, number, number] = [0, aimHeight, 0];
  const aimTo: [number, number, number] = [0, aimHeight, 0];
  if (move.pan !== null) {
    aimFrom[0] = move.pan === "right" ? -1.5 : 1.5;
    aimTo[0] = -aimFrom[0];
  }
  if (move.tilt !== null) {
    aimFrom[1] = move.tilt === "up" ? 0.3 : 2.5;
    aimTo[1] = move.tilt === "up" ? 2.5 : 0.3;
  }
  const turns = move.pan !== null || move.tilt !== null;
  // An orbit is the whole position path, and it is defined by looking at its subject.
  const keys: StagingKey[] = move.orbit
    ? [
        key(0, [-distance * 0.7, height, distance * 0.7], [0, aimHeight, 0], null),
        key(dur / 2, [0, height, distance], [0, aimHeight, 0], null),
        key(dur, [distance * 0.7, height, distance * 0.7], [0, aimHeight, 0], null),
      ]
    : [key(0, from, aimFrom, null), key(dur, to, aimTo, null)];
  // Only a tracking or follow instruction rides with a subject: its keys are offsets, and the
  // aim follows the figure live unless the move deliberately turns away (a pan or tilt is an
  // offset aim that sweeps). Everything else is world-locked — the camera stands where the
  // subject was blocked and stays there while the performer crosses the frame.
  const figure = cast[0];
  for (const k of keys) {
    if (move.rides && subject !== null) {
      k.anchor = subject;
      if (!turns && !move.orbit) k.track = subject;
      else if (move.orbit) k.track = subject;
    } else if (figure) {
      k.p = [round(k.p[0] + figure.x), k.p[1], round(k.p[2] + figure.z)];
      k.l = [round(k.l[0] + figure.x), k.l[1], round(k.l[2] + figure.z)];
    }
  }
  if (move.slow && keys.length > 1) {
    keys[0] = { ...keys[0]!, easeOut: 0.25 };
    keys[keys.length - 1] = { ...keys[keys.length - 1]!, easeIn: 0.25 };
  }
  return { version: 1, cast, sets, keys, rig: move.rig, seed: stageRigSeed(shot.id), rigIntensity: 1 };
}

/** Named starting points produce ordinary keys; no preset identity is stored (#1048). */
export const STAGE_CAMERA_MOVES = [
  { id: "push-in", label: "Push in", description: "Dolly to 55% of the starting distance." },
  { id: "pull-back", label: "Pull back", description: "Dolly to 170% of the starting distance." },
  { id: "creep-low", label: "Creep in low", description: "Ease closer while lowering the camera." },
  { id: "orbit-90", label: "Orbit 90°", description: "Quarter orbit around the subject." },
  { id: "orbit-180", label: "Orbit 180°", description: "Half orbit around the subject." },
  { id: "orbit-360", label: "Orbit 360°", description: "Full orbit with intermediate marks every 45 degrees." },
  { id: "arc-push", label: "Arc and push", description: "Quarter orbit while halving the radius." },
  { id: "crane-up", label: "Crane up reveal", description: "Rise and pull back to reveal the surroundings." },
  { id: "crane-down", label: "Crane down", description: "Descend toward the subject." },
  { id: "pedestal", label: "Pedestal", description: "Rise vertically at a fixed horizontal position." },
  { id: "follow-behind", label: "Follow behind", description: "Settle behind the subject and ride its local transform." },
  { id: "lead", label: "Lead", description: "Settle in front of the subject and ride its local transform." },
  { id: "side-track", label: "Side track", description: "Settle beside the subject and ride its local transform." },
  { id: "vertigo", label: "Vertigo", description: "Dolly and compensate focal length to preserve the subject's size." },
] as const;
export type StageCameraMove = typeof STAGE_CAMERA_MOVES[number]["id"];

export function stageCameraMove(
  move: StageCameraMove,
  staging: ResolvedShotStaging,
  input: { durationSec: number; at?: number; subjectId?: string; lens?: string; aspect?: string },
): StagingKey[] {
  const figure = staging.cast.find(candidate => candidate.sheetId === input.subjectId) ?? staging.cast[0];
  if (!figure) return staging.keys;
  const duration = input.durationSec;
  const aspect = input.aspect ?? "16:9";
  const ratio = parseAspect(aspect) ?? 16 / 9;
  const fov = stagingFov(input.lens, aspect);
  const start = sampleStageCamera(staging, input.at ?? 0, duration).p;
  const lens = stageCameraKeyAt(staging, input.at ?? 0, duration, fov, ratio);
  const subject = stageTargetTransform(staging, figure.sheetId, 0, duration)!;
  const aimHeight = (figure.height ?? 1.8) * .65;
  const aim: [number, number, number] = [subject.p[0], subject.p[1] + aimHeight, subject.p[2]];
  const offset: [number, number, number] = [start[0] - aim[0], start[1] - aim[1], start[2] - aim[2]];
  const radius = Math.max(.3, Math.hypot(offset[0], offset[2]));
  const inherited = { ...(lens.roll === undefined ? {} : { roll: lens.roll }), ...(lens.focalMm === undefined ? {} : { focalMm: lens.focalMm }) };
  const make = (t: number, p: [number, number, number]): StagingKey => ({ t, p: [p[0], Math.max(.15, p[1]), p[2]], l: [0, aimHeight, 0], track: figure.sheetId, ...inherited });
  const world = (scale: number, angle = 0, height = start[1]): [number, number, number] => [
    aim[0] + (offset[0] * Math.cos(angle) + offset[2] * Math.sin(angle)) * scale,
    height,
    aim[2] + (offset[2] * Math.cos(angle) - offset[0] * Math.sin(angle)) * scale,
  ];
  let keys: StagingKey[];
  if (move === "follow-behind" || move === "lead" || move === "side-track") {
    const local = stageWorldPoint(start, subject);
    const destination: [number, number, number] = [move === "side-track" ? radius : 0, local[1], move === "follow-behind" ? -radius : move === "lead" ? radius : 0];
    keys = [0, duration / 4, duration].map((t, index) => ({ ...make(t, start), p: index === 0 ? local : destination, anchor: figure.sheetId, anchorSpace: "local" }));
  } else if (move === "vertigo") {
    const focal = lens.focalMm ?? stagingFocalForFov(fov, ratio);
    const factor = focal > 500 || aim[1] + offset[1] * 1.7 < .15 ? .6 : 1.7;
    keys = [1, factor].map((scale, index) => ({
      ...make(index * duration, start), anchor: figure.sheetId,
      p: [offset[0] * scale, aimHeight + offset[1] * scale, offset[2] * scale],
      focalMm: focal * scale,
    }));
  } else if (move.startsWith("orbit-") || move === "arc-push") {
    const degrees = move === "arc-push" ? 90 : Number(move.slice(6));
    const count = Math.ceil(degrees / 45);
    keys = Array.from({ length: count + 1 }, (_, index) => {
      const u = index / count;
      return make(duration * u, world(move === "arc-push" ? 1 - .45 * u : 1, degrees * u * Math.PI / 180));
    });
  } else {
    const end = move === "push-in" ? world(.55)
      : move === "pull-back" ? world(1.7)
      : move === "creep-low" ? world(.8, 0, Math.min(start[1], subject.p[1] + .45))
      : move === "crane-up" ? world(1.25, 0, start[1] + Math.max(1.4, (figure.height ?? 1.8) * 1.5))
      : move === "crane-down" ? world(1, 0, Math.max(.15, start[1] - 1.8))
      : world(1, 0, start[1] + 1.2);
    keys = [make(0, [...start]), make(duration, end)];
  }
  keys[0] = { ...keys[0]!, easeOut: .25 };
  keys[keys.length - 1] = { ...keys[keys.length - 1]!, easeIn: .25 };
  return keys;
}

/** What the framing words ask the camera to do, one component per clause. */
export interface CameraMove {
  /** The camera holds its offset from the subject (track, follow). */
  rides: boolean;
  /** End distance as a fraction of the start: a push ends nearer, a pull further. */
  dolly: number | null;
  crane: "up" | "down" | null;
  /** Lateral travel, in the camera's own left and right. */
  truck: "left" | "right" | null;
  orbit: boolean;
  /** Aim sweeps sideways from a held position. */
  pan: "left" | "right" | null;
  /** Aim sweeps vertically from a held position. */
  tilt: "up" | "down" | null;
  slow: boolean;
  rig: StageRig;
}

/**
 * Read a movement phrase as independent components.
 *
 * Each clause names one thing the camera does and, beside it, which way. "Crane up, tilting
 * down" is a crane that rises while the aim drops; read as one string with one direction it
 * became a crane that fell. A clause is split on punctuation and the joining words a person
 * uses to add a second move, and a direction word counts only for the component in its clause.
 */
export function readCameraMove(words: string): CameraMove {
  const text = words.toLowerCase();
  const move: CameraMove = { rides: false, dolly: null, crane: null, truck: null, orbit: false, pan: null, tilt: null, slow: false, rig: "sticks" };
  for (const clause of text.split(/[,;·]|\b(?:and|with|while|then|into|as|plus)\b/)) {
    const left = /\bleft\b/.test(clause);
    const down = /\bdown(?:ward)?\b|\blower(?:s|ing)?\b|\bdescend(?:s|ing)?\b/.test(clause);
    if (/\bpan(?:s|ned|ning)?\b/.test(clause)) move.pan = left ? "left" : "right";
    if (/\btilt(?:s|ed|ing)?\b/.test(clause)) move.tilt = down ? "down" : "up";
    if (/\bpush(?:es|ed|ing)?(?:[- ]in)?\b|\b(?:dolly|dollies|move|moves|moving|track|tracks|tracking|creep|creeps|creeping)[- ]in\b/.test(clause)) move.dolly = 0.55;
    else if (/\bpull(?:s|ed|ing)?(?:[- ](?:out|back))?\b|\b(?:dolly|dollies|move|moves|moving|track|tracks|tracking)[- ](?:out|back)\b/.test(clause)) move.dolly = 1.6;
    if (/\bcrane|\bboom|\bjib|\brise|\brising|\brises|\blower|\bdescend/.test(clause)) move.crane = down ? "down" : "up";
    if (/\btruck|\blateral|\bslide|\bslides|\bsliding|\bcrab/.test(clause)) move.truck = left ? "left" : "right";
    if (/\borbit|\barc\b|\barcs\b|\barcing\b|\bcircle|\bcircling|\bround\b/.test(clause)) move.orbit = true;
    if (/\b(?:track|tracks|tracking|follow|follows|following)\b/.test(clause) && !/\b(?:track|tracks|tracking)[- ](?:in|out|back)\b/.test(clause)) move.rides = true;
  }
  move.slow = /slow|gentle|soft|smooth/.test(text);
  move.rig = /handheld|hand-held|shoulder/.test(text)
    ? "handheld"
    : /steadicam|gimbal/.test(text)
      ? "steadicam"
      : /crane|boom|jib/.test(text)
        ? "crane"
        : /drone|aerial/.test(text)
          ? "drone"
          : /car mount|vehicle mount/.test(text)
            ? "car-mount"
            : move.dolly !== null || move.truck !== null || move.rides || /\bdolly\b/.test(text)
              ? "dolly"
              : "sticks";
  return move;
}

/** The move in one word, read off what the keys actually do. */
export function stagingMoveWord(keys: readonly StagingKey[], cast: readonly StagingFigure[] = [], rig?: StageRig): string {
  const withRig = (move: string) => rig === undefined || rig === "sticks" || move.startsWith(rig) ? move : `${rig.replace("-", " ")} ${move}`;
  if (keys.length < 2) return withRig("static");
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  const dx = Math.abs(last.p[0] - first.p[0]);
  const dy = Math.abs(last.p[1] - first.p[1]);
  const dz = Math.abs(last.p[2] - first.p[2]);
  // What the aim does, read off the aim itself: a pan or tilt is the lens turning while the
  // position it turns from holds — or moves, in which case both are named (issue 886). A
  // tracked aim is held on its subject by definition, so its travel in world space is the
  // subject walking, not the lens turning; only a free aim's travel is a turn.
  const free = keys.filter(k => k.track === undefined);
  const aimX = free.length < 2 ? 0 : Math.max(...free.map(k => k.l[0])) - Math.min(...free.map(k => k.l[0]));
  const aimY = free.length < 2 ? 0 : Math.max(...free.map(k => k.l[1])) - Math.min(...free.map(k => k.l[1]));
  const turn = aimX > 0.05 || aimY > 0.05 ? (aimX > 0.05 && aimY > 0.05 ? "pan and tilt" : aimX > aimY ? "pan" : "tilt") : null;
  if (dx < 0.15 && dy < 0.15 && dz < 0.15) {
    const excursion = keys.some(k => Math.hypot(k.p[0] - first.p[0], k.p[1] - first.p[1], k.p[2] - first.p[2]) >= 0.15);
    if (excursion) return withRig(sweep(keys) > 50 ? "orbit" : "out and back");
    if (turn !== null) return withRig(turn);
    if (keys.length > 2 && sweep(keys) > 50) return withRig("orbit");
    // The same offset from a figure who walks is a camera that walks with them: it holds its
    // frame and crosses the set, which is a tracking shot and not a static one.
    const rides = keys.every((key) => key.anchor !== undefined && cast.find((figure) => figure.sheetId === key.anchor)?.to !== undefined);
    return withRig(rides ? "tracking" : "static");
  }
  // An orbit is the camera revolving around an aim it holds. The same angular sweep with the
  // aim itself swinging is a pan on a moving camera, and used to be named an orbit too.
  if (turn === null && sweep(keys) > 50) return withRig("orbit");
  const travel = dy >= dx && dy >= dz ? "crane" : dx > dz ? "truck" : "dolly";
  return withRig(turn === null ? travel : `${travel} with ${turn}`);
}

/** Total angular travel around the aim, including intermediate keys and full revolutions. */
function sweep(keys: readonly StagingKey[]): number {
  let degrees=0;
  for(let i=1;i<keys.length;i++) {
    const from=keys[i-1]!,to=keys[i]!;
    const a=Math.atan2(from.p[0]-from.l[0],from.p[2]-from.l[2]);
    const b=Math.atan2(to.p[0]-to.l[0],to.p[2]-to.l[2]);
    degrees+=Math.abs(((b-a+3*Math.PI)%(2*Math.PI))-Math.PI)*180/Math.PI;
  }
  return degrees;
}

/** Include moving parents and performers when naming the shot's actual camera movement. */
export function stagingMotionWord(staging: ResolvedShotStaging, durationSec: number): string {
  const world=staging.keys.map(key=>({...key,...sampleStageCamera(staging,key.t,durationSec),anchor:undefined}));
  const first=staging.keys[0];
  const rides=first?.anchor && staging.keys.every(key=>key.anchor===first.anchor&&key.p.every((v,i)=>Math.abs(v-first.p[i]!)<.01));
  if(rides && world.some(key=>Math.hypot(...key.p.map((v,i)=>v-world[0]!.p[i]!))>.15)) {
    const rig=staging.rig && staging.rig!=="sticks"?`${staging.rig.replace("-"," ")} `:"";
    const rotation=stagingMoveWord(staging.keys);
    return `${rig}tracking${rotation.includes("pan")||rotation.includes("tilt")?` with ${rotation}`:""}`;
  }
  return stagingMoveWord(world,staging.cast,staging.rig);
}

/**
 * Where the camera stands relative to what it looks at, in the words a prompt uses. A figure
 * faces +Z until it walks (then it faces its path), and "left" is the subject's left.
 */
function bearing(ox: number, oz: number, rise: number, facing: readonly [number, number]): string {
  const flat = Math.hypot(ox, oz);
  if (rise > 2.4 && flat < 1.6) return "above";
  if (flat < 0.05) return "on top of";
  // Forward along the facing; the subject's left is up × forward.
  const forward = (ox * facing[0] + oz * facing[1]) / flat;
  const left = (ox * facing[1] - oz * facing[0]) / flat;
  if (forward > 0.7) return "in front of";
  if (forward < -0.7) return "behind";
  return left > 0 ? "to the left of" : "to the right of";
}

/**
 * The move as timed beats the generator can read — one line per key, in metres and seconds.
 * These ride in the prompt beside the playblast, and are the whole point of measuring: a
 * playblast the route cannot carry still leaves the numbers behind.
 */
export function stagingBeats(
  staging: ResolvedShotStaging,
  nameOf: (sheetId: string) => string,
  durationSec: number,
): string[] {
  staging = stagingRetimed(staging,durationSec) as ResolvedShotStaging;
  const keys = staging.keys;
  const warnings = stageSpeedWarnings(staging, nameOf, durationSec);
  const camera = keys.map((k) => {
    const subject = k.anchor ?? k.track ?? null;
    const pose = sampleStageCamera({...staging,keys},k.t,durationSec);
    const target = subject ? stageTargetTransform(staging,subject,k.t,durationSec) : null;
    const [tx,,tz] = target?.p ?? pose.l;
    const ox = pose.p[0]-tx, oz=pose.p[2]-tz;
    const flat = Math.hypot(ox,oz).toFixed(1);
    const height = pose.p[1].toFixed(2);
    const angle = (target?.rotation[1]??0)*Math.PI/180;
    const where = bearing(ox,oz,pose.p[1]-pose.l[1],[Math.sin(angle),Math.cos(angle)]);
    const who = subject === null ? "the aim point" : nameOf(subject);
    const aim = k.track === undefined ? `, aim (${pose.l.map(v=>v.toFixed(2)).join(", ")})m in world space` : `, aimed at ${nameOf(k.track)}`;
    const ease = [
      k.easeIn === undefined ? "" : `ease in ${Math.round(k.easeIn * 100)}%`,
      k.easeOut === undefined ? "" : `ease out ${Math.round(k.easeOut * 100)}%`,
    ].filter(Boolean).join(", ");
    return `${k.t.toFixed(1)}s — ${flat}m ${where} ${who}, ${height}m high${aim}${k.roll === undefined ? "" : `, roll ${k.roll}°`}${k.focalMm === undefined ? "" : `, lens ${k.focalMm}mm`}${ease === "" ? "" : `, ${ease}`}`;
  });
  return [...warnings, ...camera];
}

/** Metres per second implied by a figure's blocked path, or null when it holds. */
export function stageWalkSpeed(figure: StagingFigure, durationSec: number): number | null {
  if (figure.to === undefined) return null;
  const distance = Math.hypot(figure.to[0] - figure.x, figure.to[1] - figure.z);
  if (durationSec <= 0) return distance === 0 ? 0 : Number.POSITIVE_INFINITY;
  return distance / durationSec;
}

export const STAGE_GAIT_SPEEDS: Record<StageGait, number> = { walk: MAX_STAGE_WALK_SPEED_MPS, jog: 4, run: 9 };
export interface StageMotionSpeed {
  kind: "performance" | "object";
  id: string;
  from: number;
  to: number;
  distance: number;
  speed: number;
  ceiling?: number;
  gait?: StageGait;
}

/** Measure local performer travel, so riding a moving vehicle does not count as running. */
export function stageMotionSpeeds(staging: { cast: readonly StagingFigure[]; performances?: readonly StagePerformance[]; objectMotions?: readonly StageObjectMotion[] }, durationSec: number): StageMotionSpeed[] {
  const result: StageMotionSpeed[] = [];
  const measure = (leg: Omit<StageMotionSpeed, "distance" | "speed">, point: (at: number) => readonly number[]) => {
    let distance = 0;
    let previous = point(leg.from);
    for (let i = 1; i <= 32; i++) {
      const next = point(leg.from + (leg.to - leg.from) * i / 32);
      distance += Math.hypot(...next.map((value, axis) => value - previous[axis]!));
      previous = next;
    }
    if (distance < .05) return;
    result.push({ ...leg, distance, speed: leg.to > leg.from ? distance / (leg.to - leg.from) : Infinity });
  };
  for (const figure of staging.cast) {
    const performance = staging.performances?.find(track => track.sheetId === figure.sheetId);
    if (performance) {
      for (let index = 0; index < performance.keys.length - 1; index++) {
        const a = performance.keys[index]!, b = performance.keys[index + 1]!;
        const gait = a.gait ?? "walk";
        measure({ kind: "performance", id: figure.sheetId, from: stagePerformanceDeparture(a, b), to: b.t, gait, ceiling: STAGE_GAIT_SPEEDS[gait] }, at => {
          const state = stageFigureLocalAt(figure, staging.performances, at, durationSec);
          return [state.x, state.y, state.z];
        });
      }
    } else if (figure.to) {
      const speed = stageWalkSpeed(figure, durationSec)!;
      const distance = Math.hypot(figure.to[0] - figure.x, figure.to[1] - figure.z);
      if (distance >= .05) result.push({ kind: "performance", id: figure.sheetId, from: 0, to: durationSec, gait: "walk", ceiling: STAGE_GAIT_SPEEDS.walk, distance, speed });
    }
  }
  for (const motion of staging.objectMotions ?? []) {
    for (let index = 0; index < motion.keys.length - 1; index++) {
      const a = motion.keys[index]!, b = motion.keys[index + 1]!;
      measure({ kind: "object", id: motion.group, from: a.t, to: b.t, ...(motion.maxSpeed === undefined ? {} : { ceiling: motion.maxSpeed }) }, at => stageObjectAt(staging.objectMotions, motion.group, at).p);
    }
  }
  return result;
}

export function stageSpeedWarning(leg: StageMotionSpeed, nameOf: (id: string) => string): string | null {
  if (leg.ceiling === undefined || leg.speed <= leg.ceiling) return null;
  const suggestion = leg.gait === undefined ? undefined : (["jog", "run"] as const).find(gait => STAGE_GAIT_SPEEDS[gait] >= leg.speed);
  const verdict = leg.gait ? `too fast for a ${leg.gait}` : `above ${leg.ceiling.toFixed(2)}m/s ceiling`;
  return `Blocking warning — ${leg.kind === "performance" ? nameOf(leg.id) : leg.id} · ${leg.distance.toFixed(1)}m in ${(leg.to - leg.from).toFixed(1)}s · ${(Math.ceil(leg.speed * 100) / 100).toFixed(2)}m/s · ${verdict} (${leg.from.toFixed(2)}–${leg.to.toFixed(2)}s); ${suggestion ? `use ${suggestion} or add time` : "add time"}`;
}
export function stageSpeedWarnings(staging: { cast: readonly StagingFigure[]; performances?: readonly StagePerformance[]; objectMotions?: readonly StageObjectMotion[] }, nameOf: (id: string) => string, durationSec: number): string[] {
  return stageMotionSpeeds(staging, durationSec).flatMap(leg => {
    const warning = stageSpeedWarning(leg, nameOf);
    return warning === null ? [] : [warning];
  });
}

/** Where a figure stands a fraction `u` of the way through the shot: on its walk, or where it was put. */
function figureAt(figure: StagingFigure, u: number): [number, number] {
  if (figure.to === undefined) return [figure.x, figure.z];
  const along = Math.max(0, Math.min(1, u));
  return [figure.x + (figure.to[0] - figure.x) * along, figure.z + (figure.to[1] - figure.z) * along];
}

/**
 * A staging held to the shot's length. The end key is the end pose, so it always sits at the
 * shot's duration; a shot retimed after it was staged would otherwise play past (or stop short
 * of) its own end pose, and the beats would name seconds the clip does not have. Interior keys
 * that no longer fit are pulled in ahead of the end, in order. Returns the same object when
 * nothing needs to move.
 */
export function stagingRetimed(staging: ShotStaging, durationSec: number, previousDurationSec?: number): ShotStaging {
  if (staging.keys.length === 0) return staging;
  const last = staging.keys.length - 1;
  const oldDuration = staging.keys[last]!.t || previousDurationSec || 0;
  if (staging.objectMotions && oldDuration > 0 && oldDuration !== durationSec) staging = { ...staging, objectMotions: staging.objectMotions.map(motion => ({ ...motion, keys: motion.keys.map(key => ({ ...key, t: key.t * durationSec / oldDuration })) })) };
  if (staging.performances && oldDuration > 0 && oldDuration !== durationSec) staging = { ...staging, performances: staging.performances.map(performance => ({ ...performance, keys: performance.keys.map(key => ({ ...key, t: key.t * durationSec / oldDuration, ...(key.hold === undefined ? {} : { hold: key.hold * durationSec / oldDuration }) })) })) };
  // A single mark is a static camera, not an end pose. Give it equivalent endpoints so a
  // subsequent draft retime has a duration even when its action finishes before the shot does.
  if (staging.keys.length === 1) return { ...staging, keys: [{ ...staging.keys[0]!, t: 0 }, { ...staging.keys[0]!, t: durationSec }] };
  if (staging.keys[last]!.t === durationSec && staging.keys.every((key, index) => index === last || key.t < durationSec)) return staging;
  // Interior keys that still fit stay where they are; if any no longer does, the whole move is
  // scaled to the new length instead of clamped, so no two keys land on one moment.
  const fits = !staging.performances?.length && !staging.objectMotions?.length && staging.keys.every((key, index) => index === last || key.t < durationSec);
  const scale = staging.keys[last]!.t > 0 ? durationSec / staging.keys[last]!.t : 0;
  const scaled = staging.keys.map((key, index) =>
    index === last ? { ...key, t: round(durationSec) } : fits ? key : { ...key, t: round(key.t * scale) },
  );
  if (fits) return { ...staging, keys: scaled };
  // Rounding to hundredths can still land two scaled keys on one moment; each is kept a step
  // after the last, and any pushed onto the end pose is folded into it.
  const end = round(durationSec);
  const interior: StagingKey[] = [];
  for (const key of scaled.slice(0, -1)) {
    const prev = interior.at(-1);
    const t = prev === undefined ? key.t : Math.max(key.t, round(prev.t + 0.01));
    if (t < end) interior.push({ ...key, t });
  }
  return { ...staging, keys: [...interior, { ...scaled[last]!, t: end }] };
}

/** The playblast's own line for a session brief: what it is, and the beats beneath it. */
export function stagingPromptClause(
  staging: ResolvedShotStaging,
  nameOf: (sheetId: string) => string,
  durationSec: number,
): string {
  staging = stagingRetimed(staging,durationSec) as ResolvedShotStaging;
  const keys = staging.keys;
  const walkers = staging.cast
    .filter((figure) => {
      if (staging.performances?.some(performance => performance.sheetId === figure.sheetId)) return false;
      const speed = stageWalkSpeed(figure, durationSec);
      return speed !== null && speed <= MAX_STAGE_WALK_SPEED_MPS;
    })
    .map((figure) => nameOf(figure.sheetId));
  const walk = walkers.length === 0 ? "" : ` ${walkers.join(", ")} ${walkers.length === 1 ? "walks" : "walk"} through the shot.`;
  const poses = staging.cast.flatMap((figure) =>
    figure.pose === "sit"
      ? [`${nameOf(figure.sheetId)} is seated`]
      : figure.pose === "lie"
        ? [`${nameOf(figure.sheetId)} is lying down`]
        : [],
  );
  const posture = poses.length === 0 ? "" : ` ${poses.join("; ")}.`;
  const sets = staging.sets.length === 0
    ? []
    : [`Set massing — ${staging.sets.map((set) => `${set.name}: ${set.w.toFixed(2)}m wide, ${set.h.toFixed(2)}m high, ${set.d.toFixed(2)}m deep at x ${set.x.toFixed(2)}m, z ${set.z.toFixed(2)}m`).join("; ")}.`];
  return [
    "Use the blockout for composition, action and camera motion. Replace greybox geometry with the approved character, location and style references.",
    `Camera move, ${stagingMotionWord(staging,durationSec)}, blocked out on the stage (${keys.length} keys).${walk}${posture}`,
    ...sets,
    ...(staging.performances ?? []).flatMap(performance => performance.keys.map((key, index) => {
      const next = performance.keys[index + 1];
      const departure = next ? stagePerformanceDeparture(key, next) : key.t;
      const y = staging.cast.find(figure => figure.sheetId === performance.sheetId)?.y ?? 0;
      const moving = next && Math.hypot(next.x - key.x, next.z - key.z, (next.y ?? y) - (key.y ?? y)) >= .05;
      return `${key.t.toFixed(2)}s — ${nameOf(performance.sheetId)} at (${key.x.toFixed(2)}, ${(key.y ?? 0).toFixed(2)}, ${key.z.toFixed(2)})m, facing ${key.facing ?? 0}°, ${key.pose ?? "standing"}${moving ? `, ${key.gait ?? "walk"}` : ", holds position"}${departure > key.t ? `, hold until ${departure.toFixed(2)}s` : ""}${key.easeIn === undefined ? "" : `, ease in ${Math.round(key.easeIn * 100)}%`}${key.easeOut === undefined ? "" : `, ease out ${Math.round(key.easeOut * 100)}%`}`;
    })),
    ...(staging.objectMotions ?? []).flatMap(motion=>motion.keys.map(key=>`${key.t.toFixed(2)}s — ${motion.group} at (${key.p.join(", ")})m, rotation (${(key.rotation??[0,0,0]).join(", ")})°.`)),
    ...stagingBeats(staging, nameOf, durationSec),
    ...keys.slice(0,-1).map((key,index) => {
      const at = (key.t + keys[index + 1]!.t) / 2;
      const pose = sampleStageCamera({ ...staging, keys }, at, durationSec);
      return `${at.toFixed(2)}s — camera world position (${pose.p.map(v => v.toFixed(2)).join(", ")})m; aim (${pose.l.map(v => v.toFixed(2)).join(", ")})m.`;
    }),
  ].join("\n");
}

/** Shot-local action overrides a shared figure's legacy full-shot walk. Angles use degrees. */
export function stageFigureAt(figure: StagingFigure, performances: readonly StagePerformance[] | undefined, at: number, durationSec: number, motions?: readonly StageObjectMotion[]) {
  const state = stageFigureLocalAt(figure, performances, at, durationSec);
  if (!figure.parent) return state;
  const transform = stageObjectAt(motions, figure.parent, at);
  const [x,y,z] = stageLocalPoint([state.x,state.y,state.z], transform);
  return { ...state, x,y,z, facing:state.facing+transform.rotation[1] };
}
/** A hold leaves at least 0.1s of its leg for travel, including after retiming (#1046). */
export function stagePerformanceDeparture(a: StagePerformanceKey, b: StagePerformanceKey): number {
  return a.t + Math.min(a.hold ?? 0, Math.max(0, b.t - a.t - .1));
}
function stageFigureLocalAt(figure: StagingFigure, performances: readonly StagePerformance[] | undefined, at: number, durationSec: number): {x:number;z:number;y:number;facing:number;pose:"stand"|"sit"|"lie"} {
  const keys = performances?.find(p => p.sheetId === figure.sheetId)?.keys;
  if (!keys?.length) {
    const [x, z] = figureAt(figure, durationSec <= 0 ? 0 : at / durationSec);
    return { x, z, y: figure.y ?? 0, facing: figure.facing ?? (figure.to ? Math.atan2(figure.to[0] - figure.x, figure.to[1] - figure.z) * 180 / Math.PI : 0), pose: figure.pose ?? "stand" };
  }
  let index = 0;
  while (index < keys.length - 1 && keys[index + 1]!.t <= at) index++;
  const a = keys[index]!;
  const b = keys[Math.min(index + 1, keys.length - 1)]!;
  const departure = stagePerformanceDeparture(a, b);
  const progress = b.t === departure ? 0 : Math.max(0, Math.min(1, (at - departure) / (b.t - departure)));
  const k = stagingEase(a, b, progress);
  const facing = a.facing ?? figure.facing ?? 0;
  const turn = ((b.facing ?? facing) - facing + 540) % 360 - 180;
  // Absent controls retain previously authored linear motion. New marks explicitly opt into
  // the shared path with zero ease, while two-point moves remain straight lines.
  const spline = keys.some(key => key.easeIn !== undefined || key.easeOut !== undefined || key.hold !== undefined);
  const [x, y, z] = spline ? stagePathPoint(keys.map(key => [key.x, key.y ?? figure.y ?? 0, key.z]), index, k) : [
    a.x + (b.x - a.x) * k,
    (a.y ?? figure.y ?? 0) + ((b.y ?? figure.y ?? 0) - (a.y ?? figure.y ?? 0)) * k,
    a.z + (b.z - a.z) * k,
  ];
  return { x: x!, y: y!, z: z!, facing: facing + turn * k, pose: a.pose ?? figure.pose ?? "stand" };
}

/** Write-boundary checks; permissive legacy reading must not admit new unusable camera data. */
export function stageProblems(staging: ResolvedShotStaging, durationSec: number): string[] {
  const problems: string[] = [];
  const ids = new Set(staging.cast.map(f => f.sheetId));
  const groups = new Set(staging.sets.flatMap(set=>set.group?[set.group]:[]));
  const targets = new Set([...ids,...groups]);
  if ([...groups].some(group=>ids.has(group))) problems.push("Object group names must differ from figure identities.");
  if (ids.size !== staging.cast.length) problems.push("Each figure must have a unique sheet identity.");
  if (staging.keys.length < 1 || staging.keys[0]?.t !== 0 || (staging.keys.length > 1 && staging.keys.at(-1)?.t !== durationSec)) problems.push("Camera keys must cover the shot from 0 to its duration.");
  const ordered = (keys: readonly { t: number }[]) => keys.length > 0 && keys.every((k, i) => Number.isFinite(k.t) && k.t >= 0 && k.t <= durationSec && (i === 0 || k.t > keys[i - 1]!.t));
  if (!ordered(staging.keys)) problems.push("Camera key times must be strictly increasing within the shot.");
  for (const k of staging.keys) {
    if (![...k.p, ...k.l].every(Number.isFinite)) problems.push("Camera coordinates must be finite.");
    if ((k.anchor && !targets.has(k.anchor)) || (k.track && !targets.has(k.track))) problems.push("Camera anchor or track names a missing figure.");
    const sampled = sampleStageCamera(staging, k.t, durationSec);
    if (Math.hypot(...sampled.p.map((v,i)=>v-sampled.l[i]!)) < 0.01) problems.push("Camera aim must be distinct from its position.");
  }
  for (const set of staging.sets) if (![set.w, set.h, set.d].every(v => Number.isFinite(v) && v > 0)) problems.push("Set dimensions must be positive and finite.");
  for (const figure of staging.cast) if (figure.parent && !groups.has(figure.parent)) problems.push("A figure names a missing parent object.");
  for (const set of staging.sets) if (set.shape === "mesh" && (!set.vertices || !set.triangles || set.triangles.length % 3 !== 0 || set.triangles.some(index=>index >= set.vertices!.length))) problems.push("Mesh geometry needs valid vertices and triangle indices.");
  // Timed action may start late; the evaluator holds its first pose until that mark (#1041).
  for (const motion of staging.objectMotions ?? []) if (!groups.has(motion.group) || !ordered(motion.keys)) problems.push("Object motion must name a group and have ordered keys within the shot.");
  if (new Set(staging.objectMotions?.map(m=>m.group)).size !== (staging.objectMotions?.length??0)) problems.push("An object can have only one motion track.");
  if (new Set(staging.performances?.map(p=>p.sheetId)).size !== (staging.performances?.length??0)) problems.push("A figure can have only one performance track.");
  for (const performance of staging.performances ?? []) {
    if (!ids.has(performance.sheetId) || !ordered(performance.keys)) problems.push("Performance keys must name a figure and increase within the shot.");
  }
  return [...new Set(problems)];
}

export interface StageLineFinding {
  kind: "within-shot" | "across-coverage";
  shotIds: string[];
  pair: [string, string];
  at: number;
  message: string;
}

/** Advisory screen direction at authored camera marks; never a write-boundary refusal (#1045). */
export function stageLineCrossings(scene: SceneRecord, aspect = "16:9", draft?: { shotId: string; staging: ResolvedShotStaging }): StageLineFinding[] {
  const findings: StageLineFinding[] = [];
  const coverage: Array<{ shot: Shot; blocking: string; pair: [string, string]; sides: Array<{ at: number; side: number }> }> = [];
  const ratio = parseAspect(aspect) ?? 16 / 9;
  for (const shot of orderedShots(scene)) {
    const staging = draft?.shotId === shot.id ? draft.staging : shot.staging && resolvedShotStaging(scene, shot.staging);
    if (!staging || staging.cast.length < 2 || !staging.keys.length) continue;
    const duration = shot.durationSec ?? DEFAULT_SHOT_SEC;
    const fov = stagingFov(effectiveFraming(scene, shot).lens, aspect);
    const camera = new PerspectiveCamera(fov, ratio, STAGE_CAMERA_NEAR, 200);
    const cast = [...staging.cast].sort((a, b) => a.sheetId.localeCompare(b.sheetId));
    // Shared blocking naturally has the same value. Identical private copies cover the same
    // action too; a deliberately changed private layout must not be compared with the scene.
    const blocking = JSON.stringify([cast, staging.sets]);
    const samples = staging.keys.map(key => {
      const pose = sampleStageCamera(staging, key.t, duration);
      const lens = stageCameraKeyAt(staging, key.t, duration, fov, ratio);
      camera.fov = lens.focalMm === undefined ? fov : stagingFov(`${lens.focalMm}mm`, aspect);
      camera.updateProjectionMatrix();
      camera.position.set(...pose.p);
      camera.lookAt(new Vector3(...pose.l));
      camera.rotateZ((lens.roll ?? 0) * Math.PI / 180);
      camera.updateMatrixWorld(true);
      return { at: key.t, camera: pose.p, figures: cast.map(figure => {
        const state = stageFigureAt(figure, staging.performances, key.t, duration, staging.objectMotions);
        const point = new Vector3(state.x, state.y + (figure.height ?? 1.8) * (state.pose === "lie" ? .1 : state.pose === "sit" ? .5 : .65), state.z).project(camera);
        return { ...state, visible: Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && point.z >= -1 && point.z <= 1 };
      }) };
    });
    for (let a = 0; a < cast.length - 1; a++) for (let b = a + 1; b < cast.length; b++) {
      if (!samples.some(sample => sample.figures[a]!.visible && sample.figures[b]!.visible)) continue;
      const pair: [string, string] = [cast[a]!.sheetId, cast[b]!.sheetId];
      const sides = samples.flatMap(sample => {
        const first = sample.figures[a]!, second = sample.figures[b]!;
        if (!first.visible || !second.visible) return [];
        const dx = second.x - first.x, dz = second.z - first.z;
        const length = Math.hypot(dx, dz);
        if (length < .05) return [];
        const distance = (dx * (sample.camera[2] - first.z) - dz * (sample.camera[0] - first.x)) / length;
        return Math.abs(distance) < .05 ? [] : [{ at: sample.at, side: Math.sign(distance) }];
      });
      for (let i = 1; i < sides.length; i++) if (sides[i]!.side !== sides[i - 1]!.side) {
        const at = sides[i]!.at;
        findings.push({ kind: "within-shot", shotIds: [shot.id], pair, at,
          message: `180° line: Shot ${shot.number} crosses between ${pair.join(" / ")} by ${at.toFixed(2)}s.` });
      }
      for (const previous of coverage) {
        if (previous.blocking !== blocking || previous.pair[0] !== pair[0] || previous.pair[1] !== pair[1]) continue;
        const opposite = sides.find(side => previous.sides.some(other => other.side !== side.side));
        if (opposite) findings.push({ kind: "across-coverage", shotIds: [previous.shot.id, shot.id], pair, at: opposite.at,
          message: `180° line: Shots ${previous.shot.number} and ${shot.number} cover ${pair.join(" / ")} from opposite sides.` });
      }
      coverage.push({ shot, blocking, pair, sides });
    }
  }
  return findings;
}
