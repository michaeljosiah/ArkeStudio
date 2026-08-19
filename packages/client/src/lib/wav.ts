/**
 * Turning what the microphone gave us into something the library will accept (SPEC-022 T-10).
 *
 * `MediaRecorder` produces WebM/Opus and nothing else worth having — there is no browser API that
 * records WAV. The clone library checks magic numbers rather than extensions, deliberately, so a
 * WebM blob renamed `.wav` is refused where it should be. Encoding here is therefore not belt and
 * braces: it is the only way a recording becomes a clip at all.
 *
 * Mono and 16-bit, because the clip is a voice reference rather than a master: a stereo capture of
 * one person speaking is the same signal twice, and it is the frame's byte ceiling that pays.
 */

/** The frame caps `audioBase64` at 8 MB, which is about a minute of mono 44.1 kHz at 16-bit. */
export const MAX_RECORDING_BASE64 = 8_000_000;

/** Encode an `AudioBuffer` as a 16-bit PCM mono WAV. */
export function encodeWav(buffer: AudioBuffer): Uint8Array {
  const samples = downmixToMono(buffer);
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  const byteRate = buffer.sampleRate * 2;
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // uncompressed
  view.setUint16(22, 1, true); // one channel
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true); // block align: one 16-bit sample
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    // Clamp before scaling: a sample fractionally past ±1 wraps to the opposite rail otherwise,
    // which is heard as a click rather than as the clipping it actually is.
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

/** Average the channels. Summing them would clip a loud stereo capture on the way in. */
function downmixToMono(buffer: AudioBuffer): Float32Array {
  const first = buffer.getChannelData(0);
  if (buffer.numberOfChannels === 1) return first;
  const mixed = new Float32Array(first.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < mixed.length; i += 1) mixed[i] = mixed[i]! + data[i]! / buffer.numberOfChannels;
  }
  return mixed;
}

/** Base64 for the wire, in chunks — `String.fromCharCode(...bytes)` blows the argument limit. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Decode whatever the recorder produced, then re-encode it as WAV bytes. */
export async function recordingToWav(blob: Blob): Promise<Uint8Array> {
  const context = new AudioContext();
  try {
    return encodeWav(await context.decodeAudioData(await blob.arrayBuffer()));
  } finally {
    // An AudioContext held open keeps the audio hardware awake for the life of the window.
    await context.close().catch(() => {});
  }
}
