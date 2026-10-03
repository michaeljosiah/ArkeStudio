import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeWav, encodePcm16Wav, isWavContentType, resample, transcriptionWav, VoxaClient } from "../src/index.js";

/**
 * What `/stt` is sent (SPEC-011 R-17): Voxa's whisper refuses anything but 16 kHz mono 16-bit PCM
 * with a 415, and Gemini returns 24 kHz — the turn 185 probe's grouped reads heard nothing.
 */

const sine = (rate: number, seconds: number, hz: number, amplitude: number) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate));

/** Any WAV the tests need: interleaved channels at a depth and encoding. */
function wav(channels: Float32Array[], rate: number, encoding: "pcm16" | "pcm24" | "float32", extensible = false): Uint8Array {
  const bits = encoding === "pcm16" ? 16 : encoding === "pcm24" ? 24 : 32;
  const width = bits / 8;
  const frames = channels[0]!.length;
  const fmtSize = extensible ? 40 : 16;
  const dataSize = frames * channels.length * width;
  const out = new Uint8Array(12 + 8 + fmtSize + 8 + dataSize);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i); };
  ascii(0, "RIFF");
  view.setUint32(4, out.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, fmtSize, true);
  const code = encoding === "float32" ? 3 : 1;
  view.setUint16(20, extensible ? 0xfffe : code, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels.length * width, true);
  view.setUint16(32, channels.length * width, true);
  view.setUint16(34, bits, true);
  if (extensible) {
    view.setUint16(36, 22, true);
    view.setUint16(38, bits, true);
    view.setUint32(40, 0, true);
    view.setUint16(44, code, true);
  }
  const data = 12 + 8 + fmtSize;
  ascii(data, "data");
  view.setUint32(data + 4, dataSize, true);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels.length; channel++) {
      const at = data + 8 + (frame * channels.length + channel) * width;
      const value = channels[channel]![frame]!;
      if (encoding === "pcm16") view.setInt16(at, Math.round(value * 32767), true);
      else if (encoding === "float32") view.setFloat32(at, value, true);
      else {
        const int = Math.round(value * 8388607);
        out[at] = int & 0xff;
        out[at + 1] = (int >> 8) & 0xff;
        out[at + 2] = (int >> 16) & 0xff;
      }
    }
  }
  return out;
}

const rms = (samples: Float32Array, from = 0, to = samples.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
};

/** Sign changes of a tone, which count its cycles twice. */
const crossings = (samples: Float32Array, from: number, to: number) => {
  let count = 0;
  for (let i = from + 1; i < to; i++) if ((samples[i - 1]! < 0) !== (samples[i]! < 0)) count += 1;
  return count;
};

/** The WAV whisper takes, and its samples. */
function assertWhisperWav(bytes: Uint8Array, seconds: number): Float32Array {
  const decoded = decodeWav(bytes);
  assert.ok(decoded, "a readable WAV");
  assert.equal(decoded.rate, 16_000);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.encoding, "pcm16");
  assert.equal(bytes.length, 44 + decoded.mono.length * 2, "a plain 44-byte header");
  assert.ok(Math.abs(decoded.mono.length - seconds * 16_000) <= 1, `${decoded.mono.length} samples for ${seconds} s`);
  return decoded.mono;
}

describe("the WAV whisper takes (R-17)", () => {
  it("resamples 24 kHz mono to 16 kHz with the tone's pitch and level kept", async () => {
    const out = assertWhisperWav(await transcriptionWav(wav([sine(24_000, 1, 1000, 0.5)], 24_000, "pcm16")), 1);
    // Away from the edges, where the filter runs past the audio.
    assert.ok(Math.abs(rms(out, 800, 15_200) - 0.5 / Math.SQRT2) < 0.005, `level ${rms(out, 800, 15_200)}`);
    assert.ok(Math.abs(crossings(out, 800, 15_200) - 2 * 1000 * (14_400 / 16_000)) <= 2, "1 kHz is still 1 kHz");
  });

  it("folds 48 kHz stereo to one channel", async () => {
    const left = sine(48_000, 0.5, 440, 0.6);
    const right = new Float32Array(left.length);
    const out = assertWhisperWav(await transcriptionWav(wav([left, right], 48_000, "pcm16")), 0.5);
    assert.ok(Math.abs(rms(out, 400, 7_600) - 0.3 / Math.SQRT2) < 0.005, "the channels averaged");
  });

  it("reads 32-bit float, 24-bit and extensible WAVs at 44.1 kHz and 48 kHz", async () => {
    const tone = sine(48_000, 0.75, 300, 0.4);
    assertWhisperWav(await transcriptionWav(wav([tone], 48_000, "float32")), 0.75);
    assertWhisperWav(await transcriptionWav(wav([tone], 48_000, "float32", true)), 0.75);
    assertWhisperWav(await transcriptionWav(wav([sine(44_100, 2, 300, 0.4)], 44_100, "pcm24")), 2);
    assertWhisperWav(await transcriptionWav(wav([sine(8_000, 1, 300, 0.4)], 8_000, "pcm16")), 1);
  });

  it("keeps what lies above 8 kHz from folding back under it", () => {
    // 10 kHz at 48 kHz decimated by taking every third sample reads as a 6 kHz tone at full level;
    // 9 kHz at 24 kHz interpolated linearly reads as 7 kHz. Filtered, both are gone.
    for (const [rate, hz] of [[48_000, 10_000], [24_000, 9_000], [44_100, 12_000]] as const) {
      const out = resample(sine(rate, 1, hz, 0.5), rate, 16_000);
      const level = 20 * Math.log10(rms(out, 800, 15_200) / (0.5 / Math.SQRT2));
      assert.ok(level < -55, `${hz} Hz at ${rate} Hz leaks at ${level.toFixed(1)} dB`);
    }
    // And speech's own band passes.
    const kept = resample(sine(48_000, 1, 6_000, 0.5), 48_000, 16_000);
    assert.ok(Math.abs(rms(kept, 800, 15_200) - 0.5 / Math.SQRT2) < 0.01, "6 kHz passes");
  });

  it("returns 16 kHz mono 16-bit PCM, and what is not a WAV it reads, as it came", async () => {
    const ready = encodePcm16Wav(sine(16_000, 0.5, 500, 0.3), 16_000);
    assert.equal(await transcriptionWav(ready), ready);
    const notWav = new TextEncoder().encode("ID3 not a wav at all");
    assert.equal(await transcriptionWav(notWav), notWav);
    assert.ok(isWavContentType("audio/wav"));
    assert.ok(isWavContentType("Audio/X-WAV; codecs=1"));
    assert.ok(!isWavContentType("audio/webm;codecs=opus"));
  });
});

describe("the client sends /stt what it accepts (R-17)", () => {
  /** A sidecar that answers as Voxa does: 415 to any WAV that is not 16 kHz mono 16-bit PCM. */
  const voxa = (seen: Array<{ type: string; body: Uint8Array }>) => async (_url: string, init?: RequestInit) => {
    const type = String((init!.headers as Record<string, string>)["Content-Type"]);
    const body = new Uint8Array(init!.body as Buffer);
    seen.push({ type, body });
    if (isWavContentType(type)) {
      const decoded = decodeWav(body);
      if (decoded === null || decoded.rate !== 16_000 || decoded.channels !== 1 || decoded.encoding !== "pcm16") {
        return new Response(JSON.stringify({ detail: "WAV input must be 16 kHz mono PCM16." }), { status: 415 });
      }
    }
    return new Response(JSON.stringify({ text: "heard" }), { status: 200 });
  };

  it("transcribes Gemini's 24 kHz WAV, which the sidecar refused before", async () => {
    const seen: Array<{ type: string; body: Uint8Array }> = [];
    const client = new VoxaClient(voxa(seen), "http://127.0.0.1:9");
    assert.equal(await client.transcribe(wav([sine(24_000, 1, 220, 0.3)], 24_000, "pcm16"), "audio/wav"), "heard");
    assert.equal(decodeWav(seen[0]!.body)?.rate, 16_000);
  });

  it("sends audio that is not WAV exactly as it came", async () => {
    const seen: Array<{ type: string; body: Uint8Array }> = [];
    const client = new VoxaClient(voxa(seen), "http://127.0.0.1:9");
    const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
    assert.equal(await client.transcribe(webm, "audio/webm"), "heard");
    assert.equal(seen[0]!.type, "audio/webm");
    assert.deepEqual(seen[0]!.body, webm);
  });
});
