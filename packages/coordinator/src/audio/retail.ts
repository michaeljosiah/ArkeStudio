import type { MediaProcessRunner } from "./media-tools.js";
import { open } from "node:fs/promises";

/** SPEC-047 R-22/R-23. Measure the encoded delivery, not the encoder's intentions.
 * Noise floor is a conservative quiet-window peak estimate (FFmpeg astats, 250 ms),
 * not a substitute for listening for noise, editing errors or narration eligibility. */
export interface RetailMeasurements {
  seconds: number; channels: number; sampleRate: number; codec: string; bitrate: number;
  rmsDb: number; peakDb: number; truePeakDb: number; noiseFloorDb: number;
  headSeconds: number; tailSeconds: number;
}
export interface RetailAudioTools {
  inspect(file: string, signal: AbortSignal, range?: { from: number; to: number }): Promise<RetailMeasurements>;
  encode(input: string, output: string, options: { from: number; to: number; channels: number; gainDb: number; ceilingDb: number }, signal: AbortSignal): Promise<void>;
}
const numeric = (value: string | undefined): number => value === "-inf" ? -Infinity : Number(value);

export function createRetailAudioTools(runner: MediaProcessRunner): RetailAudioTools {
  const localInput = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3"];
  const run = async (tool: "ffmpeg" | "ffprobe", args: string[], signal: AbortSignal) => {
    signal.throwIfAborted();
    const result = await runner.run(tool, args, { signal, timeoutMs: 30 * 60_000, maxStdoutBytes: 65_536, maxStderrBytes: 131_072 });
    signal.throwIfAborted();
    if (result.code !== 0 || result.timedOut || result.cancelled || result.outputLimitExceeded) throw new Error("Retail audio analysis or encoding failed; no chapter files were published.");
    return result;
  };
  const edge = async (file: string, from: number, seconds: number, signal: AbortSignal) => {
    const result = await run("ffmpeg", ["-hide_banner", "-nostdin", "-nostats", "-ss", String(from), ...localInput, "-i", file, "-t", String(seconds), "-map", "0:a:0", "-af", "silencedetect=noise=-60dB:d=0.05", "-f", "null", "-"], signal);
    const starts = [...result.stderr.matchAll(/silence_start: ([\d.e+-]+)/g)].map(m => Number(m[1]));
    const ends = [...result.stderr.matchAll(/silence_end: ([\d.e+-]+)/g)].map(m => Number(m[1]));
    return { head: starts[0] !== undefined && starts[0] < 0.01 ? ends[0] ?? seconds : 0,
      tail: starts.length && (ends.at(-1) ?? 0) >= seconds - 0.05 ? seconds - starts.at(-1)! : 0 };
  };
  return {
    async inspect(file, signal, range) {
      const probed = await run("ffprobe", ["-v", "error", ...localInput, "-show_entries", "format=duration:stream=codec_type,codec_name,sample_rate,channels,bit_rate", "-of", "json", file], signal);
      const raw = JSON.parse(new TextDecoder().decode(probed.stdout)) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number; bit_rate?: string }> };
      const streams = raw.streams?.filter(stream => stream.codec_type === "audio") ?? [];
      const audio = streams[0], duration = Number(raw.format?.duration);
      if (streams.length !== 1 || !audio || !Number.isFinite(duration) || duration <= 0 || ![1, 2].includes(audio.channels ?? 0)) throw new Error("The chapter must contain one mono or stereo audio stream.");
      const from = range?.from ?? 0, to = range?.to ?? duration, seconds = to - from;
      if (!(from >= 0 && to <= duration + 0.1 && seconds > 0)) throw new Error("The chapter's audio range is invalid.");
      const measured = await run("ffmpeg", ["-hide_banner", "-nostdin", "-nostats", "-ss", String(from), ...localInput, "-i", file, "-t", String(seconds), "-map", "0:a:0", "-af",
        "astats=length=0.25:measure_perchannel=none:measure_overall=RMS_level+Peak_level+Noise_floor,ebur128=peak=true:framelog=verbose", "-f", "null", "-"], signal);
      const value = (label: string) => numeric(new RegExp(`${label}:\\s*(-?inf|[-\\d.]+)`, "i").exec(measured.stderr)?.[1]);
      const truePeakDb = numeric(/True peak:\s*\r?\n\s*Peak:\s*(-?inf|[-\d.]+)\s*dBFS/i.exec(measured.stderr)?.[1]);
      const head = await edge(file, from, Math.min(6, seconds), signal);
      const tail = await edge(file, Math.max(from, to - 6), Math.min(6, seconds), signal);
      const report = { seconds, channels: audio.channels!, sampleRate: Number(audio.sample_rate), codec: audio.codec_name ?? "", bitrate: Number(audio.bit_rate ?? 0),
        rmsDb: value("RMS level dB"), peakDb: value("Peak level dB"), truePeakDb, noiseFloorDb: value("Noise floor dB"), headSeconds: head.head, tailSeconds: tail.tail };
      if ([report.rmsDb, report.peakDb, report.truePeakDb, report.noiseFloorDb].some(value => Number.isNaN(value) || value === Infinity)) throw new Error("Audio measurements are unavailable; the chapter was not published.");
      return report;
    },
    async encode(input, output, options, signal) {
      const filter = `atrim=start=${options.from}:end=${options.to},asetpts=PTS-STARTPTS,volume=${options.gainDb}dB,alimiter=limit=${10 ** (options.ceilingDb / 20)}:level=false:latency=true,adelay=1100:all=true,apad=pad_dur=2.1`;
      await run("ffmpeg", ["-hide_banner", "-nostdin", "-nostats", "-v", "error", "-y", ...localInput, "-i", input, "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-af", filter,
        "-ar", "44100", "-ac", String(options.channels), "-c:a", "libmp3lame", "-b:a", "192k", "-abr", "0", "-joint_stereo", "0", "-f", "mp3", output], signal);
    },
  };
}

export function retailProblems(report: RetailMeasurements): string[] {
  const problems: string[] = [];
  if (report.codec !== "mp3" || !Number.isFinite(report.bitrate) || report.bitrate < 192_000 || report.sampleRate !== 44_100 || ![1, 2].includes(report.channels)) problems.push("needs mono or stereo MP3 at 192 kbps or higher and 44.1 kHz");
  if (!Number.isFinite(report.rmsDb) || report.rmsDb < -23 || report.rmsDb > -18) problems.push(`RMS ${report.rmsDb.toFixed(1)} dBFS is outside -23 to -18`);
  // ebur128 prints tenths: retain 0.1 dB so rounding cannot conceal a peak above -3.
  if (!Number.isFinite(report.truePeakDb) || !Number.isFinite(report.peakDb) || report.truePeakDb > -3.1 || report.peakDb > -3) problems.push("peaks exceed the -3 dBFS safety margin or could not be measured");
  if (report.noiseFloorDb > -60 || Number.isNaN(report.noiseFloorDb)) problems.push("noise floor exceeds -60 dBFS or could not be measured");
  if (!Number.isFinite(report.seconds) || report.seconds <= 0 || report.seconds > 7200) problems.push("duration is unavailable or exceeds 120 minutes");
  if (!Number.isFinite(report.headSeconds) || !Number.isFinite(report.tailSeconds) || report.headSeconds < 1 || report.headSeconds > 5 || report.tailSeconds < 1 || report.tailSeconds > 5) problems.push("needs 1 to 5 seconds of quiet at the beginning and end");
  return problems;
}

/** Gain/limiter mastering converges on measured delivery RMS, including the encoder and padding.
 * Each attempt starts from the original PCM, never from a previously encoded MP3. */
export async function masterRetailFile(tools: RetailAudioTools, input: string, output: string, options: {
  from: number; to: number; channels: number; sourceRmsDb: number;
}, signal: AbortSignal, onCheck: () => void = () => {}): Promise<RetailMeasurements> {
  if (!Number.isFinite(options.sourceRmsDb)) throw new Error("The chapter has no measurable audio.");
  let gainDb = -20.5 - options.sourceRmsDb, ceilingDb = -4;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    await tools.encode(input, output, { from: options.from, to: options.to, channels: options.channels, gainDb, ceilingDb }, signal);
    onCheck();
    const frameSeconds = await verifyRetailMp3(output, options.channels, signal);
    const measured = await tools.inspect(output, signal);
    // Exclude our added padding: it cannot hide noise in the original programme.
    const content = await tools.inspect(output, signal, { from: 1.1, to: 1.1 + options.to - options.from });
    measured.noiseFloorDb = content.noiseFloorDb;
    const problems = retailProblems(measured);
    if (measured.channels !== options.channels || Math.abs(measured.seconds - (options.to - options.from + 3.2)) > 0.15 || Math.abs(measured.seconds - frameSeconds) > 0.15) problems.push("the encoded duration or channel count changed");
    if (!problems.length) return measured;
    if (attempt === 2 || !Number.isFinite(measured.rmsDb) || !Number.isFinite(measured.truePeakDb)) throw new Error(problems.join("; "));
    gainDb += -20.5 - measured.rmsDb;
    if (measured.truePeakDb > -3.2) ceilingDb -= measured.truePeakDb + 3.5;
  }
  throw new Error("Audio validation did not complete.");
}

/** Walk every MPEG frame in bounded memory. Average bit_rate alone cannot prove CBR. */
export async function verifyRetailMp3(file: string, channels: number, signal: AbortSignal): Promise<number> {
  const handle = await open(file, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 100 || before.size > 174_000_000) throw new Error("The encoded MP3 has an invalid size.");
    const buffer = Buffer.alloc(65_536);
    let base = -1, length = 0;
    const bytes = async (at: number, count: number) => {
      signal.throwIfAborted();
      if (at < base || at + count > base + length) { base = at; length = (await handle.read(buffer, 0, buffer.length, at)).bytesRead; }
      if (at + count > base + length) throw new Error("The MP3 is truncated.");
      return buffer.subarray(at - base, at - base + count);
    };
    const tag = await bytes(0, 10);
    let at = 0;
    if (tag.toString("ascii", 0, 3) === "ID3") {
      if (tag.subarray(6, 10).some(value => value & 128)) throw new Error("The MP3 has invalid metadata.");
      at = 10 + ((tag[6]! << 21) | (tag[7]! << 14) | (tag[8]! << 7) | tag[9]!) + (tag[5]! & 16 ? 10 : 0);
    }
    let frames = 0;
    while (at < before.size) {
      const header = await bytes(at, 4);
      if (before.size - at === 128 && header.toString("ascii", 0, 3) === "TAG") break;
      // MPEG-1 Layer III, 192 kbps, 44.1 kHz. Stereo must not be joint stereo.
      const mode = header[3]! >> 6;
      if (header[0] !== 255 || (header[1]! & 254) !== 250 || (header[2]! >> 4) !== 11 || (header[2]! & 12) !== 0 ||
        (channels === 1 ? mode !== 3 : mode !== 0)) throw new Error("The finished MP3 is not 192 kbps CBR, 44.1 kHz in the selected channel format.");
      const frameLength = Math.floor(144 * 192_000 / 44_100) + ((header[2]! >> 1) & 1);
      if (at + frameLength > before.size) throw new Error("The MP3 ends with an incomplete frame.");
      if (!frames) {
        const frame = await bytes(at, frameLength), xing = 4 + (header[1]! & 1 ? 0 : 2) + (channels === 1 ? 17 : 32);
        if (frame.toString("ascii", xing, xing + 4) === "Xing" || frame.toString("ascii", 36, 40) === "VBRI") throw new Error("The MP3 declares variable bitrate.");
      }
      at += frameLength; frames++;
    }
    const after = await handle.stat();
    if (!frames || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("The finished MP3 changed during validation.");
    const seconds = frames * 1152 / 44100;
    if (seconds > 7200) throw new Error("The MP3's actual frames exceed 120 minutes.");
    return seconds;
  } finally { await handle.close(); }
}
