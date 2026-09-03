import type { Shot, ShotStaging, StagingKey } from "./scene.js";
import { parseAspect } from "./manifest.js";

/**
 * The Stage's pure arithmetic: where a fresh staging puts things, what a key list amounts to in
 * words, and the timed beats a prompt can carry. Shared by the client (the viewport and the
 * panel readouts) and the coordinator (the bench prefill), so the numbers a person reads on
 * the panel are the numbers the generator is told.
 *
 * Everything is linear between keys. Ease is a word for the prompt, not a curve the previs
 * draws (the Stage guide, part 4).
 */

const SUPER_35_WIDTH_MM = 24.89;
const SUPER_35_HEIGHT_MM = 18.66;
export const STAGE_FRAME_RATE = 30;

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

/** How far back a shot size stands, in metres, measured to the subject. */
function distanceFor(size: string | undefined, camera: string | undefined): number {
  const words = `${size ?? ""} ${camera ?? ""}`.toLowerCase();
  if (/extreme close|ecu/.test(words)) return 1.4;
  if (/close|mcu|\bcu\b/.test(words)) return 2.4;
  if (/extreme wide|ews/.test(words)) return 10;
  if (/wide|\bws\b/.test(words)) return 6.5;
  return 4;
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

/**
 * A first staging, from nothing but the shot: cast in a loose line facing the lens, one massing
 * box per named location, and a camera move read off the framing words. Deterministic on
 * purpose — the same shot stages the same way twice, so a re-stage is a reset and not a
 * surprise — and every value here is a starting point for the gizmo, not a verdict.
 */
export function stageShot(
  shot: Shot,
  input: { cast: readonly string[]; sets: readonly string[]; durationSec: number; framing?: Shot["framing"] },
): ShotStaging {
  const framing = input.framing ?? shot.framing;
  const cast = input.cast.slice(0, 5).map((sheetId, index) => ({
    sheetId,
    x: round(-1.5 + index * 1.5 - (Math.min(input.cast.length, 5) - 1) * 0.75),
    z: index % 2 === 0 ? 0 : -0.5,
  }));
  const sets = input.sets.slice(0, 2).map((name, index) => ({
    name,
    x: index === 0 ? -3.4 : 4.2,
    z: -3.4,
    w: index === 0 ? 4.4 : 2.6,
    h: index === 0 ? 2.9 : 2.1,
    d: 1.1,
  }));
  const subject = cast[0]?.sheetId ?? null;
  // Anchored keys are offsets from the subject; an unanchored scene stands where the subject
  // would have been, so a castless shot still has a camera somewhere sensible.
  const distance = distanceFor(framing?.size, shot.camera);
  const height = heightFor(framing?.angle);
  const aim: [number, number, number] = [0, subject === null ? 1.1 : 1.25, 0];
  const dur = Math.max(0.5, input.durationSec);
  const move = `${framing?.movement ?? ""} ${shot.camera ?? ""}`.toLowerCase();
  const keys: StagingKey[] =
    /push|dolly in|move in|track in/.test(move)
      ? [key(0, [0, height, distance], aim, subject), key(dur, [0, height, Math.max(1, distance * 0.55)], aim, subject)]
      : /pull|dolly out|move out|track out/.test(move)
        ? [key(0, [0, height, distance], aim, subject), key(dur, [0, height, distance * 1.6], aim, subject)]
        : /orbit|arc|circle/.test(move)
          ? [
              key(0, [-distance * 0.7, height, distance * 0.7], aim, subject),
              key(dur / 2, [0, height, distance], aim, subject),
              key(dur, [distance * 0.7, height, distance * 0.7], aim, subject),
            ]
          : /crane|rise|boom|tilt/.test(move)
            ? [key(0, [0, Math.max(0.6, height - 0.6), distance], aim, subject), key(dur, [0, height + 1.4, distance * 0.9], aim, subject)]
            : /pan|truck|track|follow|lateral/.test(move)
              ? [key(0, [-distance * 0.35, height, distance], aim, subject), key(dur, [distance * 0.35, height, distance], aim, subject)]
              : [key(0, [0, height, distance], aim, subject), key(dur, [0, height, distance], aim, subject)];
  return { version: 1, cast, sets, keys };
}

/** The move in one word, read off what the keys actually do. */
export function stagingMoveWord(keys: readonly StagingKey[], cast: readonly ShotStaging["cast"][number][] = []): string {
  if (keys.length < 2) return "static";
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  const dx = Math.abs(last.p[0] - first.p[0]);
  const dy = Math.abs(last.p[1] - first.p[1]);
  const dz = Math.abs(last.p[2] - first.p[2]);
  if (dx < 0.15 && dy < 0.15 && dz < 0.15) {
    if (keys.length > 2 && sweep(keys) > 50) return "orbit";
    // The same offset from a figure who walks is a camera that walks with them: it holds its
    // frame and crosses the set, which is a tracking shot and not a static one.
    const rides = keys.every((key) => key.anchor !== undefined && cast.find((figure) => figure.sheetId === key.anchor)?.to !== undefined);
    return rides ? "tracking" : "static";
  }
  if (sweep(keys) > 50) return "orbit";
  if (dy >= dx && dy >= dz) return "crane";
  if (dx > dz) return "truck";
  return "dolly";
}

/** Degrees the camera swings around its aim between the first and last key. */
function sweep(keys: readonly StagingKey[]): number {
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  const a = Math.atan2(first.p[0] - first.l[0], first.p[2] - first.l[2]);
  const b = Math.atan2(last.p[0] - last.l[0], last.p[2] - last.l[2]);
  let degrees = (Math.abs(a - b) * 180) / Math.PI;
  if (degrees > 180) degrees = 360 - degrees;
  return degrees;
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
  staging: ShotStaging,
  nameOf: (sheetId: string) => string,
): string[] {
  const facings = new Map<string, readonly [number, number]>();
  for (const figure of staging.cast) {
    if (figure.to === undefined) {
      facings.set(figure.sheetId, [0, 1]);
      continue;
    }
    const dx = figure.to[0] - figure.x;
    const dz = figure.to[1] - figure.z;
    const length = Math.hypot(dx, dz);
    facings.set(figure.sheetId, length < 0.05 ? [0, 1] : [dx / length, dz / length]);
  }
  const lastT = staging.keys.at(-1)?.t ?? 0;
  return staging.keys.map((k) => {
    const subject = k.anchor ?? k.track ?? null;
    // Measured from what the camera is actually on: an anchored key is already an offset from
    // its figure; a key that only TRACKS one is in world space, so the figure is read where it
    // stands at that key's time, not at the aim point the track has overridden.
    const tracked = k.anchor === undefined && k.track !== undefined ? staging.cast.find((figure) => figure.sheetId === k.track) : undefined;
    const standing = tracked === undefined ? null : figureAt(tracked, lastT <= 0 ? 0 : k.t / lastT);
    const [tx, tz] = k.anchor !== undefined ? [0, 0] : standing ?? [k.l[0], k.l[2]];
    const ox = k.p[0] - tx;
    const oz = k.p[2] - tz;
    const flat = Math.hypot(ox, oz).toFixed(1);
    const height = k.p[1].toFixed(2);
    const where = bearing(ox, oz, k.p[1] - k.l[1], facings.get(subject ?? "") ?? [0, 1]);
    const who = subject === null ? "the aim point" : nameOf(subject);
    const aim = k.track === undefined ? "" : `, aimed at ${nameOf(k.track)}`;
    return `${k.t.toFixed(1)}s — ${flat}m ${where} ${who}, ${height}m high${aim}`;
  });
}

/** Where a figure stands a fraction `u` of the way through the shot: on its walk, or where it was put. */
function figureAt(figure: ShotStaging["cast"][number], u: number): [number, number] {
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
export function stagingRetimed(staging: ShotStaging, durationSec: number): ShotStaging {
  if (staging.keys.length === 0) return staging;
  const last = staging.keys.length - 1;
  if (staging.keys[last]!.t === durationSec && staging.keys.every((key, index) => index === last || key.t < durationSec)) return staging;
  // Interior keys that still fit stay where they are; if any no longer does, the whole move is
  // scaled to the new length instead of clamped, so no two keys land on one moment.
  const fits = staging.keys.every((key, index) => index === last || key.t < durationSec);
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
export function stagingPromptClause(staging: ShotStaging, nameOf: (sheetId: string) => string): string {
  const walkers = staging.cast.filter((figure) => figure.to !== undefined).map((figure) => nameOf(figure.sheetId));
  const walk = walkers.length === 0 ? "" : ` ${walkers.join(", ")} ${walkers.length === 1 ? "walks" : "walk"} through the shot.`;
  return [
    `Camera move, ${stagingMoveWord(staging.keys, staging.cast)}, blocked out on the stage (${staging.keys.length} keys).${walk}`,
    ...stagingBeats(staging, nameOf),
  ].join("\n");
}
