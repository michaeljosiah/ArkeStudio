import type { EffectClip } from "./editor-effects.js";
import type { EffectParticle } from "./editor-effect-evaluator.js";
import { effectRandom } from "./editor-effect-random.js";
import { preparedEffectExtraSpeedSeconds, preparedEffectModulationAt, type PreparedEffectReaction } from "./editor-effect-reaction.js";

/** SPEC-055 R-4: two overlapping finite cohorts bound cold seeks independently of song length. */
export const AIR_PARTICLE_PROFILE = Object.freeze({ id: "air-particles-v1", stepHz: 60, lifetimeSeconds: 12,
  cohortSeconds: 6, particlesPerCohort: 512, maxParticles: 1024, preRollSeconds: 1.5,
  maxSimulationSteps: 2200, maxCacheBytes: 32 * 1024 * 1024, maxCacheEntries: 8 });
const { stepHz: HZ, lifetimeSeconds: LIFE, cohortSeconds: PERIOD } = AIR_PARTICLE_PROFILE;
const DT = 1 / HZ, TAU = Math.PI * 2;
const clamp = (n: number, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const smooth = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t); };
interface Particle { x: number; y: number; z: number; r: number; a: number; phase: number; turn: number; frequency: number; aspect: number; focus: number; rim: number; band: number }
interface Simulation { samples: Float32Array[]; count: number; rows: Particle[]; extend: (step: number) => void }
const simulations = new Map<string, Simulation>();

function population(seed: number, cohort: number, count: number): Particle[] {
  return Array.from({ length: count }, (_, i) => {
    const r = (channel: number) => effectRandom(seed, cohort * 512 + i, channel), z = r(0);
    return { x: r(1), y: r(2), z, r: r(3), a: r(4), phase: r(5) * TAU, turn: r(6) > .5 ? 1 : -1,
      frequency: r(7), aspect: .74 + r(8) * .48, focus: r(9), rim: r(10), band: z < .28 ? 0 : z < .82 ? 1 : 2 };
  });
}
const radiusOf = (p: Particle) => p.band === 0 ? .6 + p.r * 1.25 : p.band === 1 ? 2.4 + p.r * 4.2 : 4 + p.r * 4.5;

function simulation(effect: EffectClip, cohort: number, count: number, aspect: number): Simulation {
  const height = 540 / Math.min(1, aspect), width = height * aspect, rows = population(effect.seed, cohort, count);
  const x = new Float64Array(count), y = new Float64Array(count), vx = new Float64Array(count), vy = new Float64Array(count);
  const radii = new Float64Array(count), heading = new Float64Array(count), wallX = new Float64Array(count), wallY = new Float64Array(count);
  const area = effect.motion.area, airflow = effect.motion.airflow ?? .5, depth = effect.appearance.depth ?? .6;
  const bounce = (effect.motion.boundary ?? "soft-bounce") === "soft-bounce", contacts = effect.motion.particleDeflections ?? true;
  const direction = effect.motion.direction / 360 * TAU;
  const angle = (i: number, t: number) => rows[i]!.phase + direction + heading[i]! + airflow * 2 *
    (t * rows[i]!.turn * (.25 + rows[i]!.frequency * .55) + .5 * Math.sin(t * (.24 + rows[i]!.frequency * .31) + rows[i]!.z * TAU));
  const flow = (i: number, t: number): [number, number] => {
    const p = rows[i]!, d = 1 + (p.band - 1) * .2 * depth / .6;
    const ax = Math.PI * x[i]! / width, ay = Math.PI * y[i]! / height;
    const a = 12 * Math.sin(t * .31), b = 8 * Math.cos(t * .43), headingAngle = angle(i, t);
    // A divergence-free shared field and independent headings avoid persistent density sinks.
    let fx = d * (19 * Math.cos(headingAngle) + airflow * 2 * (a * Math.sin(ax) * Math.cos(ay) + b * Math.sin(2 * ax) * Math.cos(2 * ay)));
    let fy = d * (19 * Math.sin(headingAngle) - airflow * 2 * height / width *
      (a * Math.cos(ax) * Math.sin(ay) + b * Math.cos(2 * ax) * Math.sin(2 * ay)));
    if (t < wallX[i]!) fx = Math.sign(width / 2 - x[i]!) * Math.abs(fx);
    if (t < wallY[i]!) fy = Math.sign(height / 2 - y[i]!) * Math.abs(fy);
    const speed = Math.hypot(fx, fy), scale = speed > 90 ? 90 / speed : 1;
    return [fx * scale, fy * scale];
  };
  for (let i = 0; i < count; i++) {
    const p = rows[i]!, cell = i * 197 % 512;
    radii[i] = Math.min(Math.min(width, height) / 4, Math.max(.7, radiusOf(p) * effect.appearance.size / .55 * .62));
    x[i] = (area.x + ((cell % 32 + p.x) / 32) * area.width) * width;
    y[i] = (area.y + ((Math.floor(cell / 32) + p.y) / 16) * area.height) * height;
    [vx[i], vy[i]] = flow(i, 0);
  }
  let stepNumber = 0;
  const samples: Float32Array[] = [];
  function step() {
    const time = stepNumber * DT;
    for (let i = 0; i < count; i++) {
      const [tx, ty] = flow(i, time);
      vx[i] = vx[i]! + (tx - vx[i]!) * 1.65 * DT; vy[i] = vy[i]! + (ty - vy[i]!) * 1.65 * DT;
      x[i] = x[i]! + vx[i]! * DT; y[i] = y[i]! + vy[i]! * DT;
    }
    if (contacts) {
      const buckets = new Map<string, number[]>(), cellSize = 32;
      for (let i = 0; i < count; i++) {
        const key = `${rows[i]!.band}:${Math.floor(x[i]! / cellSize)}:${Math.floor(y[i]! / cellSize)}`;
        const bucket = buckets.get(key); if (bucket) bucket.push(i); else buckets.set(key, [i]);
      }
      for (let i = 0; i < count; i++) {
        const cx = Math.floor(x[i]! / cellSize), cy = Math.floor(y[i]! / cellSize);
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          for (const j of buckets.get(`${rows[i]!.band}:${cx + ox}:${cy + oy}`) ?? []) {
            if (j <= i || Math.abs(rows[i]!.z - rows[j]!.z) > .16) continue;
            let dx = x[j]! - x[i]!, dy = y[j]! - y[i]!;
            const distance = Math.hypot(dx, dy), limit = radii[i]! + radii[j]!;
            if (distance >= limit) continue;
            if (distance < .00001) { dx = 1; dy = 0; } else { dx /= distance; dy /= distance; }
            const wi = 1 / (radii[i]! * radii[i]!), wj = 1 / (radii[j]! * radii[j]!), sum = wi + wj;
            const overlap = (limit - distance) * .7;
            x[i] = x[i]! - dx * overlap * wi / sum; y[i] = y[i]! - dy * overlap * wi / sum;
            x[j] = x[j]! + dx * overlap * wj / sum; y[j] = y[j]! + dy * overlap * wj / sum;
            const closing = (vx[j]! - vx[i]!) * dx + (vy[j]! - vy[i]!) * dy;
            if (closing < -.05) {
              const impulse = -1.5 * closing / sum;
              vx[i] = vx[i]! - impulse * wi * dx; vy[i] = vy[i]! - impulse * wi * dy;
              vx[j] = vx[j]! + impulse * wj * dx; vy[j] = vy[j]! + impulse * wj * dy;
            }
          }
        }
      }
    }
    for (let i = 0; i < count; i++) {
      const r = radii[i]!;
      if (bounce) {
        if (x[i]! < r || x[i]! > width - r) {
          const inward = x[i]! < r ? 1 : -1; x[i] = clamp(x[i]!, r, width - r);
          if (vx[i]! * inward < 0) { vx[i] = vx[i]! * -.68; heading[i] = heading[i]! + Math.PI - 2 * angle(i, time); wallX[i] = time + .65; }
        }
        if (y[i]! < r || y[i]! > height - r) {
          const inward = y[i]! < r ? 1 : -1; y[i] = clamp(y[i]!, r, height - r);
          if (vy[i]! * inward < 0) { vy[i] = vy[i]! * -.68; heading[i] = heading[i]! - 2 * angle(i, time); wallY[i] = time + .65; }
        }
      } else {
        if (x[i]! < -35) x[i] = x[i]! + width + 70; if (x[i]! > width + 35) x[i] = x[i]! - width - 70;
        if (y[i]! < -35) y[i] = y[i]! + height + 70; if (y[i]! > height + 35) y[i] = y[i]! - height - 70;
      }
      const speed = Math.hypot(vx[i]!, vy[i]!); if (speed > 90) { vx[i] = vx[i]! * 90 / speed; vy[i] = vy[i]! * 90 / speed; }
    }
    stepNumber++;
  }
  const capture = () => { const data = new Float32Array(count * 2); for (let i = 0; i < count; i++) { data[i * 2] = x[i]! / width; data[i * 2 + 1] = y[i]! / height; } samples.push(data); };
  for (let i = 0; i < HZ * AIR_PARTICLE_PROFILE.preRollSeconds; i++) step(); capture();
  return { samples, rows, count, extend(index) {
    if (index > AIR_PARTICLE_PROFILE.maxSimulationSteps) throw new RangeError("Air Particles motion exceeds the bounded seek profile");
    while (samples.length <= index) { step(); capture(); }
  } };
}

function positions(effect: EffectClip, cohort: number, count: number, aspect: number, seconds: number) {
  const key = JSON.stringify([effect.seed, cohort, count, aspect, effect.appearance.size, effect.appearance.depth ?? .6,
    effect.motion.area, effect.motion.direction, effect.motion.airflow ?? .5, effect.motion.particleDeflections ?? true, effect.motion.boundary ?? "soft-bounce"]);
  let value = simulations.get(key);
  if (!value) value = simulation(effect, cohort, count, aspect);
  simulations.delete(key); simulations.set(key, value);
  const sample = Math.max(0, seconds * HZ), index = Math.floor(sample), fraction = sample - index;
  value.extend(index + (fraction > 1e-9 ? 1 : 0));
  const bytes = () => [...simulations.values()].reduce((sum, row) => sum + row.count * 2 * 4 * row.samples.length, 0);
  while (simulations.size > AIR_PARTICLE_PROFILE.maxCacheEntries || bytes() > AIR_PARTICLE_PROFILE.maxCacheBytes) simulations.delete(simulations.keys().next().value!);
  const a = value.samples[index]!, b = value.samples[index + 1] ?? a;
  return { rows: value.rows, at: (i: number, axis: number) => {
    const from = a[i * 2 + axis]!, to = b[i * 2 + axis]!;
    return Math.abs(to - from) > .3 ? from : from + (to - from) * fraction;
  } };
}

export function airParticlesAt(effect: EffectClip, absoluteFrame: number, frameRate: number, aspect: number, visibility: number,
  prepared: PreparedEffectReaction | undefined, colour: readonly [number, number, number]): EffectParticle[] {
  const phase = (absoluteFrame - effect.simulationOriginFrame) / frameRate;
  const newest = Math.floor(phase / PERIOD), particles: EffectParticle[] = [];
  const modulation = prepared ? preparedEffectModulationAt(prepared, absoluteFrame) : 0;
  const size = clamp(effect.appearance.size + (effect.reaction.property === "size" ? modulation : 0));
  for (let cohort = newest - 1; cohort <= newest; cohort++) {
    if (!Number.isSafeInteger(cohort * 512)) throw new RangeError("Air Particles phase exceeds the supported clock");
    const birth = cohort * PERIOD, age = phase - birth;
    if (age < 0 || age >= LIFE) continue;
    const birthFrame = effect.simulationOriginFrame + Math.floor(birth * frameRate);
    const emission = prepared && effect.reaction.property === "emission" ? preparedEffectModulationAt(prepared, birthFrame) : 0;
    const count = Math.round(512 * clamp(effect.appearance.amount + emission)); if (!count) continue;
    const extra = prepared && effect.reaction.property === "speed" ? preparedEffectExtraSpeedSeconds(prepared, birthFrame, absoluteFrame) : 0;
    const motionSeconds = (age * effect.motion.speed + extra) / .35;
    const state = positions(effect, cohort, count, aspect, motionSeconds);
    const life = smooth(age / 1.5) * smooth((LIFE - age) / 1.5);
    for (let i = 0; i < count; i++) {
      const p = state.rows[i]!, focusShift = Math.sin(motionSeconds * .17 + p.phase) * .17 * (effect.appearance.depth ?? .6) / .6;
      const breathing = .72 + .28 * Math.sin(motionSeconds * .22 + p.z * TAU) ** 2;
      const brightness = (p.band === 0 ? .01 + p.a * .05 : p.band === 1 ? .03 + p.a * .22 : .045 + p.a * .255) * breathing * 3.744;
      particles.push({ id: cohort * 512 + i, x: state.at(i, 0), y: state.at(i, 1), radius: radiusOf(p) / 540 * size / .55 * (1 + focusShift),
        stretch: p.aspect, directionX: Math.cos(p.phase), directionY: Math.sin(p.phase), opacity: clamp(visibility * brightness * life), colour, shape: "air-texture",
        texture: effect.appearance.texture ?? .75, softness: clamp(.09 + (effect.appearance.softness ?? .55) * .65 + p.focus * .22 + (p.band === 2 ? .08 : 0) + focusShift * .35, .12, .95),
        textureSeed: effectRandom(effect.seed, cohort * 512 + i, 18) * 0xffffffff >>> 0, rim: p.rim > .8 });
    }
  }
  return particles;
}

/** Disposable state only; used to measure genuinely cold seeks and retained memory. */
export function clearAirParticleCache(): void { simulations.clear(); }
export function airParticleCacheBytes(): number { return [...simulations.values()].reduce((sum, row) => sum + row.count * 8 * row.samples.length, 0); }
