import { EFFECT_ANALYSIS_PROFILE, type EffectFeatureData } from "./editor-effect-analysis.js";

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const quantize = (value: number) => Math.round(clamp(value) * 10000) / 10000;

export interface EffectPcmAnalyzer {
  /** Stereo pairs, already reconstructed from the audible bus and resampled by the host. */
  push(samples: Float32Array | Float64Array): void;
  finish(): EffectFeatureData;
}

/**
 * SPEC-053 R-14: bounded state, independent of decoder chunk sizes. Filtering measures each
 * channel before averaging power, so opposed stereo phases cannot erase audible energy.
 */
export function createEffectPcmAnalyzer(input: { frameRate: number; startFrame: number; endFrame: number; profileId?: "audible-pcm-v1" }): EffectPcmAnalyzer {
  const profile = EFFECT_ANALYSIS_PROFILE;
  const { frameRate, startFrame, endFrame } = input;
  if (input.profileId !== undefined && input.profileId !== profile.id) throw new RangeError("Unsupported effect analysis profile");
  if (![24, 25, 30].includes(frameRate) || !Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || startFrame < 0 || endFrame < startFrame || endFrame - startFrame > frameRate * profile.maxSeconds) throw new RangeError("Audio analysis requires a supported whole-frame window up to 30 minutes");
  const perFrame = profile.sampleRate / frameRate;
  const expected = (endFrame - startFrame) * perFrame;
  const energy: number[] = [], bass: number[] = [];
  const low = [0, 0], band = [0, 0];
  // These rational RC coefficients are the v1 definition, not host DSP-library defaults.
  const lowAlpha = 2 * Math.PI * profile.bassLowHz / (profile.sampleRate + 2 * Math.PI * profile.bassLowHz);
  const highAlpha = 2 * Math.PI * profile.bassHighHz / (profile.sampleRate + 2 * Math.PI * profile.bassHighHz);
  let consumed = 0, binSamples = 0, energySquares = 0, bassSquares = 0, finished = false;
  return {
    push(samples) {
      if (finished) throw new Error("Audio analysis has already finished");
      if (samples.length % 2 !== 0) throw new RangeError("Audio analysis needs complete stereo sample pairs");
      if (consumed + samples.length / 2 > expected) throw new RangeError("Decoded PCM extends beyond the frozen analysis window");
      for (let offset = 0; offset < samples.length; offset += 2) {
        for (let channel = 0; channel < 2; channel++) {
          const sample = samples[offset + channel]!;
          if (!Number.isFinite(sample) || Math.abs(sample) > 1_048_576) throw new RangeError("Decoded PCM contains unsupported samples");
          energySquares += sample * sample;
          low[channel]! += lowAlpha * (sample - low[channel]!);
          band[channel]! += highAlpha * ((sample - low[channel]!) - band[channel]!);
          bassSquares += band[channel]! * band[channel]!;
        }
        consumed++; binSamples++;
        if (binSamples === perFrame) {
          const level = quantize(Math.sqrt(energySquares / (perFrame * 2)) / profile.energyReferenceRms);
          energy.push(level);
          // A filter's decaying internal state must not make a cut or silent source react.
          bass.push(level === 0 ? 0 : quantize(Math.sqrt(bassSquares / (perFrame * 2)) / profile.bassReferenceRms));
          binSamples = 0; energySquares = 0; bassSquares = 0;
        }
      }
    },
    finish() {
      if (finished) throw new Error("Audio analysis has already finished");
      if (consumed !== expected || binSamples !== 0) throw new RangeError("Decoded PCM does not cover the frozen analysis window");
      finished = true;
      const beat = Array<number>(energy.length).fill(0), novelty = Array<number>(energy.length).fill(0);
      const history = Math.max(1, Math.round(frameRate * profile.beatMeanMs / 1000));
      let energySum = 0, bassSum = 0;
      for (let index = 0; index < energy.length; index++) {
        const divisor = Math.max(1, Math.min(index, history));
        novelty[index] = energy[index] === 0 ? 0 : Math.max(0, energy[index]! - energySum / divisor * profile.beatRatio, bass[index]! - bassSum / divisor * profile.beatRatio);
        energySum += energy[index]!; bassSum += bass[index]!;
        if (index >= history) { energySum -= energy[index - history]!; bassSum -= bass[index - history]!; }
      }
      const refractory = Math.max(1, Math.ceil(frameRate * profile.beatRefractoryMs / 1000));
      const pulse = Math.max(1, Math.ceil(frameRate * profile.beatPulseMs / 1000));
      const likelyBeats: EffectFeatureData["likelyBeats"] = [];
      let last = -refractory;
      for (let index = 0; index < novelty.length; index++) {
        const value = novelty[index]!;
        if (value < profile.beatThreshold || value <= (novelty[index - 1] ?? 0) || value < (novelty[index + 1] ?? 0) || index - last < refractory) continue;
        const strength = quantize(value * 2);
        likelyBeats.push({ frame: startFrame + index, strength, confidence: quantize((value - profile.beatThreshold) / value) });
        for (let offset = 0; offset < pulse && index + offset < beat.length; offset++) {
          if (energy[index + offset]! > 0) beat[index + offset] = Math.max(beat[index + offset]!, quantize(strength * (1 - offset / pulse)));
        }
        last = index;
      }
      return { features: { startFrame, endFrame, beat, bass, energy }, likelyBeats, silent: energy.every(value => value === 0) };
    },
  };
}
