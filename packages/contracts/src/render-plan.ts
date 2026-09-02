import type { ProductionBundle } from "./client-state.js";
import {
  buildExportPlan,
  deriveCut,
  deriveEpisodeCut,
  episodeExportRefusals,
  exportAudioClips,
  exportOverlays,
  type ExportAudioClip,
  type ExportItem,
  type ExportOverlay,
  type ExportPlan,
  type ExportPreset,
} from "./cut.js";
import {
  AUDIO_TRACK_KINDS,
  DEFAULT_MIX,
  TimelineOperationRefused,
  basePictureTrack,
  episodeTimelineRange,
  framesToSeconds,
  orderedTrackClips,
  resolvePictureTimeline,
  type MixSettings,
  type ProductionTimeline,
  type TimelineClip,
  type TimelineState,
  type TimelineTrack,
} from "./timeline.js";
import { productionFrameRate, type FrameRate } from "./world.js";
import { DEFAULT_SUBTITLE_STYLE, orderedCues, type SidecarFormat, type SubtitleOutputMode, type SubtitleStyle } from "./subtitles.js";

/**
 * One render plan, two executors (SPEC-038 R-1..R-11, D1; issue #680).
 *
 * Preview and export used to walk the story, the lanes and the timeline separately, and the
 * three walks disagreed in exactly the ways nobody noticed until the file played beside the
 * screen: a placed still the preview never showed (GitHub issue #486), a hole the export
 * slated with a shot's name. This module is the one projection both consume. It is data — not
 * FFmpeg arguments, not React elements — and the browser adapter and the FFmpeg builder read it
 * rather than reconstructing it.
 *
 * The plan extends the export plan the FFmpeg builder already renders, so a legacy production
 * with no saved timeline projects to *exactly* the plan it always did (asserted in the tests).
 * Timeline authority adds fields; it does not fork the shape.
 */

export type RenderScope = { kind: "production" } | { kind: "episode"; episodeId: string };

/** What a sound is for, which decides whether speech lowers it (SPEC-038 R-12, R-14). */
export type RenderAudioRole = "dialogue" | "ambience" | "music" | "picture";

export interface RenderAudioItem extends ExportAudioClip {
  role: RenderAudioRole;
  /** Seconds into the source where the clip starts. */
  sourceInSec: number;
  clipId?: string;
}

export interface SpeechRegion {
  startSec: number;
  endSec: number;
}

export interface RenderCue {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
  speaker?: string;
}

/** The subtitle track a plan shows and delivers (R-26, R-27): one language at a time. */
export interface RenderSubtitles {
  trackId: string;
  language: string;
  style: SubtitleStyle;
  cues: RenderCue[];
  mode: SubtitleOutputMode;
  sidecar: SidecarFormat;
}

export interface SubtitleChoice {
  trackId: string;
  mode: SubtitleOutputMode;
  sidecar?: SidecarFormat;
}

export interface RenderPlan extends ExportPlan {
  /** The saved timeline revision this plan was frozen from; null for legacy derivation. */
  revision: number | null;
  /** The delivery window on the timeline, in seconds of the production clock. */
  range: { startSec: number; endSec: number };
  scope: RenderScope;
  audio: RenderAudioItem[];
  mix: MixSettings;
  /** Where speech is expected (R-16): the Dialogue clip windows, merged. */
  speech: SpeechRegion[];
  /** The chosen subtitle track, or null when none is viewed or delivered. */
  subtitles: RenderSubtitles | null;
}

export type RenderPlanResult = { ok: true; plan: RenderPlan } | { ok: false; reason: string };

/** What the plan needs to know about an artifact; the sidecar already holds it. */
export interface RenderArtifact {
  id: string;
  file: string;
  kind: string;
  mediaInfo?: { hasAudio: boolean; durationSec?: number };
}

export interface RenderPlanInput {
  production: ProductionBundle;
  artifacts: readonly RenderArtifact[];
  timeline: TimelineState | undefined;
  scope: RenderScope;
  preset: ExportPreset;
  /** Which subtitle track to show and how to deliver it; absent means none (R-26, R-27). */
  subtitles?: SubtitleChoice;
}

const STILL_KINDS: ReadonlySet<string> = new Set(["image", "board"]);

/** Legacy placed sound had no role: it is never ducked, exactly as it never was. */
function legacyAudio(clips: readonly ExportAudioClip[]): RenderAudioItem[] {
  return clips.map((clip) => ({ ...clip, role: "picture", sourceInSec: 0 }));
}

function withRender(plan: ExportPlan, scope: RenderScope, revision: number | null, mix: MixSettings): RenderPlan {
  return {
    ...plan,
    audio: legacyAudio(plan.audio),
    revision,
    range: { startSec: 0, endSec: plan.totalSec },
    scope,
    mix,
    speech: [],
    subtitles: null,
  };
}

/**
 * The chosen subtitle track as the plan carries it (R-26, R-27). Only a visible track is viewed or
 * delivered; a muted one is a named refusal rather than a quietly empty output. Cues past the
 * film are clipped to it, and a cue wholly past it is not delivered (R-19's rule for sound).
 */
function subtitlesFromTimeline(
  timeline: ProductionTimeline,
  choice: SubtitleChoice | undefined,
  frameRate: FrameRate,
  totalSec: number,
): { ok: true; subtitles: RenderSubtitles | null } | { ok: false; reason: string } {
  if (choice === undefined) return { ok: true, subtitles: null };
  const track = timeline.tracks.find((candidate) => candidate.id === choice.trackId);
  if (track === undefined) return { ok: false, reason: `subtitle track ${choice.trackId} is not on the timeline` };
  if (track.kind !== "subtitle") return { ok: false, reason: `${track.name} is not a Subtitle track` };
  if (track.muted) return { ok: false, reason: `${track.name} is muted; unmute it or choose another subtitle track` };
  const cues: RenderCue[] = orderedCues(track.cues ?? [])
    .map((cue) => ({
      id: cue.id,
      text: cue.text,
      startSec: framesToSeconds(cue.startFrame, frameRate),
      endSec: Math.min(framesToSeconds(cue.endFrame, frameRate), totalSec),
      ...(cue.speaker !== undefined ? { speaker: cue.speaker } : {}),
    }))
    .filter((cue) => cue.endSec > cue.startSec);
  return {
    ok: true,
    subtitles: {
      trackId: track.id,
      language: track.language ?? "und",
      style: track.style ?? DEFAULT_SUBTITLE_STYLE,
      cues,
      mode: choice.mode,
      sidecar: choice.sidecar ?? "srt",
    },
  };
}

/** The cue showing at a moment, if the plan carries subtitles (R-26). */
export function cueAtSec(plan: Pick<RenderPlan, "subtitles">, sec: number): RenderCue | null {
  return plan.subtitles?.cues.find((cue) => sec >= cue.startSec && sec < cue.endSec) ?? null;
}

/**
 * Which tracks sound (R-6): a muted track is out, and once anything is solo, only solo audio
 * tracks are in. Saved Mute values are never touched by solo; this is a read.
 */
export function audibleTracks(timeline: Pick<ProductionTimeline, "tracks">): TimelineTrack[] {
  const audio = timeline.tracks.filter((track) => AUDIO_TRACK_KINDS.has(track.kind));
  const soloed = audio.filter((track) => track.solo === true);
  if (soloed.length > 0) return soloed.filter((track) => !track.muted);
  return timeline.tracks.filter((track) => !track.muted);
}

function mergeRegions(regions: SpeechRegion[]): SpeechRegion[] {
  const sorted = [...regions].sort((a, b) => a.startSec - b.startSec);
  const merged: SpeechRegion[] = [];
  for (const region of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && region.startSec <= last.endSec) last.endSec = Math.max(last.endSec, region.endSec);
    else merged.push({ ...region });
  }
  return merged;
}

/**
 * Picture clips on tracks above the base one composite over it (R-8). Each becomes an overlay
 * item at its frame window; a still holds, a video shifts. A missing or non-picture artifact is
 * a named refusal rather than a silent omission (R-5): the clip is on the timeline, so something
 * was meant to be seen there.
 */
function overlaysFromTimeline(
  timeline: ProductionTimeline,
  artifacts: readonly RenderArtifact[],
  frameRate: FrameRate,
): { ok: true; overlays: ExportOverlay[]; sound: RenderAudioItem[] } | { ok: false; reason: string } {
  const base = basePictureTrack(timeline);
  const overlays: ExportOverlay[] = [];
  const sound: RenderAudioItem[] = [];
  const audible = new Set(audibleTracks(timeline).map((track) => track.id));
  const anySolo = timeline.tracks.some((track) => track.solo === true);
  const upper = timeline.tracks
    .filter((track) => track.kind === "picture" && track.id !== base?.id && !track.muted)
    .sort((a, b) => a.order - b.order);
  for (const track of upper) {
    for (const clip of orderedTrackClips(track)) {
      if (clip.source.kind !== "artifact") {
        return { ok: false, reason: `${clip.id} on ${track.name} is not a placed artifact, which is all an upper Picture track can hold` };
      }
      const artifactId = clip.source.artifactId;
      const artifact = artifacts.find((candidate) => candidate.id === artifactId);
      if (artifact === undefined) return { ok: false, reason: `${clip.id} cites artifact ${artifactId}, which this world does not have` };
      const still = STILL_KINDS.has(artifact.kind);
      if (!still && artifact.kind !== "video") {
        return { ok: false, reason: `${clip.id} cites ${artifact.file}, which is ${artifact.kind} and has no picture` };
      }
      const startSec = framesToSeconds(clip.startFrame, frameRate);
      const endSec = framesToSeconds(clip.startFrame + clip.durationFrames, frameRate);
      const sourceInSec = framesToSeconds(clip.sourceInFrames, frameRate);
      overlays.push({ path: `artifacts/${artifact.file}`, startSec, endSec, still, ...(!still && sourceInSec > 0 ? { sourceInSec } : {}) });
      // A placed video's own sound plays while it is kept and the world knows it has some (R-12).
      if (!still && clip.audio !== "mute" && artifact.mediaInfo?.hasAudio === true && audible.has(track.id) && !anySolo) {
        sound.push({
          path: `artifacts/${artifact.file}`,
          startSec,
          endSec,
          gainDb: clip.gainDb ?? 0,
          role: "picture",
          sourceInSec: framesToSeconds(clip.sourceInFrames, frameRate),
          clipId: clip.id,
        });
      }
    }
  }
  return { ok: true, overlays, sound };
}

/** Typed audio tracks become mixed sound (R-12, R-13, R-19); each clip conformed to its window. */
function audioFromTimeline(
  timeline: ProductionTimeline,
  production: ProductionBundle,
  artifacts: readonly RenderArtifact[],
  frameRate: FrameRate,
): { ok: true; audio: RenderAudioItem[]; speech: SpeechRegion[] } | { ok: false; reason: string } {
  const audio: RenderAudioItem[] = [];
  const speech: SpeechRegion[] = [];
  const takesById = new Map(production.takes.map((take) => [take.id, take] as const));
  for (const track of audibleTracks(timeline).filter((track) => AUDIO_TRACK_KINDS.has(track.kind)).sort((a, b) => a.order - b.order)) {
    for (const clip of orderedTrackClips(track)) {
      const startSec = framesToSeconds(clip.startFrame, frameRate);
      const endSec = framesToSeconds(clip.startFrame + clip.durationFrames, frameRate);
      let path: string;
      if (clip.source.kind === "artifact") {
        const artifactId = clip.source.artifactId;
        const artifact = artifacts.find((candidate) => candidate.id === artifactId);
        if (artifact === undefined) return { ok: false, reason: `${clip.id} cites artifact ${artifactId}, which this world does not have` };
        const carries = artifact.kind === "audio" || (artifact.kind === "video" && artifact.mediaInfo?.hasAudio === true);
        if (!carries) return { ok: false, reason: `${clip.id} cites ${artifact.file}, which is not known to carry sound` };
        path = `artifacts/${artifact.file}`;
      } else if (clip.source.kind === "take") {
        const takeId = clip.source.takeId;
        const take = takesById.get(takeId);
        if (take?.media === undefined) return { ok: false, reason: `${clip.id} cites take ${takeId}, which has no media` };
        path = `productions/${production.meta.id}/takes/${take.id}/${take.media}`;
      } else {
        return { ok: false, reason: `${clip.id} is a shot on ${track.name}; shots are picture` };
      }
      audio.push({
        path,
        startSec,
        endSec,
        gainDb: clip.gainDb ?? 0,
        role: track.kind as RenderAudioRole,
        sourceInSec: framesToSeconds(clip.sourceInFrames, frameRate),
        clipId: clip.id,
      });
      if (track.kind === "dialogue") speech.push({ startSec, endSec });
    }
  }
  return { ok: true, audio, speech: mergeRegions(speech) };
}

/**
 * Turn a timeline revision and a delivery scope into the plan both executors consume (R-1, R-4).
 *
 * With no saved timeline the current derivations stay authoritative (SPEC-037 R-2), and the plan
 * is the export plan those derivations always produced. With one, the resolver's saved order is
 * the base sequence: holes are black, unresolved shots are labelled slates, and every Picture
 * track above the base lands as an overlay at its frame window.
 */
export function buildRenderPlan(input: RenderPlanInput): RenderPlanResult {
  const { production, artifacts, timeline, scope, preset, subtitles: subtitleChoice } = input;
  const frameRate = productionFrameRate(production.meta);
  if (timeline?.status === "invalid") return { ok: false, reason: `timeline is invalid: ${timeline.message}` };
  // A music-timed production renders through the spine plan until its timeline is materialised
  // (SPEC-037 R-2); once it is, the song is a Music clip and the picture is the saved order.
  if (production.spine !== null && (timeline === undefined || timeline.status === "absent")) {
    return { ok: false, reason: "music-timed delivery renders through the spine plan until its timeline is materialised" };
  }

  if (scope.kind === "episode") {
    const refusal = episodeExportRefusals(production, scope.episodeId);
    if (refusal) return { ok: false, reason: `episode export refused: ${refusal.detail}` };
    if (timeline !== undefined && timeline.status === "ready") {
      /*
       * One episode is the production's plan windowed to its validated range (SPEC-037 R-33,
       * SPEC-038 R-3, R-33): the same tracks, the same resolution, the same mix, cut at the frame
       * the episode starts and the frame it ends. Building the whole and windowing it is what
       * keeps the three delivery scopes from ever disagreeing about what a clip is.
       */
      const range = episodeTimelineRange(production, timeline.timeline, scope.episodeId);
      if (!range.ok) return { ok: false, reason: `episode export refused: ${range.reason}` };
      const whole = buildRenderPlan({ ...input, scope: { kind: "production" } });
      if (!whole.ok) return whole;
      return { ok: true, plan: windowPlan(whole.plan, framesToSeconds(range.startFrame, frameRate), framesToSeconds(range.endFrame, frameRate), scope) };
    }
    const plan = buildExportPlan(deriveEpisodeCut(production, scope.episodeId), preset, [], [], frameRate);
    return { ok: true, plan: withRender(plan, scope, null, DEFAULT_MIX) };
  }

  if (timeline === undefined || timeline.status === "absent") {
    if (subtitleChoice !== undefined) return { ok: false, reason: "subtitles live on the saved timeline; there is none yet" };
    const overlays = exportOverlays(production.cut.overlays, artifacts);
    const audio = exportAudioClips(production.cut.overlays, artifacts);
    const plan = buildExportPlan(deriveCut(production), preset, overlays, audio, frameRate);
    return { ok: true, plan: withRender(plan, scope, null, DEFAULT_MIX) };
  }

  let cut;
  try {
    cut = resolvePictureTimeline(production, timeline);
  } catch (error) {
    if (error instanceof TimelineOperationRefused) return { ok: false, reason: `timeline is not ready to render: ${error.reason}` };
    throw error;
  }
  const record = timeline.timeline;
  const upper = overlaysFromTimeline(record, artifacts, frameRate);
  if (!upper.ok) return upper;
  const typed = audioFromTimeline(record, production, artifacts, frameRate);
  if (!typed.ok) return typed;
  // Until the legacy placements are folded into typed tracks they are still read here (SPEC-037
  // R-30): the file remains readable, and there is still only one writable copy.
  const legacyOverlays = record.migratedCut === true ? [] : exportOverlays(production.cut.overlays, artifacts);
  const legacySound = record.migratedCut === true ? [] : legacyAudio(exportAudioClips(production.cut.overlays, artifacts));

  /*
   * The base sequence, in the export plan's own terms. A hole is black and says nothing, because
   * nothing asked for picture there; a shot with no usable take is a slate that names it, exactly
   * as the legacy plan slates it. Artifact-sourced clips on the base track are placed media: a
   * video is a clip, a still is black under a held overlay — the one still path FFmpeg has been
   * verified on.
   */
  const base = basePictureTrack(record);
  const baseAudible = base !== null && !base.muted && !record.tracks.some((track) => track.solo === true);
  const items: ExportItem[] = [];
  const stillOverlays: ExportOverlay[] = [];
  const baseSound: RenderAudioItem[] = [];
  let cursorSec = 0;
  for (const entry of cut.entries) {
    const startSec = cursorSec;
    cursorSec += entry.durationSec;
    // A muted base track contributes no picture (R-6): its time stays, black, so nothing above
    // it moves and the film keeps its length.
    if (entry.hole === true || base?.muted === true) {
      items.push({ type: "black", durationSec: entry.durationSec });
      continue;
    }
    const clip: TimelineClip | undefined = base?.clips.find((candidate) => candidate.id === entry.clipId);
    if (clip !== undefined && clip.source.kind === "artifact") {
      const artifactId = clip.source.artifactId;
      const artifact = artifacts.find((candidate) => candidate.id === artifactId);
      if (artifact === undefined) return { ok: false, reason: `${clip.id} cites artifact ${artifactId}, which this world does not have` };
      const inSec = framesToSeconds(clip.sourceInFrames, frameRate);
      if (STILL_KINDS.has(artifact.kind)) {
        items.push({ type: "black", durationSec: entry.durationSec });
        stillOverlays.push({ path: `artifacts/${artifact.file}`, startSec, endSec: startSec + entry.durationSec, still: true });
        continue;
      }
      if (artifact.kind !== "video") return { ok: false, reason: `${clip.id} cites ${artifact.file}, which is ${artifact.kind} and has no picture` };
      items.push({
        type: "clip",
        path: `artifacts/${artifact.file}`,
        ...(inSec > 0 ? { inSec } : {}),
        durationSec: entry.durationSec,
        label: entry.label,
      });
      if (baseAudible && clip.audio !== "mute" && artifact.mediaInfo?.hasAudio === true) {
        baseSound.push({
          path: `artifacts/${artifact.file}`,
          startSec,
          endSec: startSec + entry.durationSec,
          gainDb: clip.gainDb ?? 0,
          role: "picture",
          sourceInSec: inSec,
          clipId: clip.id,
        });
      }
      continue;
    }
    if (entry.media) {
      items.push({
        type: "clip",
        path: entry.media.path,
        ...(entry.media.inSec !== undefined ? { inSec: entry.media.inSec } : {}),
        ...(entry.media.outSec !== undefined ? { outSec: entry.media.outSec } : {}),
        durationSec: entry.durationSec,
        label: entry.label,
      });
      // A shot that keeps its own sound — the spine's kept diegetic audio — rides under the mix
      // at its stated gain, and only when the take is measured to carry a stream (SPEC-013 R-5a).
      const takeId = entry.takeId;
      if (clip !== undefined && clip.audio === "keep" && baseAudible && takeId !== null && production.takeMediaInfo[takeId]?.mediaInfo.hasAudio === true) {
        baseSound.push({
          path: entry.media.path,
          startSec,
          endSec: startSec + entry.durationSec,
          gainDb: clip.gainDb ?? 0,
          role: "picture",
          sourceInSec: entry.media.inSec ?? 0,
          clipId: clip.id,
        });
      }
      continue;
    }
    items.push({ type: "slate", label: `${entry.label} · ${entry.durationSec.toFixed(1)}s`, durationSec: entry.durationSec });
  }

  const overlays = [...stillOverlays, ...legacyOverlays, ...upper.overlays];
  const placedSound = [...legacySound, ...baseSound, ...upper.sound, ...typed.audio];
  /*
   * The picture decides how long the film is (R-19, SPEC-037 R-32): placed picture reaching past
   * the last clip is still in the film, but sound never lengthens it — a bed that runs long is
   * conformed to the picture's end, not answered with black. Only a film with no picture at all
   * runs as long as what was placed on it, exactly as a media-only production always did.
   */
  const pictureEnd = Math.max(cut.totalSec, ...overlays.map((overlay) => overlay.endSec), 0);
  const totalSec = pictureEnd > 0 ? pictureEnd : Math.max(...placedSound.map((clip) => clip.endSec), 0);
  const audio = placedSound
    .filter((clip) => clip.startSec < totalSec)
    .map((clip) => (clip.endSec > totalSec ? { ...clip, endSec: totalSec } : clip));
  if (totalSec > cut.totalSec && items.length > 0) {
    items.push({ type: "black", durationSec: totalSec - cut.totalSec });
  }
  if (items.length === 0 && totalSec > 0) items.push({ type: "black", durationSec: totalSec });
  const subtitles = subtitlesFromTimeline(record, subtitleChoice, frameRate, totalSec);
  if (!subtitles.ok) return subtitles;
  const burnIn = subtitles.subtitles !== null && (subtitles.subtitles.mode === "burn-in" || subtitles.subtitles.mode === "burn-in+sidecar");
  const plan: RenderPlan = {
    preset,
    frameRate,
    items,
    overlays,
    audio,
    totalSec,
    revision: record.revision,
    range: { startSec: 0, endSec: totalSec },
    scope,
    mix: record.mix,
    // Sound cannot extend the delivery range (R-19): a speech window is clipped to the film.
    speech: record.mix.speechFirst ? typed.speech.map((region) => ({ startSec: region.startSec, endSec: Math.min(region.endSec, totalSec) })) : [],
    subtitles: subtitles.subtitles,
    // Burned pixels are an output (R-27, D4): the builder reads this and never the cues' source.
    ...(burnIn && subtitles.subtitles !== null
      ? { burnIn: { style: subtitles.subtitles.style, cues: subtitles.subtitles.cues.map(({ text, startSec, endSec }) => ({ text, startSec, endSec })) } }
      : {}),
  };
  return { ok: true, plan };
}

/**
 * The plan windowed to `[startSec, endSec)` on the production clock (SPEC-038 R-3, R-33): every
 * item, overlay, sound, speech region and cue that intersects the window, cut at its edges and
 * moved so the window starts at zero. Sources advance by whatever was cut from their heads, so
 * the same frame plays at the same moment in the whole and in the part.
 */
export function windowPlan(plan: RenderPlan, startSec: number, endSec: number, scope: RenderScope): RenderPlan {
  const items: ExportItem[] = [];
  let at = 0;
  for (const item of plan.items) {
    const itemStart = at;
    const itemEnd = at + item.durationSec;
    at = itemEnd;
    const from = Math.max(itemStart, startSec);
    const to = Math.min(itemEnd, endSec);
    if (to <= from) continue;
    const head = from - itemStart;
    // An item the window does not cut keeps its exact duration rather than a re-derived one, so
    // a full-range window is the plan it came from and no float residue creeps in.
    const durationSec = from === itemStart && to === itemEnd ? item.durationSec : to - from;
    if (item.type === "clip") {
      items.push({ ...item, durationSec, ...(head > 0 ? { inSec: (item.inSec ?? 0) + head } : {}) });
    } else if (item.type === "slate") {
      items.push({ type: "slate", label: item.label, durationSec });
    } else {
      items.push({ type: "black", durationSec });
    }
  }
  const clipRange = <T extends { startSec: number; endSec: number }>(entry: T): T | null => {
    const from = Math.max(entry.startSec, startSec);
    const to = Math.min(entry.endSec, endSec);
    return to <= from ? null : { ...entry, startSec: from - startSec, endSec: to - startSec };
  };
  const overlays = plan.overlays.flatMap((overlay) => {
    const cut = clipRange(overlay);
    if (cut === null) return [];
    const head = Math.max(0, startSec - overlay.startSec);
    return [overlay.still || head === 0 ? cut : { ...cut, sourceInSec: (overlay.sourceInSec ?? 0) + head }];
  });
  const audio = plan.audio.flatMap((clip) => {
    const cut = clipRange(clip);
    if (cut === null) return [];
    const head = Math.max(0, startSec - clip.startSec);
    return [head === 0 ? cut : { ...cut, sourceInSec: clip.sourceInSec + head }];
  });
  /*
   * A speech region outside the window still ducks inside it through its look-ahead and release
   * (R-15), so every region whose envelope reaches the window travels with it — whole, shifted
   * onto the scoped clock, never cut to it. The ducking expression reads the region's own edges,
   * and a region cut at the window would start or end the scoped mix unducked (round five).
   */
  const lookAheadSec = (plan.mix?.lookAheadMs ?? 0) / 1000;
  const releaseSec = (plan.mix?.releaseMs ?? 0) / 1000;
  const speech = plan.speech.flatMap((region) =>
    region.endSec + releaseSec <= startSec || region.startSec - lookAheadSec >= endSec
      ? []
      : [{ startSec: region.startSec - startSec, endSec: region.endSec - startSec }],
  );
  const subtitles = plan.subtitles === null ? null : { ...plan.subtitles, cues: plan.subtitles.cues.flatMap((cue) => { const cut = clipRange(cue); return cut === null ? [] : [cut]; }) };
  const burnIn = plan.burnIn === undefined ? undefined : { ...plan.burnIn, cues: plan.burnIn.cues.flatMap((cue) => { const cut = clipRange(cue); return cut === null ? [] : [cut]; }) };
  return {
    ...plan,
    items,
    overlays,
    audio,
    speech,
    subtitles,
    ...(burnIn !== undefined ? { burnIn } : {}),
    totalSec: endSec - startSec,
    range: { startSec, endSec },
    scope,
  };
}

/** What the viewer sees at one moment (R-8): the last overlay covering it, else the base item. */
export interface VisiblePicture {
  /** World-relative media path, or null for a slate, black or hole. */
  path: string | null;
  still: boolean;
  /** Seconds into the source at this moment, for a clip; 0 otherwise. */
  sourceSec: number;
  label: string;
  /** 0 is the base sequence; overlays count upward in composition order. */
  layer: number;
}

export function pictureAtSec(plan: ExportPlan, sec: number): VisiblePicture | null {
  if (sec < 0 || sec >= plan.totalSec) return null;
  for (let index = plan.overlays.length - 1; index >= 0; index -= 1) {
    const overlay = plan.overlays[index]!;
    if (sec >= overlay.startSec && sec < overlay.endSec) {
      return {
        path: overlay.path,
        still: overlay.still,
        sourceSec: overlay.still ? 0 : (overlay.sourceInSec ?? 0) + (sec - overlay.startSec),
        label: overlay.path.split("/").pop() ?? overlay.path,
        layer: index + 1,
      };
    }
  }
  let at = 0;
  for (const item of plan.items) {
    if (sec < at + item.durationSec) {
      if (item.type === "clip") {
        return { path: item.path, still: false, sourceSec: (item.inSec ?? 0) + (sec - at), label: item.label, layer: 0 };
      }
      return { path: null, still: false, sourceSec: 0, label: item.type === "slate" ? item.label : "", layer: 0 };
    }
    at += item.durationSec;
  }
  return null;
}

/** Every moment the visible picture can change: item boundaries and overlay edges. */
export function pictureEdges(plan: ExportPlan): number[] {
  const edges = new Set<number>([0, plan.totalSec]);
  let at = 0;
  for (const item of plan.items) {
    at += item.durationSec;
    edges.add(at);
  }
  for (const overlay of plan.overlays) {
    edges.add(overlay.startSec);
    edges.add(overlay.endSec);
  }
  return [...edges].filter((edge) => edge >= 0 && edge <= plan.totalSec).sort((a, b) => a - b);
}

/**
 * How far speech lowers the background at one moment, 0 through 1 (R-14, R-15). Fully down from
 * the look-ahead before a region to its end, then back up over the release. Regions overlap by
 * taking the deepest, so a pause shorter than the release never lets the bed swell.
 */
export function duckingEnvelope(speech: readonly SpeechRegion[], mix: Pick<MixSettings, "lookAheadMs" | "releaseMs">, sec: number): number {
  const lookAhead = mix.lookAheadMs / 1000;
  const release = mix.releaseMs / 1000;
  let depth = 0;
  for (const region of speech) {
    if (sec >= region.startSec - lookAhead && sec < region.endSec) return 1;
    if (release > 0 && sec >= region.endSec && sec < region.endSec + release) {
      depth = Math.max(depth, 1 - (sec - region.endSec) / release);
    }
  }
  return depth;
}

/** Whether speech-first mixing lowers this sound at all (R-14): Music and Ambience, nothing else. */
export function isDuckable(role: RenderAudioRole): boolean {
  return role === "music" || role === "ambience";
}

/** The gain a sound plays at, in dB, after its own gain and any ducking (R-13, R-14, R-17). */
export function audioGainDbAt(plan: Pick<RenderPlan, "mix" | "speech">, item: Pick<RenderAudioItem, "gainDb" | "role">, sec: number): number {
  if (!plan.mix.speechFirst || !isDuckable(item.role) || plan.speech.length === 0) return item.gainDb;
  return item.gainDb + plan.mix.duckingDb * duckingEnvelope(plan.speech, plan.mix, sec);
}

/** The sound mixed under one moment, each at the gain it plays at (R-12..R-19). */
export function audioAtSec(plan: RenderPlan, sec: number): Array<RenderAudioItem & { effectiveGainDb: number }> {
  return plan.audio
    .filter((clip) => sec >= clip.startSec && sec < clip.endSec)
    .map((clip) => ({ ...clip, effectiveGainDb: audioGainDbAt(plan, clip, sec) }));
}
