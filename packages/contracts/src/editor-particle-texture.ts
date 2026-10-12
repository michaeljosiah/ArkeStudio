import { effectRandom } from "./editor-effect-random.js";
const SIZE = 64, count = 32, textures = new Map<number, Float32Array>();
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (v: number) => { const t = clamp(v); return t * t * (3 - 2 * t); };
function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), tx = smooth(x - ix), ty = smooth(y - iy);
  const at = (a: number, b: number) => effectRandom(seed, a * 257 + b, 0);
  return (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
}
function sample(seed: number, x: number, y: number): number {
  const key = seed % count;
  let texture = textures.get(key);
  if (!texture) {
    texture = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) texture[y * SIZE + x] =
      .52 * noise(x / 16, y / 16, key) + .32 * noise(x / 5, y / 5, key + 81) + .16 * noise(x / 1.7, y / 1.7, key + 197);
    textures.set(key, texture);
  }
  const u = clamp(x, 0, SIZE - 1.001), v = clamp(y, 0, SIZE - 1.001), ix = Math.floor(u), iy = Math.floor(v), tx = u - ix, ty = v - iy, p = iy * SIZE + ix;
  return (texture[p]! * (1 - tx) + texture[p + 1]! * tx) * (1 - ty) + (texture[p + SIZE]! * (1 - tx) + texture[p + SIZE + 1]! * tx) * ty;
}
/** Grain travels with a particle; no frame noise and no background texture layer. */
export function airParticleCoverage(x: number, y: number, texture: number, softness: number, seed: number, rim: boolean): number {
  // Coordinates are normalized to the outer halo (1.65 times the nominal disc radius).
  x *= 1.65; y *= 1.65;
  const grainSample = sample(seed, x * 22 + 32, y * 22 + 32);
  const edge = 1 + (.025 + texture * .035) * (grainSample - .5) * 2;
  const d = Math.sqrt(x * x + y * y) / edge;
  if (d >= 1.65) return 0;
  const coverage = 1 - smooth((d - (1 - softness)) / softness), halo = .065 * (1 - smooth(d / 1.65)) ** 2;
  const grain = clamp(1 + texture * 1.9 * (grainSample - .5) * (1 - .35 * softness), .3, 1.65);
  const ring = rim ? texture * .1 * Math.max(0, 1 - Math.abs(d - .70) / .20) : 0;
  return clamp(coverage * grain * (1 - texture * .12) + ring + halo);
}
