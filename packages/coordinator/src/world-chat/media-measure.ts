import { AGENT_QUALITY_LIMITS, AGENT_REVIEW_LIMITS, AGENT_SHEET_LIMITS, AGENT_SYNC_LIMITS, AgentClipQualitySchema, AgentExportReviewSchema, AgentSongMapSchema, AgentSyncMeasurementSchema, EFFECT_ANALYSIS_PROFILE, SONG_SECTION_PROFILE,
  buildRenderPlan, createEffectPcmAnalyzer, defaultExportPreset, findSongSections, productionExportFingerprint, type AgentClipQuality, type AgentContactSheet, type AgentExportReview, type AgentMediaInventory, type AgentMediaSource, type TimelineClip,
  type AgentSongMap, type AgentSyncMeasurement, type ClipQualityArgs, type MeasureSyncArgs, type SongMapArgs } from "@arke-studio/contracts";
import { hashContainedProductionMedia, withContainedProductionMedia } from "../world/reference-files.js";
import { parseStreamRate, regionGeometry, type AgentMediaTools } from "../media/agent-media-tools.js";
import { cadenceFromSteps, droppedFromSteps, measureCadence, measureDetail } from "../media/clip-quality.js";
import { composeSeamPage, composeSheetPage, findCuts, tileLabel } from "../media/contact-sheet.js";
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

type CutClip = TimelineClip & { startSec: number; endSec: number };
/**
 * The cut an export was made from, when its production still holds it: its picture clips in time
 * order, its frame rate, and its length as the export's own render plan sets it (sound trimmed to
 * the picture, a base track's remembered end kept as black), null when that plan refuses.
 */
async function exportCut(store: WorldStore, source: AgentMediaSource): Promise<{ productionId: string; rate: number; endSec: number | null; clips: CutClip[] } | null> {
  if (source.kind !== "export") return null;
  const record = (await readCompletedExports(store)).find(row => row.id === source.exportId), bundle = store.getBundle();
  const production = bundle.productions.find(row => row.meta.id === record?.productionId);
  // An episode's export starts at its own range, and an unstamped or changed cut cannot vouch for the film's frames.
  if (!record || record.episodeId || !record.sourceFingerprint || !production || production.timeline?.status !== "ready" ||
    productionExportFingerprint(bundle, production) !== record.sourceFingerprint) return null;
  const timeline = production.timeline.timeline, rate = timeline.frameRate;
  const planned = buildRenderPlan({ production, artifacts: bundle.artifacts, timeline: production.timeline, scope: { kind: "production" }, preset: defaultExportPreset(production.meta) });
  // A muted Picture track puts nothing in the export (render-plan's overlaysFromTimeline): above the base it is left out, and a muted base is black.
  const clips = timeline.tracks.filter(track => track.kind === "picture" && !track.muted).sort((a, b) => a.order - b.order)
    .flatMap(track => track.clips.map(clip => ({ ...clip, startSec: clip.startFrame / rate, endSec: (clip.startFrame + clip.durationFrames) / rate })))
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  return { productionId: production.meta.id, rate, endSec: planned.ok ? planned.plan.totalSec : null, clips };
}

/** The export's own picture clips over a window, when its production still holds the cut it was made from; else null. */
async function timelineShots(store: WorldStore, source: AgentMediaSource, from: number, to: number): Promise<{ productionId: string; shots: Array<SheetShot & { clip: CutClip }> } | null> {
  const cut = await exportCut(store, source);
  const shots = (cut?.clips ?? []).filter(clip => clip.endSec > from && clip.startSec < to)
    .map(clip => ({ startSec: Math.max(from, clip.startSec), endSec: Math.min(to, clip.endSec), label: clip.source.label.slice(0, 160), clipId: clip.id, clip }));
  return cut && shots.length ? { productionId: cut.productionId, shots } : null;
}

/** Cuts found where the picture jumps: small frames ten a second, in 60 s reads three at a time, each read's last frame carried into the next. */
async function pictureShots(tools: AgentMediaTools, film: { path: string; stream: Stream; startSec: number; endSec: number }, from: number, to: number, signal: AbortSignal): Promise<SheetShot[]> {
  const starts: number[] = [];
  for (let at = film.startSec; at < film.endSec - .05; at += 60) starts.push(at);
  const reads = await inParallel(starts, signal, (at, each) => tools.grayFrames!(film.path, film.stream, at, Math.min(film.endSec, at + 60), { fps: 10, edge: 64, fast: true }, each));
  const steps: number[] = [];
  let previous: Uint8Array | null = null;
  for (const read of reads) {
    steps.push(...frameMotion(previous ? [previous, ...read.frames] : read.frames));
    previous = read.frames[read.frames.length - 1] ?? previous;
  }
  const bounds = [from, ...findCuts(steps, 10).map(at => from + at).filter(at => at < to - .2), to];
  return bounds.slice(1).map((end, i) => ({ startSec: bounds[i]!, endSec: end, label: null, clipId: null }));
}

/**
 * The shots of a window of a film and a sheet of their frames. `film` times are the decoder's;
 * shots are on the source's own clock (its view), as every receipt's times are.
 */
export async function contactSheetInSnapshot(store: WorldStore, tools: AgentMediaTools, signal: AbortSignal,
  film: { path: string; stream: Stream; startSec: number; endSec: number; viewStartSec: number }, source: AgentMediaSource, seams = false):
  Promise<{ sheet: Omit<AgentContactSheet, "pages">; pages: Array<{ bytes: Uint8Array; firstShot: number; lastShot: number }> }> {
  const { tile, grayFrames } = tools;
  if (!tile || !grayFrames) throw new RetrievalError("unavailable", "Local contact sheets are unavailable on this host.");
  const from = film.viewStartSec, to = film.viewStartSec + (film.endSec - film.startSec), decodeAt = (view: number) => film.startSec + (view - film.viewStartSec);
  const fromTimeline = await timelineShots(store, source, from, to);
  const shots: SheetShot[] = fromTimeline?.shots ?? await pictureShots(tools, film, from, to, signal);
  if (shots.length > AGENT_SHEET_LIMITS.maxShots) throw new RetrievalError("bad-argument", `This window holds ${shots.length} shots, more than a sheet shows (${AGENT_SHEET_LIMITS.maxShots}); name a shorter window.`);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const numbered = shots.map((shot, i) => ({ number: i + 1, startSec: round(shot.startSec), endSec: round(shot.endSec),
    frameSec: round(Math.min(shot.endSec - .001, (shot.startSec + shot.endSec) / 2)), label: shot.label, clipId: shot.clipId }));
  const size = { width: AGENT_SHEET_LIMITS.tileWidth, height: AGENT_SHEET_LIMITS.tileHeight }, pages = [];
  const about = { streamIndex: film.stream.index, startSec: round(from), endSec: round(to), shotsFrom: fromTimeline ? "timeline" as const : "picture" as const,
    productionId: fromTimeline?.productionId ?? null, shots: numbered };
  if (seams) {
    if (numbered.length < 2) throw new RetrievalError("bad-argument", "This window is one shot: it has no cut to show.");
    const { seamsPerPage, maxPages } = AGENT_SHEET_LIMITS;
    if (numbered.length - 1 > seamsPerPage * maxPages) throw new RetrievalError("bad-argument", `This window holds ${numbered.length - 1} cuts, more than its pages show (${seamsPerPage * maxPages}); name a shorter window.`);
    /*
     * The last frame before each cut and the first after it. A timeline's cut is exact, so the
     * frames are the ones either side of it. A cut found in the picture is the first of ten
     * frames a second to show the new shot, so the old shot's last frame is up to a tenth of a
     * second before that: step back past it, or the "before" is the new shot too.
     */
    const lead = fromTimeline ? .04 : .12, lag = fromTimeline ? .01 : .02;
    const cuts = numbered.slice(1).map((shot, i) => ({ shot: shot.number, atSec: shot.startSec,
      beforeSec: round(Math.max(numbered[i]!.startSec, shot.startSec - lead)), afterSec: round(Math.min(shot.endSec - .001, shot.startSec + lag)) }));
    for (let first = 0; first < cuts.length; first += seamsPerPage) {
      const group = cuts.slice(first, first + seamsPerPage);
      const pairs = await inParallel(group, signal, async (cut, each) => ({ before: await tile(film.path, film.stream, decodeAt(cut.beforeSec), size, each),
        after: await tile(film.path, film.stream, decodeAt(cut.afterSec), size, each), label: tileLabel(cut.shot, cut.atSec) }));
      pages.push({ bytes: await encodePngAsync(composeSeamPage(pairs), {}, signal), firstShot: group[0]!.shot, lastShot: group[group.length - 1]!.shot });
    }
    return { sheet: { ...about, seams: cuts }, pages };
  }
  for (let first = 0; first < numbered.length; first += AGENT_SHEET_LIMITS.perPage) {
    const group = numbered.slice(first, first + AGENT_SHEET_LIMITS.perPage);
    const tiles = await inParallel(group, signal, async (shot, each) => ({ rgba: await tile(film.path, film.stream, decodeAt(shot.frameSec), size, each), label: tileLabel(shot.number, shot.startSec) }));
    pages.push({ bytes: await encodePngAsync(composeSheetPage(tiles), {}, signal), firstShot: group[0]!.number, lastShot: group[group.length - 1]!.number });
  }
  return { sheet: about, pages };
}

export const SEAM_LIMITATIONS = [
  "Two still frames a cut, the last before it and the first after it: the movement across a cut, sound and sync were not reviewed.",
  "Shots are the production's picture clips when its cut is unchanged since this export; otherwise cuts found where the picture jumps, which misses dissolves and slow fades, and a found cut is placed to a tenth of a second.",
  "Each pair is labelled with the number of the shot the cut leads into and the cut's time; clip names are in the shot table.",
];

export const REVIEW_LIMITATIONS = [
  "Signal measurement: length, stream format, EBU R128 loudness, repeated frames per shot, and for each clip whose own sound is muted in the cut, that sound against the film's mix.",
  "Shots and their clips come from the production's timeline only when its cut is unchanged since this export; otherwise cuts are found in the picture and no clip's sync can be measured.",
  "A muted clip's sound is set against the whole mix: a sung take that follows the song is in step; a clip whose sound is not meant to be heard (a film shot's own ambience) will show as not following, which is expected.",
  "Captions, colour, faces, likeness, the mix's balance and the meaning of the film were not reviewed.",
];

/**
 * A film checked before it is shared: its length against its cut, its streams, its loudness, the
 * shots whose frames repeat, and the muted clips' own sound against the mix. Every clip source is
 * read from its own contained snapshot and its bytes rechecked after it is decoded.
 */
export async function reviewInSnapshot(store: WorldStore, tools: AgentMediaTools, signal: AbortSignal,
  film: { path: string; video: Stream; audio: Stream | null; startSec: number; endSec: number; viewStartSec: number; whole: boolean }, source: AgentMediaSource,
  resolve: (source: AgentMediaSource) => Promise<InspectionSource>): Promise<AgentExportReview> {
  const { grayFrames, monoAudio, loudness } = tools;
  if (!grayFrames || !monoAudio || !loudness) throw new RetrievalError("unavailable", "Local film review is unavailable on this host.");
  const from = film.viewStartSec, length = film.endSec - film.startSec, to = from + length, rate = parseStreamRate(film.video.frameRate);
  const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
  const cut = await exportCut(store, source), fromTimeline = await timelineShots(store, source, from, to);
  const shots = fromTimeline?.shots ?? (await pictureShots(tools, { path: film.path, stream: film.video, startSec: film.startSec, endSec: film.endSec }, from, to, signal))
    .map(shot => ({ ...shot, clip: null as CutClip | null }));
  if (shots.length > AGENT_REVIEW_LIMITS.maxShots) throw new RetrievalError("bad-argument", `This window holds ${shots.length} shots, more than a review covers (${AGENT_REVIEW_LIMITS.maxShots}); name a shorter window.`);

  /*
   * Every native frame, small, in 60 s reads three at a time; only the steps between them are
   * kept, each at the decoded time of the frame it leads into. A frame's index over the average
   * rate is no clock in a variable-rate film: 60 fps then 24 averages 42 and puts the frames at
   * the change seconds late, in the wrong shot.
   */
  const starts: number[] = [];
  for (let at = film.startSec; at < film.endSec - .05; at += 60) starts.push(at);
  const reads = await inParallel(starts, signal, (at, each) => grayFrames(film.path, film.video, at, Math.min(film.endSec, at + 60), { fps: null, edge: 48, times: true }, each)
    .then(read => {
      const offset = from + (at - film.startSec), times = read.times;
      if (!times || times.length !== read.frames.length) throw new RetrievalError("unavailable", "The film's frames carry no times to place them in their shots.");
      return { steps: Array.from(frameMotion(read.frames)), times: times.map(time => offset + time), first: read.frames[0], last: read.frames[read.frames.length - 1] };
    }));
  const steps: number[] = [], stepTimes: number[] = [];
  for (const [i, read] of reads.entries()) {
    const before = reads[i - 1]?.last;
    if (before && read.first) { steps.push(...frameMotion([before, read.first])); stepTimes.push(read.times[0]!); }
    steps.push(...read.steps); stepTimes.push(...read.times.slice(1));
  }

  // The film's own mix, once, for the clips' sync; each clip's source read from its own snapshot.
  const mix = film.audio && cut ? await decodeMono(monoAudio, film.path, film.audio, film.startSec, film.endSec, signal) : null;
  // A window that opens inside a clip reads the clip's sound from that point in, not from its in-point.
  const syncs = await inParallel(shots, signal, async (shot, each) => mix && shot.clip ? clipSync(store, tools, each, resolve, cut!, shot.clip, mix,
    shot.startSec - from, shot.endSec - shot.startSec, Math.max(0, shot.startSec - shot.clip.startSec)) : null);

  const loud = film.audio ? await loudness(film.path, film.audio, film.startSec, film.endSec, signal) : null;
  const findings: string[] = [];
  // A finding is at most 300 characters and a label up to 160; the shot table keeps the whole label.
  const name = (shot: { label: string | null }, number: number) => `Shot ${number}${shot.label ? ` (${shot.label.length > 60 ? `${shot.label.slice(0, 59)}…` : shot.label})` : ""}`;
  const reviewed = shots.map((shot, i) => {
    const inside = steps.filter((_, k) => stepTimes[k]! > shot.startSec + .001 && stepTimes[k]! < shot.endSec - .001);
    const cadence = inside.length >= 4 ? cadenceFromSteps(inside, rate, inside.length + 1) : null;
    if (cadence?.repeatPeriod && rate) findings.push(`${name(shot, i + 1)} repeats a frame about every ${cadence.repeatPeriod}: its motion moves at ${cadence.motionFps} fps in a ${round(rate, 2)} fps film, and will look choppy.`);
    const dropped = inside.length >= 8 ? droppedFromSteps(inside) : { jumps: null, jumpPeriod: null };
    if (dropped.jumpPeriod) findings.push(`${name(shot, i + 1)} steps twice as far about every ${dropped.jumpPeriod} frames, as dropped frames do (a faster take played at this film's rate): look at it for choppy motion.`);
    const sync = syncs[i] ?? null;
    if (sync?.follows && sync.lagSec !== null && rate && Math.abs(sync.lagSec) > 1 / rate) {
      findings.push(`${name(shot, i + 1)} is ${Math.round(Math.abs(sync.lagSec) * 1000)} ms ${sync.lagSec > 0 ? "late" : "early"} against the mix: start it ${Math.abs(sync.lagSec)} s ${sync.lagSec > 0 ? "later" : "earlier"} in its source.`);
    }
    return { number: i + 1, startSec: round(shot.startSec), endSec: round(shot.endSec), label: shot.label, clipId: shot.clipId,
      repeatedFrames: cadence?.repeatedFrames ?? null, repeatPeriod: cadence?.repeatPeriod ?? null, motionFps: cadence?.motionFps ?? null,
      jumpedSteps: dropped.jumps, jumpPeriod: dropped.jumpPeriod, sync };
  });
  const expectedSec = film.whole && cut && cut.endSec !== null ? round(cut.endSec) : null, differenceSec = expectedSec === null ? null : round(length - expectedSec);
  if (differenceSec !== null && rate && Math.abs(differenceSec) > 1 / rate) findings.unshift(`The film runs ${round(length, 2)} s and its cut ${expectedSec} s: ${Math.abs(differenceSec)} s ${differenceSec > 0 ? "longer" : "shorter"}.`);
  if (!film.audio) findings.unshift("The film has no sound.");
  else {
    if (film.audio.sampleRate && film.audio.sampleRate < 44100) findings.unshift(`The sound is at ${film.audio.sampleRate} Hz, under the 44.1 kHz a release needs.`);
    if (film.audio.channels === 1) findings.unshift("The sound is mono.");
  }
  if (loud?.truePeakDbtp !== null && loud?.truePeakDbtp !== undefined && loud.truePeakDbtp > AGENT_REVIEW_LIMITS.truePeakCeilingDbtp) {
    findings.push(`The true peak is ${loud.truePeakDbtp} dBTP, over ${AGENT_REVIEW_LIMITS.truePeakCeilingDbtp} dBTP: it can clip once the film is encoded for delivery.`);
  }
  const unfollowed = reviewed.filter(shot => shot.sync && !shot.sync.follows && shot.sync.correlation !== null).length;
  if (unfollowed) findings.push(`${unfollowed} muted clip${unfollowed === 1 ? "'s" : "s'"} own sound does not follow the mix: expected for a clip not meant to be heard, a fault for a sung or spoken one.`);
  const shown = findings.slice(0, AGENT_REVIEW_LIMITS.maxFindings - 1);
  if (findings.length > shown.length) shown.push(`And ${findings.length - shown.length} more of the same kinds; the shot table has them all.`);
  return AgentExportReviewSchema.parse({ startSec: round(from), endSec: round(to), shotsFrom: fromTimeline ? "timeline" : "picture", productionId: fromTimeline?.productionId ?? null,
    length: { durationSec: round(length), expectedSec, differenceSec },
    format: { videoStreamIndex: film.video.index, width: film.video.width!, height: film.video.height!, frameRate: rate && round(rate, 3), videoCodec: film.video.codec,
      audioStreamIndex: film.audio?.index ?? null, sampleRate: film.audio?.sampleRate ?? null, channels: film.audio?.channels ?? null, audioCodec: film.audio?.codec ?? null },
    loudness: loud, shots: reviewed, findings: shown });
}

/** A long window of mono sound, read in 60 s pieces. */
async function decodeMono(monoAudio: NonNullable<AgentMediaTools["monoAudio"]>, path: string, stream: Stream, startSec: number, endSec: number, signal: AbortSignal) {
  const pieces: Float32Array[] = [];
  for (let at = startSec; at < endSec - .01; at += 60) pieces.push(await monoAudio(path, stream, at, Math.min(endSec, at + 60), 16000, signal));
  const out = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let at = 0; for (const piece of pieces) { out.set(piece, at); at += piece.length; }
  return out;
}

/** One muted clip's own sound against the film's mix over the clip's time; null for a clip whose source has no sound to read here. */
async function clipSync(store: WorldStore, tools: AgentMediaTools, signal: AbortSignal, resolve: (source: AgentMediaSource) => Promise<InspectionSource>,
  cut: { productionId: string; rate: number }, clip: CutClip, mix: Float32Array, atSec: number, lengthSec: number, headSec: number) {
  if (clip.audio !== "mute" || clip.speed !== undefined && clip.speed !== 1 || clip.reverse) return null;
  // A clip placed as a shot plays whichever take is accepted at render; only a named take or artifact is a fixed source to read.
  const named: AgentMediaSource | null = clip.source.kind === "artifact" ? { kind: "artifact", id: clip.source.artifactId }
    : clip.source.kind === "take" ? { kind: "production-take", productionId: cut.productionId, takeId: clip.source.takeId } : null;
  if (!named) return null;
  const rate = cut.rate, resolved = await resolve(named).catch(() => null);
  if (!resolved) return null;
  const length = Math.min(lengthSec, 60);
  return withContainedProductionMedia(store.dir, resolved.path, resolved.expectedHash, signal, async snapshot => {
    const inventory = await tools.probe(snapshot.path, signal), sound = inventory.streams.find(stream => stream.kind === "audio");
    const sourceIn = resolved.startSec + clip.sourceInFrames / rate + headSec, end = resolved.endSec ?? inventory.durationSec;
    if (!sound || end === null || sourceIn + length > end + .05) return null;
    const own = await tools.monoAudio!(snapshot.path, sound, sourceIn, Math.min(end, sourceIn + length), 16000, signal);
    const from = Math.round(atSec * 16000), slice = mix.subarray(from, from + own.length);
    const measured = measureSoundtrackSync(own, slice, 16000, AGENT_SYNC_LIMITS.defaultMaxLagSec);
    await hashContainedProductionMedia(store.dir, resolved.path, resolved.expectedHash, signal);
    return { source: named, sourceHash: snapshot.sourceHash, lagSec: measured.lagSec, correlation: measured.correlation, follows: measured.follows };
  });
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
