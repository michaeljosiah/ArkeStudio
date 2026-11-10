/**
 * The RIFF/WAVE container, walked and written without Buffer so the client shares it (issue 2824).
 *
 * The coordinator, the voice package, a provider and the client each walked a WAV's chunks or
 * wrote its header by hand, and the two details that bite were written out at every one: a chunk
 * of odd size is followed by a pad byte that is not part of it, and a WAVE_FORMAT_EXTENSIBLE
 * `fmt ` keeps its real format in its sub-format GUID. Those live here once. What a caller accepts
 * — a `data` chunk that runs past the end, one rate and no other, a duplicate chunk — stays the
 * caller's: the walk reports what the file declares and judges none of it.
 */

/** A chunk as its header declares it. */
export interface WavChunk {
  id: string;
  /** Where the chunk's body starts. */
  at: number;
  /** The declared size, which a truncated file can run past the end of the bytes. */
  size: number;
}

export interface WavFormat {
  /** The format tag as written: 1 for integer PCM, 3 for float, 0xFFFE for extensible. */
  tag: number;
  /** What the samples are: the tag, or an extensible chunk's sub-format. */
  code: number;
  channels: number;
  rate: number;
  byteRate: number;
  blockAlign: number;
  bits: number;
}

const fourcc = (bytes: Uint8Array, at: number): string =>
  String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);

/** Whether these bytes open with a RIFF/WAVE header. Says nothing about what follows it. */
export function isRiffWave(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && fourcc(bytes, 0) === "RIFF" && fourcc(bytes, 8) === "WAVE";
}

/**
 * Each chunk after the RIFF/WAVE header whose own 8-byte header fits, in order, stepping over the
 * pad byte an odd size leaves. Call it on bytes `isRiffWave` accepts.
 */
export function* wavChunks(bytes: Uint8Array): Generator<WavChunk> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);
    yield { id: fourcc(bytes, at), at: at + 8, size };
    at += 8 + size + (size % 2);
  }
}

/**
 * The `fmt ` body of `size` bytes at `at`, or null when it is shorter than the 16 bytes every
 * format carries. An extensible chunk names its format in the first two bytes of its sub-format
 * GUID, 24 bytes in; one too short to hold the GUID keeps 0xFFFE as its code, and a caller that
 * cannot read that refuses it.
 */
export function wavFormat(bytes: Uint8Array, at: number, size: number): WavFormat | null {
  if (size < 16 || at + 16 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = view.getUint16(at, true);
  return {
    tag,
    code: tag === 0xfffe && size >= 40 && at + 26 <= bytes.length ? view.getUint16(at + 24, true) : tag,
    channels: view.getUint16(at + 2, true),
    rate: view.getUint32(at + 4, true),
    byteRate: view.getUint32(at + 8, true),
    blockAlign: view.getUint16(at + 12, true),
    bits: view.getUint16(at + 14, true),
  };
}

/**
 * The 44-byte header of a 16-bit integer PCM WAV holding `dataBytes` of samples. A size the
 * container's 32-bit fields cannot hold is refused: written anyway, it wraps into a short file
 * that a player trusts.
 */
export function pcm16WavHeader(dataBytes: number, rate: number, channels: number): Uint8Array {
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0 || dataBytes + 36 > 0xffffffff) {
    throw new RangeError(`A WAV cannot hold ${dataBytes} bytes of audio`);
  }
  const out = new Uint8Array(44);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i); };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return out;
}
