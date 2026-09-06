import { calculateDialogueTiming, dialogueSlots, dialogueTimingProblems, type DialogueTiming } from "./dialogue-timing.js";
import { resolveProductionArtifact } from "./artifact-access.js";
import type { ProductionBundle } from "./client-state.js";
import {
  audioSourceOf,
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
  effectiveAudioRole,
  DEFAULT_MIX,
  TimelineOperationRefused,
  basePictureTrack,
  episodeTimelineRange,
  framesToSeconds,
  secondsToFrames,
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
export type RenderAudioRole = "dialogue" | "ambience" | "music" | "picture" | "unspecified";

export interface RenderAudioItem extends ExportAudioClip {
  role: RenderAudioRole;
  /** Seconds into the source where the clip starts. */
  sourceInSec: number;
  clipId?: string;
}

/** A measured source rounded to the timeline clock can be transcribed without a trim tool. */
export function playsWholeAudioSource(item: Pick<RenderAudioItem, "sourceInSec" | "startSec" | "endSec">,
  sourceLengthSec: number | null, frameRate: FrameRate): boolean {
  return item.sourceInSec === 0 && sourceLengthSec !== null && sourceLengthSec > 0 &&
    item.endSec - item.startSec + 0.000001 >= Math.max(1, secondsToFrames(sourceLengthSec, frameRate)) / frameRate;
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
  production?: string | null;
  mediaInfo?: { hasAudio: boolean; durationSec?: number };
}

export interface RenderPlanInput {
  production: ProductionBundle;
  /** The whole world's catalog; this planner checks ownership before using a referenced file. */
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
/** A take's playable file and the in-point a segment adds, or null when nothing can play. */
function resolveTakeMedia(production: ProductionBundle, takeId: string): { path: string; inSec: number; outSec?: number; measuredId: string } | null {
  const take = production.takes.find((candidate) => candidate.id === takeId);
  const segment = take?.segment;
  const pass = take === undefined ? undefined : segment === undefined ? take : production.takes.find((candidate) => candidate.id === segment.passTakeId);
  if (take === undefined || pass?.media === undefined) return null;
  return {
    path: `productions/${production.meta.id}/takes/${pass.id}/${pass.media}`,
    inSec: segment?.inSec ?? 0,
    ...(segment !== undefined ? { outSec: segment.outSec } : {}),
    measuredId: pass.id,
  };
}

function overlaysFromTimeline(
  timeline: ProductionTimeline,
  production: ProductionBundle,
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
      const startSec = framesToSeconds(clip.startFrame, frameRate);
      const endSec = framesToSeconds(clip.startFrame + clip.durationFrames, frameRate);
      if (clip.source.kind === "take") {
        // A take on an upper track is a video insert from its pass (round nine).
        const takeId = clip.source.takeId;
        const resolved = resolveTakeMedia(production, takeId);
        if (resolved === null) return { ok: false, reason: `${clip.id} cites take ${takeId}, which has no media` };
        const sourceInSec = resolved.inSec + (clip.source.offsetSec ?? 0) + framesToSeconds(clip.sourceInFrames, frameRate);
        overlays.push({ path: resolved.path, startSec, endSec, still: false, ...(sourceInSec > 0 ? { sourceInSec } : {}) });
        if (clip.audio !== "mute" && production.takeMediaInfo[resolved.measuredId]?.mediaInfo.hasAudio === true && audible.has(track.id) && !anySolo) {
          sound.push({ path: resolved.path, startSec, endSec, gainDb: clip.gainDb ?? 0, role: "picture", sourceInSec, clipId: clip.id });
        }
        continue;
      }
      if (clip.source.kind !== "artifact") {
        return { ok: false, reason: `${clip.id} on ${track.name} is a shot; shots live on the base Picture track` };
      }
      const artifactId = clip.source.artifactId;
      const resolved = resolveProductionArtifact(artifacts, artifactId, production.meta.id);
      if (!resolved.ok) return { ok: false, reason: `${clip.id} cites ${resolved.reason}` };
      const artifact = resolved.artifact;
      const still = STILL_KINDS.has(artifact.kind);
      if (!still && artifact.kind !== "video") {
        return { ok: false, reason: `${clip.id} cites ${artifact.file}, which is ${artifact.kind} and has no picture` };
      }
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
  const slots = dialogueSlots(production), timings: DialogueTiming[] = [];
  for (const track of audibleTracks(timeline).filter((track) => AUDIO_TRACK_KINDS.has(track.kind)).sort((a, b) => a.order - b.order)) {
    for (const clip of orderedTrackClips(track)) {
      let startSec = framesToSeconds(clip.startFrame, frameRate);
      let endSec = framesToSeconds(clip.startFrame + clip.durationFrames, frameRate);
      let path: string;
      let segmentInSec = 0;
      let physicalInSec: number | undefined;
      if (clip.source.kind === "artifact") {
        const artifactId = clip.source.artifactId;
        const resolved = resolveProductionArtifact(artifacts, artifactId, production.meta.id);
        if (!resolved.ok) return { ok: false, reason: `${clip.id} cites ${resolved.reason}` };
        const artifact = resolved.artifact;
        const carries = artifact.kind === "audio" || (artifact.kind === "video" && artifact.mediaInfo?.hasAudio === true);
        if (!carries) return { ok: false, reason: `${clip.id} cites ${artifact.file}, which is not known to carry sound` };
        path = `artifacts/${artifact.file}`;
      } else if (clip.source.kind === "take") {
        // A pass segment plays its pass's file from the segment's in-point (round nine), the
        // same resolution the placement check and the base track apply.
        const takeId = clip.source.takeId;
        const resolved = resolveTakeMedia(production, takeId);
        if (resolved === null) return { ok: false, reason: `${clip.id} cites take ${takeId}, which has no media` };
        path = resolved.path;
        segmentInSec = resolved.inSec + (clip.source.offsetSec ?? 0);
      } else if (clip.source.kind === "performance") {
        const source = clip.source;
        const performance = production.performances.find(p => p.id === source.performanceId);
        if (!performance || performance.target.shotId !== source.shotId || performance.provenance.outputHash !== source.sourceHash) return { ok: false, reason: `${clip.id}: performance identity is missing or changed` };
        const slot = slots.filter(s => s.shotId === source.shotId);
        if (slot.length !== 1) return { ok: false, reason: `${clip.id}: choose one picture slot for this dialogue` };
        const calculated = calculateDialogueTiming(slot[0]!,performance.provenance.outputTechnical.durationSec,source.leadInSec,source.timing);
        if (!calculated.ok) return calculated;
        const timing = calculated.timing;
        const halfFrame = framesToSeconds(1,frameRate)/2 + 0.000001;
        if (Math.abs(startSec-timing.speechStartSec)>halfFrame || Math.abs(framesToSeconds(clip.sourceInFrames,frameRate)-timing.sourceInSec)>halfFrame || Math.abs((endSec-startSec)-timing.spokenSec)>2*halfFrame) return { ok:false,reason:`${clip.id}: picture or dialogue trim moved; review the performance placement again` };
        // Frame windows draw the editor, but the immutable audio plays its exact physical range.
        startSec=timing.speechStartSec; endSec=timing.speechEndSec; physicalInSec=timing.sourceInSec;
        timings.push(timing);
        path = `productions/${production.meta.id}/performances/${performance.id}/${performance.file}`;
      } else {
        return { ok: false, reason: `${clip.id} is a shot on ${track.name}; shots are picture` };
      }
      audio.push({
        path,
        startSec,
        endSec,
        gainDb: clip.gainDb ?? 0,
        role: effectiveAudioRole(track, clip),
        sourceInSec: physicalInSec ?? (segmentInSec + framesToSeconds(clip.sourceInFrames, frameRate)),
        clipId: clip.id,
      });
      if (effectiveAudioRole(track, clip) === "dialogue") speech.push({ startSec, endSec });
    }
  }
  const problems = dialogueTimingProblems(timings,slots,Math.max(0,...slots.map(s=>s.endSec)));
  if (problems.length) return {ok:false,reason:problems.join(" ")};
  return { ok: true, audio, speech: mergeRegions(speech) };
}

/** Legacy clocks still need scope checks even where they bypass the saved-timeline planner. */
export function legacyArtifactScopeRefusal(production: ProductionBundle,
  artifacts: readonly { id: string; production?: string | null }[], timeline: TimelineState | undefined = production.timeline): string | null {
  const references: Array<{ label: string; id: string }> = [];
  if (timeline?.status !== "ready" && production.spine) references.push({ label: "Master track", id: production.spine.trackArtifactId });
  if (timeline?.status !== "ready" || timeline.timeline.migratedCut !== true) {
    for (const overlay of production.cut.overlays) references.push({ label: overlay.id, id: overlay.artifactId });
    for (const track of production.cut.audio) for (const [index, entry] of track.entries.entries()) {
      const source = audioSourceOf(entry);
      if (source?.kind === "artifact") references.push({ label: `${track.label} entry ${index + 1}`, id: source.artifactId });
    }
  }
  for (const reference of references) {
    const resolved = resolveProductionArtifact(artifacts, reference.id, production.meta.id);
    if (!resolved.ok && resolved.code === "other-production") return `${reference.label} cites ${resolved.reason}`;
  }
  return null;
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
  const legacyRefusal = legacyArtifactScopeRefusal(production, artifacts, timeline);
  if (legacyRefusal !== null) return { ok: false, reason: legacyRefusal };
  // A music-timed production renders through the spine plan until its timeline is materialised
  // (SPEC-037 R-2); once it is, the song is a Music clip and the picture is the saved order.
  if (production.spine !== null && (timeline === undefined || timeline.status === "absent")) {
    return { ok: false, reason: "music-timed delivery renders through the spine plan until its timeline is materialised" };
  }

  if (scope.kind === "episode") {
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
    // The legacy refusals — a spine with no episode authority among them — belong to the legacy
    // cut alone; a saved timeline has its own episode range above (round six).
    const refusal = episodeExportRefusals(production, scope.episodeId);
    if (refusal) return { ok: false, reason: `episode export refused: ${refusal.detail}` };
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
    cut = resolvePictureTimeline(production, timeline, artifacts);
  } catch (error) {
    if (error instanceof TimelineOperationRefused) return { ok: false, reason: `timeline is not ready to render: ${error.reason}` };
    throw error;
  }
  const record = timeline.timeline;
  const upper = overlaysFromTimeline(record, production, artifacts, frameRate);
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
      const resolved = resolveProductionArtifact(artifacts, artifactId, production.meta.id);
      if (!resolved.ok) return { ok: false, reason: `${clip.id} cites ${resolved.reason}` };
      const artifact = resolved.artifact;
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
    if (clip !== undefined && clip.source.kind === "take") {
      // A take placed on the base track plays its media like a shot's accepted take would: the
      // pass's file for a segment, windowed to the segment (round seven).
      const takeId = clip.source.takeId;
      const take = production.takes.find((candidate) => candidate.id === takeId);
      const segment = take?.segment;
      const pass = take === undefined ? undefined : segment === undefined ? take : production.takes.find((candidate) => candidate.id === segment.passTakeId);
      if (take === undefined || pass?.media === undefined) return { ok: false, reason: `${clip.id} cites take ${takeId}, which has no media` };
      const path = `productions/${production.meta.id}/takes/${pass.id}/${pass.media}`;
      const inSec = (segment?.inSec ?? 0) + (clip.source.offsetSec ?? 0) + framesToSeconds(clip.sourceInFrames, frameRate);
      items.push({
        type: "clip",
        path,
        ...(inSec > 0 ? { inSec } : {}),
        ...(segment !== undefined ? { outSec: segment.outSec } : {}),
        durationSec: entry.durationSec,
        label: entry.label,
      });
      if (baseAudible && clip.audio !== "mute" && production.takeMediaInfo[pass.id]?.mediaInfo.hasAudio === true) {
        baseSound.push({ path, startSec, endSec: startSec + entry.durationSec, gainDb: clip.gainDb ?? 0, role: "picture", sourceInSec: inSec, clipId: clip.id });
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
      // A segment has no measurement of its own; its pass carries the stream the media path
      // already resolves to (round eight).
      const takeId = entry.takeId;
      const accepted = takeId === null ? undefined : production.takes.find((candidate) => candidate.id === takeId);
      const measuredId = accepted?.segment !== undefined ? accepted.segment.passTakeId : takeId;
      if (clip !== undefined && clip.audio === "keep" && baseAudible && measuredId !== null && production.takeMediaInfo[measuredId]?.mediaInfo.hasAudio === true) {
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
  /**
   * The base clip an overlay sits on, so a logo, a title or an insert composites over the
   * picture rather than replacing it with black (rounds eight and nine). Absent when the base
   * is not a clip.
   */
  under?: { path: string; sourceSec: number; label: string };
}

function baseAtSec(plan: ExportPlan, sec: number): VisiblePicture | null {
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

export function pictureAtSec(plan: ExportPlan, sec: number): VisiblePicture | null {
  if (sec < 0 || sec >= plan.totalSec) return null;
  for (let index = plan.overlays.length - 1; index >= 0; index -= 1) {
    const overlay = plan.overlays[index]!;
    if (sec >= overlay.startSec && sec < overlay.endSec) {
      // Video overlays too (round nine): a transparent title or a letterboxed insert composites
      // over the base in the export, so the preview keeps the base playing under it.
      const base = baseAtSec(plan, sec);
      return {
        path: overlay.path,
        still: overlay.still,
        sourceSec: overlay.still ? 0 : (overlay.sourceInSec ?? 0) + (sec - overlay.startSec),
        label: overlay.path.split("/").pop() ?? overlay.path,
        layer: index + 1,
        ...(base !== null && base.path !== null ? { under: { path: base.path, sourceSec: base.sourceSec, label: base.label } } : {}),
      };
    }
  }
  return baseAtSec(plan, sec);
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
