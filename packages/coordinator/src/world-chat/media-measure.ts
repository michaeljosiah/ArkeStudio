import { AGENT_QUALITY_LIMITS, AGENT_SHEET_LIMITS, AGENT_SYNC_LIMITS, AgentClipQualitySchema, AgentSongMapSchema, AgentSyncMeasurementSchema, EFFECT_ANALYSIS_PROFILE, SONG_SECTION_PROFILE,
  createEffectPcmAnalyzer, findSongSections, productionExportFingerprint, type AgentClipQuality, type AgentContactSheet, type AgentMediaInventory, type AgentMediaSource,
  type AgentSongMap, type AgentSyncMeasurement, type ClipQualityArgs, type MeasureSyncArgs, type SongMapArgs } from "@arke-studio/contracts";
import { withContainedProductionMedia } from "../world/reference-files.js";
import { parseStreamRate, regionGeometry, type AgentMediaTools } from "../media/agent-media-tools.js";
import { measureCadence, measureDetail } from "../media/clip-quality.js";
import { composeSheetPage, findCuts, tileLabel } from "../media/contact-sheet.js";
import { encodePngAsync } from "../references/png-runner.js";
import { readCompletedExports } from "../productions/export-receipts.js";
import type { WorldStore } from "../world/store.js";
import { frameMotion, measureMouthSync, measureSoundtrackSync } from "../media/measure-sync.js";
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

export const SHEET_LIMITATIONS = [
  "Still frames only, one from the middle of each shot: no motion, sound or sync between them was reviewed.",
  "Shots are the production's picture clips when its cut is unchanged since this export; otherwise cuts found where the picture jumps, which misses dissolves and slow fades.",
  "Each tile is labelled with its shot number and start time; clip names are in the shot table.",
];
type SheetShot = { startSec: number; endSec: number; label: string | null; clipId: string | null };

/**
 * Run `work` over `items` three at a time, results in order. A sheet of a 4-minute film is about
 * 80 decodes; one at a time that was over a minute. Three bounded single-thread decoders at once
 * keep it near twenty seconds without taking the machine.
 *
 * The first failure stops the pool: nothing new starts, the decodes in flight are told to stop
 * through the signal each is given, and every one has finished before the failure goes on. A
 * bare `Promise.all` answered while its siblings still ran, so a refused read left FFmpeg
 * holding the snapshot the caller was about to release.
 */
export async function inParallel<T, R>(items: readonly T[], signal: AbortSignal, work: (item: T, signal: AbortSignal) => Promise<R>, width = 3): Promise<R[]> {
  const results: R[] = [], failures: unknown[] = [], stop = new AbortController(), either = AbortSignal.any([signal, stop.signal]);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (!either.aborted && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index]!, either); }
      catch (error) { failures.push(error); stop.abort(); }
    }
  }));
  if (failures.length) throw failures[0];
  signal.throwIfAborted();
  return results;
}

/** The export's own picture clips, when its production still holds the cut it was made from; else null. */
async function timelineShots(store: WorldStore, source: AgentMediaSource, from: number, to: number): Promise<{ productionId: string; shots: SheetShot[] } | null> {
  if (source.kind !== "export") return null;
  const record = (await readCompletedExports(store)).find(row => row.id === source.exportId), bundle = store.getBundle();
  const production = bundle.productions.find(row => row.meta.id === record?.productionId);
  // An episode's export starts at its own range, and an unstamped or changed cut cannot vouch for the film's frames.
  if (!record || record.episodeId || !record.sourceFingerprint || !production || production.timeline?.status !== "ready" ||
    productionExportFingerprint(bundle, production) !== record.sourceFingerprint) return null;
  const timeline = production.timeline.timeline, rate = timeline.frameRate;
  // A muted Picture track puts nothing in the export (render-plan's overlaysFromTimeline): above the base it is left out, and a muted base is black.
  const shots = timeline.tracks.filter(track => track.kind === "picture" && !track.muted).sort((a, b) => a.order - b.order)
    .flatMap(track => track.clips.map(clip => ({ startSec: clip.startFrame / rate, endSec: (clip.startFrame + clip.durationFrames) / rate, label: clip.source.label.slice(0, 160), clipId: clip.id })))
    .filter(shot => shot.endSec > from && shot.startSec < to)
    .map(shot => ({ ...shot, startSec: Math.max(from, shot.startSec), endSec: Math.min(to, shot.endSec) }))
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  return shots.length ? { productionId: production.meta.id, shots } : null;
}

/**
 * The shots of a window of a film and a sheet of their frames. `film` times are the decoder's;
 * shots are on the source's own clock (its view), as every receipt's times are.
 */
export async function contactSheetInSnapshot(store: WorldStore, tools: AgentMediaTools, signal: AbortSignal,
  film: { path: string; stream: Stream; startSec: number; endSec: number; viewStartSec: number }, source: AgentMediaSource):
  Promise<{ sheet: Omit<AgentContactSheet, "pages">; pages: Array<{ bytes: Uint8Array; firstShot: number; lastShot: number }> }> {
  const { tile, grayFrames } = tools;
  if (!tile || !grayFrames) throw new RetrievalError("unavailable", "Local contact sheets are unavailable on this host.");
  const from = film.viewStartSec, to = film.viewStartSec + (film.endSec - film.startSec), decodeAt = (view: number) => film.startSec + (view - film.viewStartSec);
  const fromTimeline = await timelineShots(store, source, from, to);
  let shots: SheetShot[];
  if (fromTimeline) shots = fromTimeline.shots;
  else {
    // Cuts in the picture: small frames ten a second, in 60 s reads three at a time, each read's last frame carried into the next.
    const starts: number[] = [];
    for (let at = film.startSec; at < film.endSec - .05; at += 60) starts.push(at);
    const reads = await inParallel(starts, signal, (at, each) => grayFrames(film.path, film.stream, at, Math.min(film.endSec, at + 60), { fps: 10, edge: 64, fast: true }, each));
    const steps: number[] = [];
    let previous: Uint8Array | null = null;
    for (const read of reads) {
      steps.push(...frameMotion(previous ? [previous, ...read.frames] : read.frames));
      previous = read.frames[read.frames.length - 1] ?? previous;
    }
    const bounds = [from, ...findCuts(steps, 10).map(at => from + at).filter(at => at < to - .2), to];
    shots = bounds.slice(1).map((end, i) => ({ startSec: bounds[i]!, endSec: end, label: null, clipId: null }));
  }
  if (shots.length > AGENT_SHEET_LIMITS.maxShots) throw new RetrievalError("bad-argument", `This window holds ${shots.length} shots, more than a sheet shows (${AGENT_SHEET_LIMITS.maxShots}); name a shorter window.`);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const numbered = shots.map((shot, i) => ({ number: i + 1, startSec: round(shot.startSec), endSec: round(shot.endSec),
    frameSec: round(Math.min(shot.endSec - .001, (shot.startSec + shot.endSec) / 2)), label: shot.label, clipId: shot.clipId }));
  const size = { width: AGENT_SHEET_LIMITS.tileWidth, height: AGENT_SHEET_LIMITS.tileHeight }, pages = [];
  for (let first = 0; first < numbered.length; first += AGENT_SHEET_LIMITS.perPage) {
    const group = numbered.slice(first, first + AGENT_SHEET_LIMITS.perPage);
    const tiles = await inParallel(group, signal, async (shot, each) => ({ rgba: await tile(film.path, film.stream, decodeAt(shot.frameSec), size, each), label: tileLabel(shot.number, shot.startSec) }));
    pages.push({ bytes: await encodePngAsync(composeSheetPage(tiles), {}, signal), firstShot: group[0]!.number, lastShot: group[group.length - 1]!.number });
  }
  return { sheet: { streamIndex: film.stream.index, startSec: round(from), endSec: round(to), shotsFrom: fromTimeline ? "timeline" : "picture",
    productionId: fromTimeline?.productionId ?? null, shots: numbered }, pages };
}

/** From nought there is no percentage: null says so, where 0 would read as no change (a still picture against one that flickers). */
export const percentChange = (from: number, to: number) => from > 0 ? Math.round((to / from - 1) * 1000) / 10 : null;

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
    // The pictures' shapes, not the crops': one region rounds to even pixels differently at two sizes.
    const shapeA = clip.stream.width! / clip.stream.height!, shapeB = selected.width / selected.height;
    if (Math.abs(shapeA - shapeB) > .02 * shapeA) throw new RetrievalError("bad-argument", "Two clips of different shapes are not compared detail for detail.");
    const a = regionGeometry(clip.stream.width!, clip.stream.height!, args.region, 4096), b = regionGeometry(selected.width, selected.height, args.region, 4096);
    // The larger of the two, its longer side at most the detail edge: the smaller is enlarged to meet it.
    const larger = a.cropWidth * a.cropHeight >= b.cropWidth * b.cropHeight ? a : b, scale = Math.min(1, limits.detailEdge / Math.max(larger.cropWidth, larger.cropHeight));
    const even = (value: number) => Math.max(8, 2 * Math.round(value / 2)), size = { width: even(larger.cropWidth * scale), height: even(larger.cropHeight * scale) };
    const first = await measure(clip.path, clip.stream, clip.startSec, size), second = await measure(snapshot.path, selected, startSec, size);
    return AgentClipQualitySchema.parse({ ...first, ...(args.region ? { region: args.region } : {}),
      compare: { ...second, source: compare.source, sourceHash: snapshot.sourceHash, range,
        sharpnessChangePct: percentChange(first.detail.sharpness, second.detail.sharpness), shimmerChangePct: percentChange(first.detail.shimmer, second.detail.shimmer) } });
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
