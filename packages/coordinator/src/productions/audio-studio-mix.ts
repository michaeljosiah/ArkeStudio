import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { AUDIO_STUDIO_RATE, AudioArrangementRefusal, audioClipGain, resolveAudioArrangement, ulid, validateAudioArrangement,
  type AudioArrangementState, type AudioScript, type AudioSource, type ResolvedAudioClip } from "@arke-studio/contracts";
import { stereoWavFrames, stereoWavHeader, type StereoPcm } from "../audio/stereo-wav.js";
import { StereoLoudness } from "../audio/stereo-loudness.js";
import { atomicWriteFile, renameWithRetry } from "../world/atomic.js";
import { readPublicationFile } from "../publications/files.js";
import { readContainedMediaBytes } from "../world/reference-files.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import type { FfmpegRunner } from "../takes/export.js";
import { AUDIO_STUDIO_SOURCE_BYTES, audioStudioCache, readAudioStudioSource } from "./audio-studio-source.js";
import { holdAudioStudioCache, reserveAudioStudioCache, retainAudioStudioCache, touchAudioStudioCache } from "./audio-studio-cache.js";

const CHUNK = AUDIO_STUDIO_RATE;
/** The loop seam overlaps its head and tail. Every subsequent loop advances by window - seam. */
function sourceSample(channel: Float32Array, entry: ResolvedAudioClip, local: number): number {
  const clip = entry.clip, length = clip.sourceOut - clip.sourceIn;
  if (!clip.loop) return channel[clip.sourceIn + local] ?? 0;
  local += clip.loopOffset ?? 0;
  const seam = clip.loopFade;
  if (!seam) return channel[clip.sourceIn + local % length] ?? 0;
  const period = length - seam;
  const at = local < length ? local : seam + (local - length) % period;
  if (at < period) return channel[clip.sourceIn + at] ?? 0;
  const fade = (at - period) / seam;
  return (channel[clip.sourceIn + at] ?? 0) * (1 - fade) + (channel[clip.sourceIn + at - period] ?? 0) * fade;
}
/** Exported for sample-level tests; all consumers render through the same function below. */
export function mixAudioStudioChunk(entries: readonly ResolvedAudioClip[], sources: ReadonlyMap<string, StereoPcm>, from: number, length: number, speech: readonly { at: number; samples: number }[]) {
  const left = new Float32Array(length), right = new Float32Array(length);
  for (const entry of entries) {
    const source = entry.clip.source, pcm = source ? sources.get(source.file) : undefined;
    if (!pcm || entry.muted) continue;
    const first = Math.max(from, entry.at), last = Math.min(from + length, entry.at + entry.samples);
    // Balance preserves an imported stereo image at centre; a mono source is duplicated first.
    const pan = entry.clip.pan, l = pan > 0 ? Math.cos(pan * Math.PI / 2) : 1, r = pan < 0 ? Math.cos(-pan * Math.PI / 2) : 1;
    for (let at = first; at < last; at++) {
      const gain = audioClipGain(entry, at, speech), local = at - entry.at, index = at - from;
      left[index] = left[index]! + sourceSample(pcm.left, entry, local) * gain * l;
      right[index] = right[index]! + sourceSample(pcm.right, entry, local) * gain * r;
    }
  }
  return { left, right };
}
async function verifySource(dir: string, source: AudioSource, signal: AbortSignal): Promise<void> {
  const bytes = await readContainedMediaBytes(dir, source.file, signal, AUDIO_STUDIO_SOURCE_BYTES);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== source.hash) throw new AudioArrangementRefusal(`${source.label}: audio changed; review its replacement`);
}
/** Accumulate sources on disk, measure the sum, then apply one master gain. */
export async function renderAudioStudioMix(dir: string, input: AudioArrangementState, script: AudioScript, options: { ffmpeg?: FfmpegRunner; signal?: AbortSignal; retainUntil?: AbortSignal; final?: boolean; solo?: string[]; unavailable?: ReadonlyMap<string, string> } = {}) {
  const state = validateAudioArrangement(input), signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const unavailable = new Set<string>(options.unavailable?.keys());
  const files = new Map<string, AudioSource>();
  for (const clip of state.clips) if (clip.source) {
    const prior = files.get(clip.source.file);
    if (prior && prior.hash !== clip.source.hash) throw new AudioArrangementRefusal(`${clip.label}: two clips expect different versions of the same file`);
    files.set(clip.source.file, clip.source);
  }
  for (const source of files.values()) try { await verifySource(dir, source, signal); } catch (error) { if (signal.aborted) throw error; unavailable.add(source.file); }
  const plan = resolveAudioArrangement(state, script, unavailable);
  for (const issue of plan.issues) if (issue.kind === "source") {
    const file = state.clips.find(clip => clip.id === issue.id)?.source?.file;
    if (file && options.unavailable?.has(file)) issue.message = options.unavailable.get(file)!;
  }
  if (options.final && plan.issues.length) throw new AudioArrangementRefusal(`Audio Studio needs attention: ${plan.issues.map(issue => issue.message).join("; ")}`);
  if (plan.samples === 0) throw new AudioArrangementRefusal("There is no arranged audio to play yet");
  const header = stereoWavHeader(plan.samples);
  const playable = plan.clips.filter(entry => entry.clip.source && !unavailable.has(entry.clip.source.file) && !entry.muted && (!options.solo?.length || options.solo.includes(entry.clip.trackId)));
  const speech = playable.filter(entry => entry.clip.role === "speech").map(entry => ({ at: entry.at, samples: entry.samples }));
  const folder = await audioStudioCache(dir, "mix"), id = ulid();
  const rawPath = join(folder, `${id}.f32`), wavPath = join(folder, `${id}.wav`);
  const decoder = options.ffmpeg?.identity ? await options.ffmpeg.identity(signal) : "native-or-injected";
  const hash = createHash("sha256").update(JSON.stringify({ renderer: 2, decoder, state, script, unavailable: [...unavailable], solo: options.solo ?? [] })).digest("hex");
  const file = `.cache/audio-studio/mix/${hash}.wav`, finalPath = join(folder, `${hash}.wav`);
  const receiptFile = `.cache/audio-studio/mix/${hash}.json`;
  const releaseCached = holdAudioStudioCache(dir, file);
  try {
    const bytes = await readContainedMediaBytes(dir, receiptFile, signal, 4096);
    const receipt = JSON.parse(Buffer.from(bytes).toString("utf8")) as { sha256?: string; gainDb?: number; lufs?: number | null };
    if (/^[a-f0-9]{64}$/.test(receipt.sha256 ?? "") && Number.isFinite(receipt.gainDb) && (receipt.lufs === null || Number.isFinite(receipt.lufs))) {
      const measured = await readPublicationFile(dir, file, 4 * 1024 ** 3, signal);
      if (measured.sha256 === receipt.sha256 && measured.byteLength === header.length + plan.samples * 4) {
        signal.throwIfAborted();
        retainAudioStudioCache(dir, file, options.retainUntil); await touchAudioStudioCache(dir, file);
        return { file, seconds: plan.samples / AUDIO_STUDIO_RATE, from: 0, issues: plan.issues, plan, gainDb: receipt.gainDb!, lufs: receipt.lufs! };
      }
    }
  } catch (error) { if (signal.aborted) throw error; /* Missing or damaged derived cache is rebuilt. */ }
  finally { releaseCached(); }
  const releaseOutput = holdAudioStudioCache(dir, file);
  let reservation: (() => void) | undefined;
  let raw: Awaited<ReturnType<typeof open>>;
  try { reservation = await reserveAudioStudioCache(dir, header.length + plan.samples * 4 + 512, 2, signal); raw = await open(rawPath, "wx+"); }
  catch (error) { reservation?.(); releaseOutput(); throw error; }
  let output: Awaited<ReturnType<typeof open>> | undefined;
  const meter = new StereoLoudness();
  const readRaw = async (from: number, length: number) => {
    const bytes = Buffer.alloc(length * 8);
    let offset = 0;
    while (offset < bytes.length) { const read = await raw.read(bytes, offset, bytes.length - offset, from * 8 + offset); if (!read.bytesRead) throw new Error("The audio render scratch file is truncated"); offset += read.bytesRead; }
    return bytes;
  };
  try {
    await raw.truncate(plan.samples * 8);
    // Finish every placement of a source before releasing its decode. Chunk-first eviction
    // redecoded whole long files once per output second when overlapping sources exceeded RAM.
    for (const sourceFile of new Set(playable.map(entry => entry.clip.source!.file))) {
      signal.throwIfAborted();
      const source = files.get(sourceFile)!, entries = playable.filter(entry => entry.clip.source!.file === sourceFile);
      const decoded = await readAudioStudioSource(dir, sourceFile, { ...options, signal, expectedHash: source.hash });
      if (decoded.source.samples !== source.samples) throw new AudioArrangementRefusal(`${source.label}: decoded duration changed`);
      const sources = new Map([[sourceFile, decoded.pcm]]);
      const first = Math.floor(Math.min(...entries.map(entry => entry.at)) / CHUNK) * CHUNK;
      const last = Math.max(...entries.map(entry => entry.at + entry.samples));
      for (let from = first; from < last; from += CHUNK) {
        signal.throwIfAborted();
        const length = Math.min(CHUNK, plan.samples - from), active = entries.filter(entry => entry.at < from + length && entry.at + entry.samples > from);
        if (!active.length) continue;
        const mixed = mixAudioStudioChunk(active, sources, from, length, speech), bytes = await readRaw(from, length);
        for (let i = 0; i < length; i++) {
          bytes.writeFloatLE(bytes.readFloatLE(i * 8) + mixed.left[i]!, i * 8);
          bytes.writeFloatLE(bytes.readFloatLE(i * 8 + 4) + mixed.right[i]!, i * 8 + 4);
        }
        let offset = 0;
        while (offset < bytes.length) { const written = await raw.write(bytes, offset, bytes.length - offset, from * 8 + offset); if (!written.bytesWritten) throw new Error("The audio render scratch file could not be written"); offset += written.bytesWritten; }
        await setImmediate();
      }
    }
    for (let from = 0; from < plan.samples; from += CHUNK) {
      signal.throwIfAborted();
      const length = Math.min(CHUNK, plan.samples - from), bytes = await readRaw(from, length);
      const left = new Float32Array(length), right = new Float32Array(length);
      for (let i = 0; i < length; i++) { left[i] = bytes.readFloatLE(i * 8); right[i] = bytes.readFloatLE(i * 8 + 4); }
      if (left.some(sample => !Number.isFinite(sample)) || right.some(sample => !Number.isFinite(sample))) throw new AudioArrangementRefusal("The mix exceeds the audio signal range; lower its clip levels");
      meter.add(left, right);
      await setImmediate();
    }
    const measured = meter.measure();
    const wanted = measured.lufs === null ? 0 : state.master.targetLufs - measured.lufs;
    const gainDb = Math.min(wanted, measured.peakDb === null ? wanted : state.master.ceilingDb - measured.peakDb);
    output = await open(wavPath, "wx"); await output.writeFile(header);
    for (let from = 0; from < plan.samples; from += CHUNK) {
      signal.throwIfAborted();
      const length = Math.min(CHUNK, plan.samples - from), bytes = await readRaw(from, length);
      const left = new Float32Array(length), right = new Float32Array(length);
      for (let i = 0; i < length; i++) { left[i] = bytes.readFloatLE(i * 8); right[i] = bytes.readFloatLE(i * 8 + 4); }
      await output.writeFile(stereoWavFrames(left, right, 10 ** (gainDb / 20))); await setImmediate();
    }
    await output.sync(); await output.close(); output = undefined;
    // Even cached/long-playing sources must still be the reviewed bytes at publication time.
    for (const source of files.values()) if (!unavailable.has(source.file)) await verifySource(dir, source, signal);
    signal.throwIfAborted(); await renameWithRetry(wavPath, finalPath);
    const digest = await readPublicationFile(dir, file, 4 * 1024 ** 3, signal);
    await atomicWriteFile(await containedWorldFilePath(dir, receiptFile, true, "audio render receipt"), JSON.stringify({ sha256: digest.sha256, gainDb, lufs: measured.lufs }));
    retainAudioStudioCache(dir, file, options.retainUntil);
    return { file, seconds: plan.samples / AUDIO_STUDIO_RATE, from: 0, issues: plan.issues, plan, gainDb, lufs: measured.lufs };
  } finally {
    await output?.close().catch(() => {}); await raw.close();
    await Promise.all([rawPath, wavPath].map(path => rm(path, { force: true }).catch(() => {})));
    reservation(); releaseOutput();
  }
}

/** Crop the already mastered PCM on sample boundaries; range audition never masters again. */
export async function audioStudioMixWindow(dir: string, mix: { file: string; seconds: number }, from: number, to: number, signal: AbortSignal, retainUntil?: AbortSignal) {
  const total = Math.round(mix.seconds * AUDIO_STUDIO_RATE);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > total) throw new AudioArrangementRefusal("Choose a loop range within the chapter");
  if (from === 0 && to === total) return { ...mix, from: 0 };
  const folder = await audioStudioCache(dir, "mix"), key = createHash("sha256").update(`${mix.file}/${from}/${to}`).digest("hex");
  const target = join(folder, `${key}.wav`), temp = join(folder, `${ulid()}.wav`);
  const file = `.cache/audio-studio/mix/${key}.wav`, releaseSource = holdAudioStudioCache(dir, mix.file), releaseOutput = holdAudioStudioCache(dir, file);
  let reservation: (() => void) | undefined, source: Awaited<ReturnType<typeof open>>;
  try { reservation = await reserveAudioStudioCache(dir, 44 + (to - from) * 4, 1, signal); source = await open(await containedWorldFilePath(dir, mix.file, false, "audio audition"), "r"); }
  catch (error) { reservation?.(); releaseSource(); releaseOutput(); throw error; }
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    output = await open(temp, "wx"); await output.writeFile(stereoWavHeader(to - from));
    const buffer = Buffer.alloc(CHUNK * 4);
    let cursor = from * 4, remaining = (to - from) * 4;
    while (remaining > 0) {
      signal.throwIfAborted();
      const length = Math.min(buffer.length, remaining), result = await source.read(buffer, 0, length, 44 + cursor);
      if (!result.bytesRead) throw new Error("The mastered audio is truncated");
      await output.writeFile(buffer.subarray(0, result.bytesRead)); cursor += result.bytesRead; remaining -= result.bytesRead;
    }
    await output.sync(); await output.close(); output = undefined;
    signal.throwIfAborted(); await renameWithRetry(temp, target);
    retainAudioStudioCache(dir, file, retainUntil);
    return { file, seconds: (to - from) / AUDIO_STUDIO_RATE, from: from / AUDIO_STUDIO_RATE };
  } finally { await source.close(); await output?.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); reservation(); releaseSource(); releaseOutput(); }
}
