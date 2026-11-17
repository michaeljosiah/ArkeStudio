/*
 * A song's beats and where a voice is in it (epic #3070, `song_map`).
 *
 * The music video was cut to a beat grid worked out by hand, and its first sections were timed in
 * another program because nothing here could hear the song (#3099). A fixed grid is not enough to
 * cut on: the hand grid's period was 2 ms short of the song's 0.600 s, and away from where it was
 * fitted its beats drifted up to half a beat; the song's overall pulse put them a quarter of a
 * second off. So the beats here are tracked: an onset curve from spectral flux in 10 ms steps, a tempo from how that
 * curve repeats (weighed toward 120 bpm, as listeners do), then dynamic programming that keeps each
 * beat near one period from the last while landing it on an onset (Ellis, "Beat Tracking by Dynamic
 * Programming", 2007). Sections come from the Studio's own finder (`findSongSections`), so Arke
 * and the Cut never disagree about where a song changes.
 */

export const SONG_MAP_PROFILE = Object.freeze({
  /** Mono decode rate for beats and voice: an onset curve needs no more. */
  rate: 16000, fftSize: 1024, hop: 160,
  minBpm: 60, maxBpm: 200, priorBpm: 120, priorOctaves: 1,
  /** Ellis's tightness: how hard a beat is held to one period from the last. */
  tightness: 100,
  /** Voice map: 100 ms steps; a gap shorter than this is one phrase, a run shorter than that is a breath. */
  voiceStepSec: .1, voiceMergeSec: .6, voiceMinSec: .3,
  /** A step counts as voice above the louder of this floor and 30 dB under the voice's usual loud level. */
  voiceFloorDbfs: -50, voiceRangeDb: 30,
});

/** In-place iterative radix-2 FFT of a power-of-two complex buffer. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k, b = a + size / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti; re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const next = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = next;
      }
    }
  }
}

/** Bin ranges of `count` bands equally spaced in mel from 30 Hz to half the rate. */
function melBands(count: number): Array<[number, number]> {
  const { rate, fftSize } = SONG_MAP_PROFILE, mel = (hz: number) => 2595 * Math.log10(1 + hz / 700), hz = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const low = mel(30), high = mel(rate / 2), bands: Array<[number, number]> = [];
  for (let b = 0; b < count; b++) {
    const from = Math.floor(hz(low + (high - low) * b / count) * fftSize / rate), to = Math.floor(hz(low + (high - low) * (b + 1) / count) * fftSize / rate);
    bands.push([from, Math.max(from + 1, to)]);
  }
  return bands;
}

/**
 * Spectral flux of log band magnitudes, one value per hop, frame t centred on sample t * hop.
 * Bands are mel-spaced, as listeners hear pitch: on plain FFT bins everything above 1 kHz, where
 * the hi-hats are, fills most of the bins and outvotes the kick and bass that carry the beat.
 */
export function onsetCurve(samples: Float32Array): Float64Array {
  const { fftSize, hop } = SONG_MAP_PROFILE, bands = melBands(40);
  const frames = Math.max(0, Math.floor(samples.length / hop));
  const window = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) window[i] = .5 - .5 * Math.cos(2 * Math.PI * i / fftSize);
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  let previous = new Float64Array(bands.length), current = new Float64Array(bands.length);
  const curve = new Float64Array(frames);
  for (let t = 0; t < frames; t++) {
    const centre = t * hop;
    for (let i = 0; i < fftSize; i++) {
      const at = centre - fftSize / 2 + i;
      re[i] = at >= 0 && at < samples.length ? samples[at]! * window[i]! : 0; im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let b = 0; b < bands.length; b++) {
      const [from, to] = bands[b]!; let sum = 0;
      for (let k = from; k < to; k++) sum += re[k]! * re[k]! + im[k]! * im[k]!;
      current[b] = 10 * Math.log10(1e-10 + sum / (to - from));
      if (t > 0) flux += Math.max(0, current[b]! - previous[b]!);
    }
    curve[t] = flux / bands.length;
    [previous, current] = [current, previous];
  }
  return curve;
}

/** The beat period in hops (fractional), from the onset curve's autocorrelation under a tempo prior; null when nothing repeats. */
export function estimatePeriod(curve: Float64Array): number | null {
  const { rate, hop, minBpm, maxBpm, priorBpm, priorOctaves } = SONG_MAP_PROFILE, perSec = rate / hop;
  const shortest = Math.floor(60 * perSec / maxBpm), longest = Math.ceil(60 * perSec / minBpm);
  if (curve.length < longest * 4) return null;
  let mean = 0;
  for (const value of curve) mean += value;
  mean /= curve.length;
  const centred = curve.map(value => value - mean), ac = new Float64Array(longest + 2);
  for (let lag = 0; lag <= longest + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < centred.length; i++) sum += centred[i]! * centred[i + lag]!;
    ac[lag] = sum / (centred.length - lag);
  }
  if (!(ac[0]! > 0)) return null;
  let best = -Infinity, lag = 0;
  for (let candidate = shortest; candidate <= longest; candidate++) {
    const bpm = 60 * perSec / candidate, weight = Math.exp(-.5 * (Math.log2(bpm / priorBpm) / priorOctaves) ** 2);
    if (ac[candidate]! * weight > best) { best = ac[candidate]! * weight; lag = candidate; }
  }
  if (ac[lag]! / ac[0]! < .05) return null;
  // Between the sampled lags, at the top of the parabola through the peak and its neighbours.
  const a = ac[lag - 1]!, b = ac[lag]!, c = ac[lag + 1]!, bend = a - 2 * b + c;
  return bend < 0 ? lag + .5 * (a - c) / bend : lag;
}

/** Beats in hops: each near one period from the last and on an onset, by dynamic programming. */
export function trackBeats(curve: Float64Array, period: number): number[] {
  const n = curve.length;
  if (!n || !(period > 1)) return [];
  let mean = 0, squares = 0;
  for (const value of curve) { mean += value; squares += value * value; }
  mean /= n;
  const deviation = Math.sqrt(Math.max(1e-12, squares / n - mean * mean));
  // The onset curve smoothed over a little of a beat, so a beat may land a step either side of a peak.
  const spread = Math.max(1, Math.round(period / 32)), local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let sum = 0, weights = 0;
    for (let o = -spread * 3; o <= spread * 3; o++) {
      const at = t + o; if (at < 0 || at >= n) continue;
      const w = Math.exp(-.5 * (o / spread) ** 2); sum += w * curve[at]! / deviation; weights += w;
    }
    local[t] = sum / weights;
  }
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  const near = Math.round(period / 2), far = Math.round(period * 2), { tightness } = SONG_MAP_PROFILE;
  for (let t = 0; t < n; t++) {
    let best = 0, from = -1;
    for (let tau = t - far; tau <= t - near; tau++) {
      if (tau < 0) continue;
      const value = score[tau]! - tightness * Math.log((t - tau) / period) ** 2;
      if (from < 0 || value > best) { best = value; from = tau; }
    }
    score[t] = local[t]! + (from >= 0 ? Math.max(0, best) : 0);
    back[t] = from >= 0 && best > 0 ? from : -1;
  }
  // The last beat: the best-scoring step within a period of the end that is a local peak.
  let last = n - 1, top = -Infinity;
  for (let t = Math.max(1, n - Math.round(period)); t < n - 1; t++) {
    if (score[t]! >= score[t - 1]! && score[t]! >= score[t + 1]! && score[t]! > top) { top = score[t]!; last = t; }
  }
  const beats: number[] = [];
  for (let t = last; t >= 0; t = back[t]!) beats.push(t);
  beats.reverse();
  // A song's quiet opening and fade carry the grid on into silence; beats there are not heard.
  let rms = 0;
  for (const t of beats) rms += local[t]! ** 2;
  rms = Math.sqrt(rms / Math.max(1, beats.length));
  let start = 0, end = beats.length;
  while (start < end && local[beats[start]!]! < .5 * rms) start++;
  while (end > start && local[beats[end - 1]!]! < .5 * rms) end--;
  return beats.slice(start, end);
}

/** RMS level in dBFS of each `stepSec` step; silence is -120. */
export function stepLevels(samples: Float32Array, rate: number, stepSec: number): Float64Array {
  const size = Math.max(1, Math.round(rate * stepSec)), steps = Math.floor(samples.length / size), out = new Float64Array(steps);
  for (let s = 0; s < steps; s++) {
    let sum = 0;
    for (let i = s * size; i < (s + 1) * size; i++) sum += samples[i]! * samples[i]!;
    out[s] = sum > 0 ? Math.max(-120, 10 * Math.log10(sum / size)) : -120;
  }
  return out;
}

/** Where a voice is heard in a vocal stem, as [start, end) seconds, and the level it was cut at. */
export function voiceIntervals(samples: Float32Array, rate: number): { intervals: Array<{ startSec: number; endSec: number }>; thresholdDbfs: number } {
  const { voiceStepSec: step, voiceMergeSec, voiceMinSec, voiceFloorDbfs, voiceRangeDb } = SONG_MAP_PROFILE;
  const levels = stepLevels(samples, rate, step), heard = Array.from(levels).filter(level => level > -100).sort((a, b) => a - b);
  // The voice's usual loud level: the 95th percentile of what is heard at all.
  const loud = heard.length ? heard[Math.min(heard.length - 1, Math.floor(heard.length * .95))]! : -120;
  const threshold = Math.max(voiceFloorDbfs, loud - voiceRangeDb), runs: Array<[number, number]> = [];
  for (let s = 0; s < levels.length; s++) {
    if (levels[s]! <= threshold) continue;
    const previous = runs[runs.length - 1];
    if (previous && (s - previous[1]) * step < voiceMergeSec) previous[1] = s + 1; else runs.push([s, s + 1]);
  }
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { thresholdDbfs: Math.round(threshold * 10) / 10,
    intervals: runs.filter(([a, b]) => (b - a) * step >= voiceMinSec).map(([a, b]) => ({ startSec: round(a * step), endSec: round(b * step) })) };
}

/** Beats in seconds and the tempo they keep, from mono samples at the profile rate. */
export function songBeats(samples: Float32Array): { beatsSec: number[]; tempoBpm: number | null } {
  const { rate, hop } = SONG_MAP_PROFILE, curve = onsetCurve(samples), period = estimatePeriod(curve);
  if (period === null) return { beatsSec: [], tempoBpm: null };
  // The tempo from the fractional period, not from the beats' whole-step gaps, which hide a 0.3 bpm difference.
  return { beatsSec: trackBeats(curve, period).map(beat => Math.round(beat * hop / rate * 1000) / 1000), tempoBpm: Math.round(600 * rate / hop / period) / 10 };
}
