/** Counter randomness keeps births stable through seeking, trimming and splitting. */
export function effectRandom(seed: number, birthSlot: number, channel: number): number {
  const high = Math.floor(birthSlot / 0x100000000);
  let value = (seed ^ Math.imul(birthSlot | 0, 0x9e3779b1) ^ Math.imul(high | 0, 0x85ebca6b) ^ Math.imul(channel + 1, 0xc2b2ae35)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}
