import { AGENT_QUALITY_LIMITS, AGENT_SYNC_LIMITS, AgentClipQualitySchema, AgentSongMapSchema, AgentSyncMeasurementSchema, EFFECT_ANALYSIS_PROFILE, SONG_SECTION_PROFILE,
  createEffectPcmAnalyzer, findSongSections, type AgentClipQuality, type AgentMediaInventory, type AgentSongMap, type AgentSyncMeasurement, type ClipQualityArgs,
  type MeasureSyncArgs, type SongMapArgs } from "@arke-studio/contracts";
import { withContainedProductionMedia } from "../world/reference-files.js";
import { parseStreamRate, regionGeometry, type AgentMediaTools } from "../media/agent-media-tools.js";
import { measureCadence, measureDetail } from "../media/clip-quality.js";
import { measureMouthSync, measureSoundtrackSync } from "../media/measure-sync.js";
import { SONG_MAP_PROFILE, songBeats, stepLevels, voiceIntervals } from "../media/song-map.js";
import { RetrievalError } from "./retrieval.js";
import type { InspectionSource } from "./media-inspection.js";

/*
 * The measurements of epic #3070 that read a second source. The take is already open as a
 * verified snapshot; the reference gets its own, with the same identity checks, so neither path
 * a decoder sees can be replaced while it reads.
 */

/** 16 kHz mono holds a voice's envelope at 10 ms steps with room to spare. */
const MEASURE_RATE = 16000;
type Stream = AgentMediaInventory["streams"][number];

export const SYNC_LIMITATIONS = {
  common: [
    "Signal measurement: correlation over lags between the take and the reference's loudness. A high correlation says they rise and fall together, not that the words are the same.",
    "The lag is resolved to one step (10 ms for sound, 40 ms for a mouth); a lag outside the searched window is not found.",
    "No speech recognition, listening or judgement of the performance was made.",
  ],
  soundtrack: "Assumes the take's own soundtrack carries the sound it was made to; a take whose sound was replaced or muted says nothing here about its picture.",
  mouth: "Head and camera movement inside the box count as mouth movement, and a mouth that leaves the box is not measured: a coarse proxy for lip sync.",
} as const;

export const SONG_LIMITATIONS = [
  "Signal measurement of the decoded sound. Beats are tracked from where notes start, in 10 ms steps; downbeats and bars are not found, a passage with no steady pulse gets no beats, and where the music is ambiguous the tempo can be read at double or half.",
  "Sections are where the level and low end change, found as the Cut proposes them: boundaries, never names. A verse turning into a chorus at the same level is not found.",
  "Voice is where the named stem is louder than its threshold; other instruments bleeding into the stem count as voice. Without a stem nothing is said about singing.",
  "No listening, word recognition or judgement of the music was made.",
];

/** Decode a window longer than one bounded read in 60 s pieces, joined end to end at exact sample counts. */
async function decodeLong(pcm: NonNullable<AgentMediaTools["pcmAudio"]>, path: string, stream: Stream, startSec: number, endSec: number,
  format: { rate: number; channels: 1 | 2 }, signal: AbortSignal, each?: (chunk: Float32Array) => void): Promise<Float32Array | null> {
  const total = Math.round((endSec - startSec) * format.rate) * format.channels, out = each ? null : new Float32Array(total);
  let filled = 0;
  for (let at = startSec; filled < total; at += 60) {
    const to = Math.min(endSec, at + 60), chunk = await pcm(path, stream, at, to, format, signal);
    const want = Math.min(total, Math.round((to - startSec) * format.rate) * format.channels) - filled;
    // A piece a sample or two short is padded with silence; one that is long is cut at the window.
    const piece = new Float32Array(want); piece.set(chunk.subarray(0, Math.min(chunk.length, want)));
    if (each) each(piece); else out!.set(piece, filled);
    filled += want;
  }
  return out;
}

/**
 * Beats, sections and voice for a window of a song. Sections are found by the effects analysis
 * the Cut's proposals use, fed the window as 48 kHz stereo; beats and voice read a 16 kHz mono
 * derivative of the song and of the stem.
 */
export async function songMapInSnapshot(worldDir: string, tools: AgentMediaTools, signal: AbortSignal,
  song: { path: string; stream: Stream; startSec: number; endSec: number; viewStartSec: number }, args: SongMapArgs, vocal: InspectionSource | null): Promise<AgentSongMap> {
  const pcm = tools.pcmAudio;
  if (!pcm) throw new RetrievalError("unavailable", "Local song measurement is unavailable on this host.");
  const length = song.endSec - song.startSec, rate = SONG_MAP_PROFILE.rate, view = (at: number) => Math.round((song.viewStartSec + at) * 1000) / 1000;
  const mono = (await decodeLong(pcm, song.path, song.stream, song.startSec, song.endSec, { rate, channels: 1 }, signal))!;
  const { beatsSec, tempoBpm } = await songBeats(mono, signal);
  const fps = SONG_SECTION_PROFILE.frameRate, frames = Math.floor(length * fps);
  let starts = [0];
  if (frames >= 1) {
    const analyzer = createEffectPcmAnalyzer({ frameRate: fps, startFrame: 0, endFrame: frames });
    await decodeLong(pcm, song.path, song.stream, song.startSec, song.startSec + frames / fps,
      { rate: EFFECT_ANALYSIS_PROFILE.sampleRate, channels: 2 }, signal, chunk => analyzer.push(chunk));
    starts = findSongSections(analyzer.finish(), fps).startsSec.filter(at => at < length);
  }
  let voice: AgentSongMap["vocal"] = null, sung: Array<{ startSec: number; endSec: number }> = [];
  if (vocal && args.vocal) {
    voice = await withContainedProductionMedia(worldDir, vocal.path, vocal.expectedHash, signal, async snapshot => {
      const inventory = await tools.probe(snapshot.path, signal), end = vocal.endSec ?? inventory.durationSec;
      const startSec = vocal.startSec + song.viewStartSec, endSec = startSec + length;
      if (end === null || endSec > end + .05) throw new RetrievalError("bad-argument", "The vocal stem does not cover the song's window.");
      const candidates = inventory.streams.filter(stream => stream.kind === "audio");
      const selected = args.vocal!.streamIndex === undefined ? candidates.length === 1 ? candidates[0] : undefined
        : candidates.find(stream => stream.index === args.vocal!.streamIndex);
      if (!selected) throw new RetrievalError("bad-argument", "Select one explicit audio stream of the vocal stem from inspect_media; ambiguous tracks are never guessed.");
      const found = voiceIntervals((await decodeLong(pcm, snapshot.path, selected, startSec, Math.min(endSec, end), { rate, channels: 1 }, signal))!, rate);
      sung = found.intervals;
      return { source: args.vocal!.source, sourceHash: snapshot.sourceHash, streamIndex: selected.index, thresholdDbfs: found.thresholdDbfs,
        // Never cut short: the limit holds every phrase a 15-minute window can have, and past it the schema refuses rather than a map going quiet.
        intervals: found.intervals.map(span => ({ startSec: view(span.startSec), endSec: view(Math.min(length, span.endSec)) })) };
    });
  }
  const levels = stepLevels(mono, rate, .1);
  const sections = starts.map((at, i) => {
    const endAt = starts[i + 1] ?? length, from = Math.floor(at * 10), to = Math.max(from + 1, Math.floor(endAt * 10));
    let power = 0, count = 0;
    for (let s = from; s < Math.min(to, levels.length); s++) { power += 10 ** (levels[s]! / 10); count++; }
    const overlap = sung.reduce((sum, span) => sum + Math.max(0, Math.min(endAt, span.endSec) - Math.max(at, span.startSec)), 0);
    return { startSec: view(at), endSec: view(endAt), loudnessDbfs: count && power > 0 ? Math.round(10 * Math.log10(power / count) * 10) / 10 : null,
      vocalFraction: voice ? Math.round(Math.min(1, overlap / (endAt - at)) * 1000) / 1000 : null };
  });
  const beats = beatsSec.filter(at => at <= length).map(view);
  return AgentSongMapSchema.parse({ streamIndex: song.stream.index, startSec: view(0), endSec: view(length),
    tempoBpm: beats.length ? tempoBpm : null, beats, sections, vocal: voice });
}

export const QUALITY_LIMITATIONS = [
  "Signal measurement of decoded frames. Cadence reads every frame of the interval at 128 px; detail reads the region at up to 960 px over at most 2 s from the interval's middle.",
  "Sharpness is fine detail (mean absolute Laplacian), not whether the right thing is in focus. Shimmer is how much that detail changes from frame to frame over the detail itself, so fast motion raises it too: compare like with like.",
  "A compared clip is met at one size, the smaller enlarged bicubic as the Cut's export would; clips of different shapes are not compared.",
  "Faces, anatomy, likeness, where a character looks and whether the picture suits the scene were not judged: those need frames looked at, and a person.",
];

/**
 * Cadence over the whole interval and detail over its middle, of one clip or of two met at one
 * size. The compared clip is a second contained snapshot, rechecked like the first.
 */
export async function qualityInSnapshot(worldDir: string, tools: AgentMediaTools, signal: AbortSignal,
  clip: { path: string; stream: Stream; startSec: number; endSec: number }, args: ClipQualityArgs, compareSource: InspectionSource | null): Promise<AgentClipQuality> {
  const grayFrames = tools.grayFrames;
  if (!grayFrames) throw new RetrievalError("unavailable", "Local clip measurement is unavailable on this host.");
  const limits = AGENT_QUALITY_LIMITS, length = clip.endSec - clip.startSec, detailLength = Math.min(limits.detailSeconds, length);
  const measure = async (path: string, stream: Stream, startSec: number, size?: { width: number; height: number }) => {
    const all = await grayFrames(path, stream, startSec, startSec + length, { fps: null, edge: limits.cadenceEdge }, signal);
    const from = startSec + (length - detailLength) / 2;
    const middle = await grayFrames(path, stream, from, from + detailLength, { fps: null, edge: limits.detailEdge, region: args.region, ...(size ? { size } : {}) }, signal);
    if (middle.frames.length < 2) throw new RetrievalError("unavailable", "The interval holds too few frames to measure detail.");
    return { streamIndex: stream.index, cadence: measureCadence(all.frames, parseStreamRate(stream.frameRate)), detail: measureDetail(middle.frames, middle.width, middle.height) };
  };
  if (!compareSource || !args.compare) return AgentClipQualitySchema.parse({ ...await measure(clip.path, clip.stream, clip.startSec), ...(args.region ? { region: args.region } : {}), compare: null });
  const compare = args.compare;
  return withContainedProductionMedia(worldDir, compareSource.path, compareSource.expectedHash, signal, async snapshot => {
    const inventory = await tools.probe(snapshot.path, signal), end = compareSource.endSec ?? inventory.durationSec;
    const range = compare.range ?? args.range, startSec = compareSource.startSec + range.startSec;
    if (end === null || startSec + length > end + .000001) throw new RetrievalError("bad-argument", "The compared interval runs past the end of the compared clip.");
    const candidates = inventory.streams.filter(stream => stream.kind === "video");
    const selected = compare.streamIndex === undefined ? candidates.length === 1 ? candidates[0] : undefined : candidates.find(stream => stream.index === compare.streamIndex);
    if (!selected?.width || !selected.height) throw new RetrievalError("bad-argument", "Select one explicit video stream of the compared clip from inspect_media; ambiguous tracks are never guessed.");
    const a = regionGeometry(clip.stream.width!, clip.stream.height!, args.region, 4096), b = regionGeometry(selected.width, selected.height, args.region, 4096);
    if (Math.abs(a.cropWidth / a.cropHeight - b.cropWidth / b.cropHeight) > .02 * a.cropWidth / a.cropHeight) throw new RetrievalError("bad-argument", "Two clips of different shapes are not compared detail for detail.");
    // The larger of the two, its longer side at most the detail edge: the smaller is enlarged to meet it.
    const larger = a.cropWidth * a.cropHeight >= b.cropWidth * b.cropHeight ? a : b, scale = Math.min(1, limits.detailEdge / Math.max(larger.cropWidth, larger.cropHeight));
    const even = (value: number) => Math.max(8, 2 * Math.round(value / 2)), size = { width: even(larger.cropWidth * scale), height: even(larger.cropHeight * scale) };
    const first = await measure(clip.path, clip.stream, clip.startSec, size), second = await measure(snapshot.path, selected, startSec, size);
    const change = (from: number, to: number) => from > 0 ? Math.round((to / from - 1) * 1000) / 10 : 0;
    return AgentClipQualitySchema.parse({ ...first, ...(args.region ? { region: args.region } : {}),
      compare: { ...second, source: compare.source, sourceHash: snapshot.sourceHash, range,
        sharpnessChangePct: change(first.detail.sharpness, second.detail.sharpness), shimmerChangePct: change(first.detail.shimmer, second.detail.shimmer) } });
  });
}

export async function measureSyncInSnapshot(worldDir: string, tools: AgentMediaTools, signal: AbortSignal,
  take: { path: string; stream: Stream; startSec: number; endSec: number }, args: MeasureSyncArgs, reference: InspectionSource): Promise<AgentSyncMeasurement> {
  const monoAudio = tools.monoAudio, grayFrames = tools.grayFrames;
  if (!monoAudio || args.method === "mouth" && !grayFrames) throw new RetrievalError("unavailable", "Local sync measurement is unavailable on this host.");
  const length = take.endSec - take.startSec;
  return withContainedProductionMedia(worldDir, reference.path, reference.expectedHash, signal, async snapshot => {
    const inventory = await tools.probe(snapshot.path, signal);
    const end = reference.endSec ?? inventory.durationSec, startSec = reference.startSec + args.reference.startSec, endSec = startSec + length;
    if (end === null || endSec > end + .000001) throw new RetrievalError("bad-argument", "The reference interval runs past the end of the reference.");
    const candidates = inventory.streams.filter(stream => stream.kind === "audio");
    const selected = args.reference.streamIndex === undefined ? candidates.length === 1 ? candidates[0] : undefined
      : candidates.find(stream => stream.index === args.reference.streamIndex);
    if (!selected) throw new RetrievalError("bad-argument", "Select one explicit audio stream of the reference from inspect_media; ambiguous tracks are never guessed.");
    const referencePcm = await monoAudio(snapshot.path, selected, startSec, endSec, MEASURE_RATE, signal);
    let measured;
    if (args.method === "mouth") {
      const video = await grayFrames!(take.path, take.stream, take.startSec, take.endSec,
        { fps: AGENT_SYNC_LIMITS.mouthFps, edge: AGENT_SYNC_LIMITS.mouthEdge, region: args.region }, signal);
      measured = measureMouthSync(video.frames, video.fps ?? AGENT_SYNC_LIMITS.mouthFps, referencePcm, MEASURE_RATE, args.maxLagSec);
    } else {
      measured = measureSoundtrackSync(await monoAudio(take.path, take.stream, take.startSec, take.endSec, MEASURE_RATE, signal), referencePcm, MEASURE_RATE, args.maxLagSec);
    }
    return AgentSyncMeasurementSchema.parse({ method: args.method, streamIndex: take.stream.index, ...(args.region ? { region: args.region } : {}),
      reference: { source: args.reference.source, sourceHash: snapshot.sourceHash, streamIndex: selected.index,
        startSec: args.reference.startSec, endSec: args.reference.startSec + length },
      maxLagSec: args.maxLagSec, threshold: AGENT_SYNC_LIMITS.follows, ...measured });
  });
}
