import type { StageObjectMotion, StagingKey } from "./scene.js";
import { Vector3, CatmullRomCurve3, Euler, Quaternion } from "three";
import { stageFigureAt, stagingEase, stagingFocalForFov, type ResolvedShotStaging } from "./staging.js";

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
  let index = 0;
  while (index < keys.length - 2 && keys[index + 1]!.t <= at) index++;
  const a = keys[index]!,
    b = keys[Math.min(index + 1, keys.length - 1)]!;
  const along = stagingEase(a, b, a.t === b.t ? 0 : (at - a.t) / (b.t - a.t));
  const subject = (id: string | undefined) =>
    id ? stageTargetTransform(staging, id, clock, durationSec) : null;
  const points = keys.map((k) => {
    const transform = subject(k.anchor);
    return transform
      ? stageLocalPoint(k.p, {
          ...transform,
          rotation: k.anchorSpace === "local" ? transform.rotation : [0, 0, 0],
        })
      : k.p;
  });
  const aim = (k: typeof a) => {
    const tracked = subject(k.track),
      anchor = subject(k.anchor);
    if (tracked) return new Vector3(tracked.p[0], tracked.p[1] + k.l[1], tracked.p[2]);
    return new Vector3(
      ...(anchor
        ? stageLocalPoint(k.l, {
            ...anchor,
            rotation: k.anchorSpace === "local" ? anchor.rotation : [0, 0, 0],
          })
        : k.l),
    );
  };
  const l = aim(a).lerp(aim(b), along * along * (3 - 2 * along));
  return { p: stagePathPoint(points, index, along), l: [l.x, l.y, l.z] as [number, number, number] };
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
  const mix = stagingEase(a, b, a.t === b.t ? 0 : (at - a.t) / (b.t - a.t));
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
      ? { roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * mix }
      : {}),
    ...(a.focalMm !== undefined || b.focalMm !== undefined
      ? {
          focalMm:
            (a.focalMm ?? stagingFocalForFov(fov, aspect)) +
            ((b.focalMm ?? stagingFocalForFov(fov, aspect)) -
              (a.focalMm ?? stagingFocalForFov(fov, aspect))) *
              mix,
        }
      : {}),
  };
}
