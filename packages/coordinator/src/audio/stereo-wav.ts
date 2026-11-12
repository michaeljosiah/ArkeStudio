import { isRiffWave, pcm16WavHeader, wavChunks, wavFormat } from "@arke-studio/contracts";

/** Channel-preserving PCM for Audio Studio. Speech QC's deliberate mono fold stays separate. */
export interface StereoPcm { rate: number; channels: 1 | 2; left: Float32Array; right: Float32Array }

export function readStereoWav(bytes: Uint8Array, maxDecodedBytes = 256 * 1024 * 1024): StereoPcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44 || !isRiffWave(bytes)) throw new Error("Not a PCM WAV");
  let rate = 0, channels = 0, bits = 0, format = 0, alignment = 0;
  let data: { at: number; size: number } | undefined;
  for (const chunk of wavChunks(bytes)) {
    if (chunk.size > bytes.length - chunk.at) throw new Error("The WAV is truncated");
    if (chunk.id === "fmt ") {
      const fmt = wavFormat(bytes, chunk.at, chunk.size);
      if (fmt === null) throw new Error("The WAV format is truncated");
      ({ code: format, channels, rate, blockAlign: alignment, bits } = fmt);
    } else if (chunk.id === "data") data = { at: chunk.at, size: chunk.size };
  }
  if (!data || (channels !== 1 && channels !== 2) || rate < 8000 || rate > 384000 ||
    !((format === 1 && [16, 24, 32].includes(bits)) || (format === 3 && bits === 32)) || alignment !== channels * bits / 8 || data.size % alignment !== 0) throw new Error("Unsupported PCM WAV format");
  const frames = data.size / alignment;
  if (frames * 8 > maxDecodedBytes) throw new Error("The decoded audio exceeds its memory limit");
  const left = new Float32Array(frames), right = new Float32Array(frames);
  const sample = (at: number): number => {
    if (format === 3) { const value = view.getFloat32(at, true); if (!Number.isFinite(value)) throw new Error("The WAV contains non-finite samples"); return value; }
    if (bits === 16) return view.getInt16(at, true) / 32768;
    if (bits === 32) return view.getInt32(at, true) / 2147483648;
    let value = bytes[at]! | bytes[at + 1]! << 8 | bytes[at + 2]! << 16;
    if (value & 0x800000) value |= 0xff000000;
    return value / 8388608;
  };
  for (let frame = 0; frame < frames; frame++) {
    left[frame] = sample(data.at + frame * alignment);
    right[frame] = channels === 1 ? left[frame]! : sample(data.at + frame * alignment + bits / 8);
  }
  return { rate, channels, left, right };
}

export function resampleStereo(pcm: StereoPcm, rate: number): StereoPcm {
  if (pcm.rate === rate) return pcm;
  if (pcm.rate > rate) throw new Error("Downsampling requires the host's band-limited decoder");
  const frames = Math.round(pcm.left.length * rate / pcm.rate);
  const channel = (input: Float32Array) => {
    const out = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      const at = frame * pcm.rate / rate, lo = Math.min(input.length - 1, Math.floor(at)), hi = Math.min(input.length - 1, lo + 1);
      out[frame] = (input[lo] ?? 0) * (1 - (at - lo)) + (input[hi] ?? 0) * (at - lo);
    }
    return out;
  };
  return { rate, channels: pcm.channels, left: channel(pcm.left), right: channel(pcm.right) };
}

/** Header and frames are separate so chapter rendering never allocates the complete output. */
export function stereoWavHeader(frames: number, rate = 48000): Uint8Array {
  if (!Number.isSafeInteger(frames) || frames < 0 || frames * 4 + 36 > 0xffffffff) throw new Error("The chapter exceeds the WAV container's duration limit");
  return pcm16WavHeader(frames * 4, rate, 2);
}
export function stereoWavFrames(left: Float32Array, right: Float32Array, gain = 1): Uint8Array {
  if (left.length !== right.length) throw new Error("Stereo channels differ in length");
  const out = Buffer.alloc(left.length * 4);
  for (let frame = 0; frame < left.length; frame++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[frame]! * gain * 32768))), frame * 4);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[frame]! * gain * 32768))), frame * 4 + 2);
  }
  return out;
}
export function writeStereoWav(pcm: StereoPcm): Uint8Array { return Buffer.concat([stereoWavHeader(pcm.left.length, pcm.rate), stereoWavFrames(pcm.left, pcm.right)]); }
