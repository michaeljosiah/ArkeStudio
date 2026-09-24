import type { StageObjectMotion, StagingKey } from "./scene.js";
import { Vector3, CatmullRomCurve3, Euler, Quaternion } from "three";
import { stageFigureAt, stagingEase, stagingFocalForFov, type ResolvedShotStaging } from "./staging.js";

/** Monotone Hermite timing: adjacent legs share one velocity at each passing key.
 * Weighted harmonic tangents follow Fritsch–Butland (1984); flat intervals stay flat.
 */
export function stageCameraScalar(keys: readonly StagingKey[], values: readonly number[], at: number): number {
  if (keys.length < 2) return values[0] ?? 0;
  let leg = 0;
  while (leg < keys.length - 2 && keys[leg + 1]!.t <= at) leg++;
  const h = keys.slice(1).map((key, i) => Math.max(1e-9, key.t - keys[i]!.t));
  const d = h.map((span, i) => (values[i + 1]! - values[i]!) / span);
  const slope = (i: number) => {
    if (i === 0) return d[0]!;
    if (i === keys.length - 1) return d.at(-1)!;
    const before = d[i - 1]!, after = d[i]!;
    if (before * after <= 0) return 0;
    const w1 = 2 * h[i]! + h[i - 1]!, w2 = h[i]! + 2 * h[i - 1]!;
    return (w1 + w2) / (w1 / before + w2 / after);
  };
  const rest = (i: number) => i === 0 || i === keys.length - 1 || d[i - 1] === 0 || d[i] === 0;
  let easeOut = rest(leg) ? keys[leg]!.easeOut ?? 0 : 0;
  let easeIn = rest(leg + 1) ? keys[leg + 1]!.easeIn ?? 0 : 0;
  const overlap = easeOut + easeIn;
  if (overlap > 1) { easeOut /= overlap; easeIn /= overlap; }
  const area = 1 - (easeOut + easeIn) / 2;
  const u = stagingEase({ easeOut }, { easeIn }, (at - keys[leg]!.t) / h[leg]!);
  // Compensate for the rest ramp's faster middle clock. Passing-key velocities then agree
  // with the next leg even when only one of the adjacent legs has an endpoint ramp.
  const m0 = easeOut > 0 ? d[leg]! : slope(leg) * area;
  const m1 = easeIn > 0 ? d[leg]! : slope(leg + 1) * area;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * values[leg]! + (u3 - 2 * u2 + u) * h[leg]! * m0
    + (-2 * u3 + 3 * u2) * values[leg + 1]! + (u3 - u2) * h[leg]! * m1;
}

/** Ease controls apply at the endpoints or a genuine camera hold, never at passing keys. */
export function stageCameraRest(keys: readonly StagingKey[], index: number): boolean {
  const key = keys[index];
  if (!key || index === 0 || index === keys.length - 1) return true;
  const same = (other: StagingKey) => key.anchor === other.anchor && key.anchorSpace === other.anchorSpace
    && key.track === other.track && key.p.every((v, i) => v === other.p[i]) && key.l.every((v, i) => v === other.l[i]);
  return same(keys[index - 1]!) || same(keys[index + 1]!);
}

type CameraPath = { points: number[][]; curve: CatmullRomCurve3; lengths: number[]; distance: number[] };
// Key arrays scope the cache to a draft, and coordinates are checked because callers can edit
// keys in place. Reuse the spatial curve across video frames and whole-path advisory samples.
const cameraPaths = new WeakMap<readonly StagingKey[], Partial<Record<"p" | "l", CameraPath>>>();
function cameraPathPoint(keys: readonly StagingKey[], points: readonly (readonly [number, number, number])[], at: number, channel: "p" | "l"): [number, number, number] {
  if (points.length < 2) return [...(points[0] ?? [0, 0, 0])] as [number, number, number];
  const exact = keys.findIndex(key => key.t === at);
  if (exact >= 0) return [...points[exact]!] as [number, number, number];
  let leg = 0;
  while (leg < keys.length - 2 && keys[leg + 1]!.t <= at) leg++;
  const cache = cameraPaths.get(keys) ?? {};
  let path = cache[channel];
  const samples = 128;
  if (!path || path.points.length !== points.length || path.points.some((point, i) => point.some((v, axis) => v !== points[i]![axis]))) {
    const vectors = points.map(p => new Vector3(...p));
    const curve = new CatmullRomCurve3(vectors, false, "centripetal");
    const divisions = (points.length - 1) * samples;
    curve.arcLengthDivisions = divisions;
    const lengths = curve.getLengths(divisions), distance = [0];
    for (let i = 0; i < points.length - 1; i++) {
      const held = vectors[i]!.distanceToSquared(vectors[i + 1]!) < 1e-12;
      distance.push(distance[i]! + (held ? 0 : lengths[(i + 1) * samples]! - lengths[i * samples]!));
    }
    path = { points: points.map(point => [...point]), curve, lengths, distance };
    cache[channel] = path;
    cameraPaths.set(keys, cache);
  }
  const { curve, lengths, distance } = path;
  const size = distance[leg + 1]! - distance[leg]!;
  if (size === 0) return [...points[leg]!] as [number, number, number];
  const along = (stageCameraScalar(keys, distance, at) - distance[leg]!) / size;
  const localDistance = lengths[leg * samples]! + Math.max(0, Math.min(1, along)) * size;
  return curve.getPointAt(localDistance / lengths.at(-1)!).toArray();
}

/** Sample the whole moving subject path, including between authored camera keys. Advisory only. */
export function stageCameraStandoffWarnings(staging: ResolvedShotStaging, durationSec: number): string[] {
  if (durationSec <= 0 || !staging.keys.length) return [];
  const samples = Math.min(900, Math.max(2, Math.ceil(durationSec * 30)));
  const nearest = new Map<string, { distance: number; at: number }>();
  const moving = staging.cast.filter(figure => figure.to !== undefined || figure.parent !== undefined
    || staging.performances?.some(performance => performance.sheetId === figure.sheetId));
  if (!moving.length) return [];
  for (let i = 0; i <= samples; i++) {
    const at = durationSec * i / samples, camera = sampleStageCamera(staging, at, durationSec);
    for (const figure of moving) {
      const target = stageFigureAt(figure, staging.performances, at, durationSec, staging.objectMotions);
      const distance = Math.hypot(camera.p[0] - target.x, camera.p[1] - (target.y + (figure.height ?? 1.8) * .65), camera.p[2] - target.z);
      if (distance < (nearest.get(figure.sheetId)?.distance ?? Infinity)) nearest.set(figure.sheetId, { distance, at });
    }
  }
  return [...nearest].filter(([, value]) => value.distance < 1.5).map(([id, value]) =>
    `Camera approaches moving @${id} to ${value.distance.toFixed(2)}m at ${value.at.toFixed(2)}s. Keep at least 1.5m through the whole move unless a closer shot is intentional; use an anchored, tracked orbit or follow move.`);
}

/** Flag abrupt sampled motion at passing keys before export; authored holds are intentional. */
export function stageCameraMotionWarnings(staging: ResolvedShotStaging, durationSec: number): string[] {
  const warnings: string[] = [], dt = 1 / 30;
  for (let i = 1; i < staging.keys.length - 1; i++) {
    const at = staging.keys[i]!.t;
    if (stageCameraRest(staging.keys, i) || at < dt || at > durationSec - dt) continue;
    const poses = [at - dt, at, at + dt].map(t => sampleStageCamera(staging, t, durationSec));
    const positions = poses.map(pose => new Vector3(...pose.p));
    const directions = poses.map(pose => new Vector3(...pose.l).sub(new Vector3(...pose.p)).normalize());
    const speedJump = Math.abs(positions[2]!.distanceTo(positions[1]!) - positions[1]!.distanceTo(positions[0]!)) / dt;
    const angularJump = Math.abs(directions[2]!.angleTo(directions[1]!) - directions[1]!.angleTo(directions[0]!)) / dt * 180 / Math.PI;
    if (speedJump > .5 || angularJump > 10) warnings.push(`Camera motion changes sharply near ${at.toFixed(2)}s. Preview the move and spread nearby keys if the change is unintended.`);
  }
  return warnings;
}

/** One arc-length-mapped point on a centripetal spline leg. */
export function stagePathPoint(
  points: readonly (readonly [number, number, number])[],
  leg: number,
  along: number,
): [number, number, number] {
  const vectors = points.map((p) => new Vector3(...p));
  const start = vectors[Math.max(0, Math.min(vectors.length - 1, leg))];
  const end = vectors[Math.max(0, Math.min(vectors.length - 1, leg + 1))];
  if (start === undefined || end === undefined) return [0, 0, 0];
  if (start.distanceToSquared(end) < 1e-12) return [start.x, start.y, start.z];
  if (vectors.length < 3) {
    const point = start.clone().lerp(end, Math.max(0, Math.min(1, along)));
    return [point.x, point.y, point.z];
  }
  const curve = new CatmullRomCurve3(vectors, false, "centripetal");
  const samplesPerLeg = 32;
  const divisions = (vectors.length - 1) * samplesPerLeg;
  curve.arcLengthDivisions = divisions;
  const lengths = curve.getLengths(divisions);
  const first = lengths[Math.max(0, Math.min(lengths.length - 1, leg * samplesPerLeg))]!;
  const last = lengths[Math.max(0, Math.min(lengths.length - 1, (leg + 1) * samplesPerLeg))]!;
  const distance = first + (last - first) * Math.max(0, Math.min(1, along));
  const total = lengths.at(-1) ?? 0;
  const point = curve.getPointAt(total === 0 ? 0 : distance / total);
  return [point.x, point.y, point.z];
}

/** A rigid object's shot-local trajectory. Group geometry is expressed in its local metres. */
export function stageObjectAt(motions: readonly StageObjectMotion[] | undefined, group: string, at: number) {
  const keys = motions?.find((motion) => motion.group === group)?.keys;
  if (!keys?.length)
    return { p: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] };
  let index = 0;
  while (index < keys.length - 2 && keys[index + 1]!.t <= at) index++;
  const a = keys[index]!,
    b = keys[Math.min(index + 1, keys.length - 1)]!;
  const mix = stagingEase(a, b, a.t === b.t ? 0 : (at - a.t) / (b.t - a.t));
  return {
    p: stagePathPoint(
      keys.map((key) => key.p),
      index,
      mix,
    ),
    rotation: [0, 1, 2].map((axis) => {
      const start = a.rotation?.[axis] ?? 0,
        end = b.rotation?.[axis] ?? start;
      return start + (((end - start + 540) % 360) - 180) * mix;
    }) as [number, number, number],
  };
}
export function stageLocalPoint(
  point: readonly [number, number, number],
  transform: ReturnType<typeof stageObjectAt>,
): [number, number, number] {
  return new Vector3(...point)
    .applyEuler(
      new Euler(...(transform.rotation.map((v) => (v * Math.PI) / 180) as [number, number, number])),
    )
    .add(new Vector3(...transform.p))
    .toArray();
}

/** Base pose shared by the viewport, inspection and timed generator guidance. Rig noise is applied by the renderer. */
export function sampleStageCamera(staging: ResolvedShotStaging, at: number, durationSec: number, clock = at) {
  const keys = staging.keys;
  if (!keys.length)
    return { p: [0, 1.5, 4] as [number, number, number], l: [0, 1, 0] as [number, number, number] };
  const subject = (id: string | undefined) =>
    id ? stageTargetTransform(staging, id, clock, durationSec) : null;
  const anchor = subject(keys[0]!.anchor);
  const sharedAnchor = anchor && keys.every(k => k.anchor === keys[0]!.anchor && k.anchorSpace === keys[0]!.anchorSpace)
    ? { ...anchor, rotation: keys[0]!.anchorSpace === "local" ? anchor.rotation : [0, 0, 0] as [number, number, number] } : null;
  // A common translating/rotating anchor preserves arc lengths. Sample in its local space,
  // then move the result with the subject instead of rebuilding that same curve every frame.
  const points = keys.map(k => {
    const transform = sharedAnchor ? null : subject(k.anchor);
    return transform ? stageLocalPoint(k.p, { ...transform, rotation: k.anchorSpace === "local" ? transform.rotation : [0, 0, 0] }) : k.p;
  });
  const position = cameraPathPoint(keys, points, at, "p");
  const tracked = subject(keys[0]!.track);
  let look: [number, number, number];
  if (tracked && keys.every(k => k.track === keys[0]!.track)) {
    look = [tracked.p[0], tracked.p[1] + stageCameraScalar(keys, keys.map(k => k.l[1]), at), tracked.p[2]];
  } else if (sharedAnchor && keys.every(k => k.track === undefined)) {
    look = stageLocalPoint(cameraPathPoint(keys, keys.map(k => k.l), at, "l"), sharedAnchor);
  } else {
    const aim = keys.map(k => {
      const target = subject(k.track), transform = subject(k.anchor);
      if (target) return [target.p[0], target.p[1] + k.l[1], target.p[2]] as [number, number, number];
      return transform ? stageLocalPoint(k.l, { ...transform, rotation: k.anchorSpace === "local" ? transform.rotation : [0, 0, 0] }) : k.l;
    });
    look = cameraPathPoint(keys, aim, at, "l");
  }
  return { p: sharedAnchor ? stageLocalPoint(position, sharedAnchor) : position, l: look };
}

/** Camera targets and editing use the same animated transform as rendering. */
export function stageTargetTransform(
  staging: ResolvedShotStaging,
  id: string,
  at: number,
  durationSec: number,
): ReturnType<typeof stageObjectAt> | null {
  const figure = staging.cast.find((f) => f.sheetId === id);
  if (figure) {
    const state = stageFigureAt(figure, staging.performances, at, durationSec, staging.objectMotions);
    return { p: [state.x, state.y, state.z], rotation: [0, state.facing, 0] };
  }
  return staging.sets.some((s) => s.group === id) ? stageObjectAt(staging.objectMotions, id, at) : null;
}
export function stageWorldPoint(
  point: readonly [number, number, number],
  transform: ReturnType<typeof stageObjectAt>,
): [number, number, number] {
  const rotation = new Quaternion()
    .setFromEuler(
      new Euler(...(transform.rotation.map((v) => (v * Math.PI) / 180) as [number, number, number])),
    )
    .invert();
  return new Vector3(...point)
    .sub(new Vector3(...transform.p))
    .applyQuaternion(rotation)
    .toArray();
}
/** Convert a world-space edit back into an anchored key's coordinates. */
export function stageKeyOffset(
  staging: ResolvedShotStaging,
  key: StagingKey,
  point: readonly [number, number, number],
  at: number,
  durationSec: number,
) {
  const transform = key.anchor ? stageTargetTransform(staging, key.anchor, at, durationSec) : null;
  return transform
    ? stageWorldPoint(point, {
        ...transform,
        rotation: key.anchorSpace === "local" ? transform.rotation : [0, 0, 0],
      })
    : ([...point] as [number, number, number]);
}
export function stageCameraKeyAt(
  staging: ResolvedShotStaging,
  at: number,
  durationSec: number,
  fov = 34,
  aspect = 16 / 9,
): StagingKey {
  const keys = staging.keys;
  if (!keys.length) return { t: at, p: [0, 1.5, 3], l: [0, 1.2, 0] };
  let index = 0;
  while (index < keys.length - 2 && keys[index + 1]!.t <= at) index++;
  const a = keys[index]!,
    b = keys[Math.min(index + 1, keys.length - 1)]!;
  const pose = sampleStageCamera(staging, at, durationSec);
  const { track: _track, ...key } = Math.abs(a.t - at) <= Math.abs(b.t - at) ? a : b;
  const track = a.track === b.track ? a.track : undefined;
  const tracked = track ? stageTargetTransform(staging, track, at, durationSec) : null;
  return {
    ...key,
    t: at,
    p: stageKeyOffset(staging, key, pose.p, at, durationSec),
    l: tracked ? [0, pose.l[1] - tracked.p[1], 0] : stageKeyOffset(staging, key, pose.l, at, durationSec),
    ...(track ? { track } : {}),
    ...(a.roll !== undefined || b.roll !== undefined
      ? { roll: stageCameraScalar(keys, keys.map(k => k.roll ?? 0), at) }
      : {}),
    ...(a.focalMm !== undefined || b.focalMm !== undefined
      ? {
          focalMm: stageCameraScalar(keys, keys.map(k => k.focalMm ?? stagingFocalForFov(fov, aspect)), at),
        }
      : {}),
  };
}
