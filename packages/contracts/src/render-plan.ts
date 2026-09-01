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
  TimelineOperationRefused,
  basePictureTrack,
  framesToSeconds,
  orderedTrackClips,
  resolvePictureTimeline,
  type ProductionTimeline,
  type TimelineState,
} from "./timeline.js";
import { productionFrameRate, type FrameRate } from "./world.js";

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

export interface RenderPlan extends ExportPlan {
  /** The saved timeline revision this plan was frozen from; null for legacy derivation. */
  revision: number | null;
  /** The delivery window on the timeline, in seconds of the production clock. */
  range: { startSec: number; endSec: number };
  scope: RenderScope;
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
}

const STILL_KINDS: ReadonlySet<string> = new Set(["image", "board"]);

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
): { ok: true; overlays: ExportOverlay[] } | { ok: false; reason: string } {
  const base = basePictureTrack(timeline);
  const overlays: ExportOverlay[] = [];
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
      overlays.push({
        path: `artifacts/${artifact.file}`,
        startSec: framesToSeconds(clip.startFrame, frameRate),
        endSec: framesToSeconds(clip.startFrame + clip.durationFrames, frameRate),
        still,
      });
    }
  }
  return { ok: true, overlays };
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
  const { production, artifacts, timeline, scope, preset } = input;
  const frameRate = productionFrameRate(production.meta);
  if (production.spine !== null) {
    return { ok: false, reason: "music-timed delivery renders through the spine plan until its timeline is materialised" };
  }
  if (timeline?.status === "invalid") return { ok: false, reason: `timeline is invalid: ${timeline.message}` };

  if (scope.kind === "episode") {
    const refusal = episodeExportRefusals(production, scope.episodeId);
    if (refusal) return { ok: false, reason: `episode export refused: ${refusal.detail}` };
    if (timeline !== undefined && timeline.status !== "absent") {
      return { ok: false, reason: "episode ranges do not consume the saved Picture timeline in this release" };
    }
    const plan = buildExportPlan(deriveEpisodeCut(production, scope.episodeId), preset, [], [], frameRate);
    return { ok: true, plan: { ...plan, revision: null, range: { startSec: 0, endSec: plan.totalSec }, scope } };
  }

  const legacyOverlays = exportOverlays(production.cut.overlays, artifacts);
  const legacyAudio = exportAudioClips(production.cut.overlays, artifacts);
  if (timeline === undefined || timeline.status === "absent") {
    const plan = buildExportPlan(deriveCut(production), preset, legacyOverlays, legacyAudio, frameRate);
    return { ok: true, plan: { ...plan, revision: null, range: { startSec: 0, endSec: plan.totalSec }, scope } };
  }

  let cut;
  try {
    cut = resolvePictureTimeline(production, timeline);
  } catch (error) {
    if (error instanceof TimelineOperationRefused) return { ok: false, reason: `timeline is not ready to render: ${error.reason}` };
    throw error;
  }
  const upper = overlaysFromTimeline(timeline.timeline, artifacts, frameRate);
  if (!upper.ok) return upper;

  /*
   * The base sequence, in the export plan's own terms. A hole is black and says nothing, because
   * nothing asked for picture there; a shot with no usable take is a slate that names it, exactly
   * as the legacy plan slates it. Artifact-sourced clips on the base track are placed media: a
   * video is a clip, a still is black under a held overlay — the one still path FFmpeg has been
   * verified on.
   */
  const items: ExportItem[] = [];
  const stillOverlays: ExportOverlay[] = [];
  let cursorSec = 0;
  for (const entry of cut.entries) {
    const startSec = cursorSec;
    cursorSec += entry.durationSec;
    if (entry.hole === true) {
      items.push({ type: "black", durationSec: entry.durationSec });
      continue;
    }
    const clip = basePictureTrack(timeline.timeline)?.clips.find((candidate) => candidate.id === entry.clipId);
    if (clip !== undefined && clip.source.kind === "artifact") {
      const artifact = artifacts.find((candidate) => candidate.id === (clip.source.kind === "artifact" ? clip.source.artifactId : ""));
      if (artifact === undefined) return { ok: false, reason: `${clip.id} cites artifact ${clip.source.artifactId}, which this world does not have` };
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
      continue;
    }
    items.push({ type: "slate", label: `${entry.label} · ${entry.durationSec.toFixed(1)}s`, durationSec: entry.durationSec });
  }

  const overlays = [...stillOverlays, ...legacyOverlays, ...upper.overlays];
  const totalSec = Math.max(cut.totalSec, ...overlays.map((overlay) => overlay.endSec), ...legacyAudio.map((clip) => clip.endSec), 0);
  if (totalSec > cut.totalSec && items.length > 0) {
    // Placed work reaching past the last Picture clip is still in the film (R-2, SPEC-037 R-32).
    items.push({ type: "black", durationSec: totalSec - cut.totalSec });
  }
  if (items.length === 0 && totalSec > 0) items.push({ type: "black", durationSec: totalSec });
  const plan: RenderPlan = {
    preset,
    frameRate,
    items,
    overlays,
    audio: [...legacyAudio],
    totalSec,
    revision: timeline.timeline.revision,
    range: { startSec: 0, endSec: totalSec },
    scope,
  };
  return { ok: true, plan };
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
        sourceSec: overlay.still ? 0 : sec - overlay.startSec,
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

/** The sound mixed under one moment (R-12..R-19 land the gains; here it is presence and gain). */
export function audioAtSec(plan: ExportPlan, sec: number): ExportAudioClip[] {
  return plan.audio.filter((clip) => sec >= clip.startSec && sec < clip.endSec);
}
