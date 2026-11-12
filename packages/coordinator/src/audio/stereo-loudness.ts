/** Streaming BS.1770 K weighting and gated integrated loudness, two ordinary stereo channels. */
export class StereoLoudness {
  private readonly filters: Array<(sample: number) => number>;
  private readonly ring: Float64Array;
  private readonly powers: number[] = [];
  private count = 0;
  private sum = 0;
  private peak = 0;
  private readonly step: number;
  constructor(rate = 48000) {
    const biquad = (b: number[], a: number[]) => {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      return (x: number) => {
        const y = b[0]! * x + b[1]! * x1 + b[2]! * x2 - a[1]! * y1 - a[2]! * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return Math.fround(y);
      };
    };
    const channel = () => {
      let k = Math.tan(Math.PI * 1681.974450955533 / rate), q = 0.7071752369554196;
      const vh = 10 ** (3.999843853973347 / 20), vb = vh ** 0.4996667741545416;
      let a0 = 1 + k / q + k * k;
      const shelf = biquad([(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0], [1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]);
      k = Math.tan(Math.PI * 38.13547087602444 / rate); q = 0.5003270373238773; a0 = 1 + k / q + k * k;
      const highpass = biquad([1, -2, 1], [1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]);
      return (sample: number) => highpass(shelf(sample));
    };
    this.filters = [channel(), channel()]; this.ring = new Float64Array(Math.round(rate * 0.4)); this.step = Math.round(rate * 0.1);
  }
  add(left: Float32Array, right: Float32Array): void {
    if (left.length !== right.length) throw new Error("Stereo channels differ in length");
    for (let index = 0; index < left.length; index++) {
      this.peak = Math.max(this.peak, Math.abs(left[index]!), Math.abs(right[index]!));
      const l = this.filters[0]!(left[index]!), r = this.filters[1]!(right[index]!), power = l * l + r * r;
      const at = this.count % this.ring.length;
      this.sum += power - this.ring[at]!; this.ring[at] = power; this.count++;
      if (this.count >= this.ring.length && (this.count - this.ring.length) % this.step === 0) this.powers.push(Math.max(0, this.sum / this.ring.length));
    }
  }
  measure(): { lufs: number | null; peakDb: number | null } {
    const powers = this.count < this.ring.length ? [this.sum / Math.max(1, this.count)] : this.powers;
    const lufs = (power: number) => -0.691 + 10 * Math.log10(power);
    const absolute = powers.filter(power => power > 0 && lufs(power) > -70);
    const relative = lufs(absolute.reduce((sum, power) => sum + power, 0) / absolute.length) - 10;
    const gated = absolute.filter(power => lufs(power) > relative);
    return { lufs: gated.length ? lufs(gated.reduce((sum, power) => sum + power, 0) / gated.length) : null, peakDb: this.peak > 0 ? 20 * Math.log10(this.peak) : null };
  }
}
