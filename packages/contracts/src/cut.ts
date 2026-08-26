import { z } from "zod";
import { ArtifactIdSchema, ShotIdSchema, SlugSchema, TakeIdSchema, prefixedIdSchema } from "./ids.js";
import type { ProductionBundle } from "./client-state.js";
import { assertSlateLabelSupported, ffmpegFilterPath } from "./ffmpeg-filter.js";
import { sortScenes } from "./scene.js";
import type { Shot } from "./scene.js";
import type { Take } from "./take.js";

/**
 * The cut (SPEC-013 §2.8, D9): derived from selections and scene order, never stored — a
 * stored sequence would be a second answer to what the film is. `cut.json` holds audio tracks
 * and their placement only (R-16). Pure and isomorphic: the Cut screen and the exporter both
 * derive from here.
 */

// ---------------------------------------------------------------------------
// Audio (R-17, R-18) — the one thing cut.json stores
// ---------------------------------------------------------------------------

export const AudioTrackKindSchema = z.enum(["dialogue", "score", "ambience"]);
export type AudioTrackKind = z.infer<typeof AudioTrackKindSchema>;

export const AudioEntrySchema = z
  .object({
    /** Placement is track-level against shot boundaries in v1 (§1.4). */
    shotId: ShotIdSchema.optional(),
    /** Dialogue references the voice take; beds may reference a filed artifact. */
    takeId: TakeIdSchema.optional(),
    artifactId: ArtifactIdSchema.optional(),
    /** Dialogue: the speaking sheet, and the sheet version the voice was assigned at (R-18). */
    sheetId: SlugSchema.optional(),
    voiceAssignedAtVersion: z.number().int().min(1).optional(),
    offsetSec: z.number().min(0).default(0),
    note: z.string().optional(),
  })
  .strict();
export type AudioEntry = z.infer<typeof AudioEntrySchema>;

export const AudioTrackSchema = z
  .object({
    kind: AudioTrackKindSchema,
    label: z.string().min(1),
    entries: z.array(AudioEntrySchema),
  })
  .strict();
export type AudioTrack = z.infer<typeof AudioTrackSchema>;

// ---------------------------------------------------------------------------
// Placed clips (82a, then lanes) — the part of the cut whose position a person chooses
// ---------------------------------------------------------------------------

/**
 * An artifact placed on a lane for a window you dropped it in (82a, extended to lanes).
 *
 * It is deliberately small. A clip cites an artifact and says when, where and what to do with its
 * sound; it carries no provenance, no canon revision, no cost and no review, because nothing
 * about it was dispatched or judged — it is not a take and never becomes one. Deleting it removes
 * the placement and never the artifact.
 *
 * The kind is never stored, because the artifact already knows it. A lane therefore has no type
 * of its own: what a clip does at export time is read from the artifact it cites, which is why
 * one lane can hold a picture and the lane under it the sound split out of that same file.
 *
 * These are the only stored *positions* on the cut, and that is why they live on lanes of their
 * own: the picture stays derived (R-14), so there is still exactly one answer to where a shot
 * sits. `overlays` is the name the file has always used and keeps, so a cut.json written before
 * lanes existed still parses.
 */
/**
 * What a placed clip does with the sound its own file carries.
 *
 * `keep` is the default because a dropped artifact is something a person chose, unlike a
 * generated take — the spine exporter mutes those by default precisely because "the sound is the
 * model's invention", and that reasoning does not reach a file somebody filed and placed
 * themselves. `mute` and `only` are the two halves a split leaves behind: the picture stays where
 * it was and the sound becomes its own clip on the next lane down.
 */
export const ClipAudioModeSchema = z.enum(["keep", "mute", "only"]);
export type ClipAudioMode = z.infer<typeof ClipAudioModeSchema>;

/** Enough lanes to edit in and few enough that a bad number is refused rather than drawn. */
export const MAX_CLIP_LANE = 15;

export const CutOverlaySchema = z
  .object({
    id: prefixedIdSchema("ov"),
    artifactId: ArtifactIdSchema,
    startSec: z.number().min(0),
    endSec: z.number().positive(),
    /**
     * Which lane holds it, and so what composites over what: a higher lane is nearer the viewer,
     * the same convention every editor this cut can be handed to already uses.
     *
     * Defaulted, because every overlay filed before lanes existed was on the only lane there was.
     * Sound ignores it — mixed audio has no stacking — so a lane is a picture decision that
     * audio clips are merely organised by.
     */
    lane: z.number().int().min(0).max(MAX_CLIP_LANE).default(0),
    audio: ClipAudioModeSchema.default("keep"),
  })
  .strict()
  .refine((v) => v.endSec > v.startSec, {
    message: "endSec must be greater than startSec",
    path: ["endSec"],
  });
export type CutOverlay = z.infer<typeof CutOverlaySchema>;

/**
 * cut.json: audio placement (R-16) and overlays (82a). The picture sequence is still derived and
 * still deliberately absent — an overlay is laid *over* the film, never a statement of what it is.
 */
export const CutFileSchema = z
  .object({
    audio: z.array(AudioTrackSchema).default([]),
    /**
     * Defaulted, never required: this file is the read path for every production written before
     * overlays existed, and a cut.json that fails to parse is a production that loses its audio.
     */
    overlays: z.array(CutOverlaySchema).default([]),
  })
  .strict();
export type CutFile = z.infer<typeof CutFileSchema>;

// ---------------------------------------------------------------------------
// The derived picture cut (R-14, R-15, D9)
// ---------------------------------------------------------------------------

export interface CutEntry {
  sceneNumber: number;
  shot: Shot;
  /** Null → a gap: remaining work made visible, not an error (R-15). */
  takeId: string | null;
  take: Take | null;
  /** World-relative media path plus the segment range when the take is a pass segment. */
  media: { path: string; inSec?: number; outSec?: number } | null;
  durationSec: number;
  label: string;
}

export interface DerivedCut {
  entries: CutEntry[];
  covered: number;
  gaps: number;
  totalSec: number;
  uncoveredSec: number;
}

const DEFAULT_SHOT_SEC = 4;

export function deriveCut(production: ProductionBundle): DerivedCut {
  // Explicit scene order, with the birth number as the legacy fallback (issue #387): the
  // ordinary cut follows the same sequence every display shows.
  return deriveCutOver(production, sortScenes(production.scenes));
}

/**
 * One episode's cut (SPEC-023 R-24, issue #396): the same pure derivation, narrowed to the
 * episode's ordered `scenes` array — which is the membership and within-episode order authority
 * (R-12), so the deliverable and the board can never disagree. Ids the production does not know
 * are skipped here; they are named findings, and `episodeExportRefusals` blocks the encode.
 */
export function deriveEpisodeCut(production: ProductionBundle, episodeId: string): DerivedCut {
  const episode = production.episodes.find((e) => e.id === episodeId);
  const scenesById = new Map(production.scenes.map((s) => [s.id, s]));
  const scenes = (episode?.scenes ?? []).map((id) => scenesById.get(id)).filter((s) => s !== undefined);
  return deriveCutOver(production, scenes);
}

/**
 * Why one episode cannot export yet, or null when it can (SPEC-023 R-24): named refusals,
 * never a score. Gaps do not refuse — they become labelled slates, exactly as the
 * production-wide cut treats them — but an episode whose membership is contradictory must not
 * encode, because the file would silently disagree with the board that promised it.
 */
export function episodeExportRefusals(
  production: ProductionBundle,
  episodeId: string,
): { detail: string } | null {
  const episode = production.episodes.find((e) => e.id === episodeId);
  if (!episode) return { detail: `${episodeId} is not an episode of this production` };
  if (production.spine) {
    return {
      detail:
        "a spine production is cut against its track, and no episode-to-spine range authority exists yet — export the production-wide cut instead",
    };
  }
  if (episode.scenes.length === 0) return { detail: `${episode.title} has no scenes yet` };
  // A scene listed twice inside ONE episode passed every other refusal and rendered twice in
  // the encoded file — the same double-ownership problem wearing a single episode's name.
  const doubled = episode.scenes.find((id, index) => episode.scenes.indexOf(id) !== index);
  if (doubled !== undefined) {
    return { detail: `${episode.title} lists ${doubled} more than once; a scene is listed exactly once` };
  }
  const known = new Set(production.scenes.map((s) => s.id));
  const dangling = episode.scenes.filter((id) => !known.has(id));
  if (dangling.length > 0) {
    return { detail: `${episode.title} lists ${dangling.join(", ")}, which ${dangling.length === 1 ? "is not a scene" : "are not scenes"} in this production` };
  }
  for (const other of production.episodes) {
    if (other.id === episode.id) continue;
    const shared = episode.scenes.filter((id) => other.scenes.includes(id));
    if (shared.length > 0) {
      return { detail: `${shared.join(", ")} also belong${shared.length === 1 ? "s" : ""} to ${other.title}; a scene belongs to exactly one episode` };
    }
  }
  return null;
}

function deriveCutOver(production: ProductionBundle, scenes: readonly ProductionBundle["scenes"][number][]): DerivedCut {
  const takesById = new Map(production.takes.map((t) => [t.id, t]));
  const entries: CutEntry[] = [];
  for (const scene of scenes) {
    for (const shot of scene.shots) {
      const takeId = production.selections[shot.id]?.acceptedTakeId ?? null;
      const take = takeId !== null ? (takesById.get(takeId) ?? null) : null;
      /*
       * The in-point, on the story clock (R-8, #253).
       *
       * The shot's slot is still its authored duration -- the story orders the picture here, and
       * trim does not move a boundary. What it changes is which part of the take fills the slot,
       * so it only ever moves the window's start.
       *
       * `-to` is an absolute position in the source, verified against ffmpeg 8.1 rather than
       * assumed: `-ss 2 -to 6` yields exactly 4.0s, so advancing `inSec` past a segment's fixed
       * `outSec` shortens the window from the front instead of dragging it into the next shot.
       */
      const trim = production.selections[shot.id]?.trimInSec ?? 0;
      let media: CutEntry["media"] = null;
      if (take) {
        if (take.segment) {
          const pass = takesById.get(take.segment.passTakeId);
          const inSec = take.segment.inSec + trim;
          // A trim past the segment's own end leaves nothing to play, and an inverted window is
          // not something to hand an encoder. It becomes a gap, which R-15 already draws and
          // R-20 already slates -- the same answer the song clock gives.
          media =
            pass?.media && inSec < take.segment.outSec
              ? {
                  path: `productions/${production.meta.id}/takes/${pass.id}/${pass.media}`,
                  inSec,
                  outSec: take.segment.outSec,
                }
              : null;
        } else if (take.media) {
          // Unmeasured material bounds nothing (R-5a): absent is "not measured", never "zero".
          const measured = production.takeMediaInfo[take.id]?.mediaInfo.durationSec;
          const consumed = measured !== undefined && trim >= measured;
          // No `inSec` at all when nothing is trimmed, so trim adds nothing to the arguments of
          // an export that does not use it. (It once said the untrimmed export was byte-identical
          // to what this repo had always produced; conforming a clip to its shot's slot ended
          // that, and had to — the identical bytes were the ones that ignored the slot.)
          media = consumed
            ? null
            : {
                path: `productions/${production.meta.id}/takes/${take.id}/${take.media}`,
                ...(trim > 0 ? { inSec: trim } : {}),
              };
        }
      }
      const durationSec = shot.durationSec ?? DEFAULT_SHOT_SEC;
      entries.push({
        sceneNumber: scene.number,
        shot,
        takeId: take ? take.id : null,
        take,
        media,
        durationSec,
        label: `SHOT ${shot.number} · ${shot.title}`,
      });
    }
  }
  const gaps = entries.filter((e) => e.takeId === null);
  return {
    entries,
    covered: entries.length - gaps.length,
    gaps: gaps.length,
    totalSec: entries.reduce((a, e) => a + e.durationSec, 0),
    uncoveredSec: gaps.reduce((a, e) => a + e.durationSec, 0),
  };
}

// ---------------------------------------------------------------------------
// Export assembly (R-19..R-21, D10, D11): one encode, gaps as labelled slates
// ---------------------------------------------------------------------------

export const ExportPresetSchema = z.enum(["review-cut", "master", "social-excerpt"]);
export type ExportPreset = z.infer<typeof ExportPresetSchema>;

export const PRESETS: Record<ExportPreset, { width: number; height: number; fps: number; crf: number }> = {
  "review-cut": { width: 1280, height: 720, fps: 24, crf: 28 },
  master: { width: 1920, height: 1080, fps: 24, crf: 18 },
  "social-excerpt": { width: 1080, height: 1920, fps: 30, crf: 23 },
};

export type ExportItem =
  | { type: "clip"; path: string; inSec?: number; outSec?: number; durationSec: number; label: string }
  | { type: "slate"; label: string; durationSec: number }
  /**
   * Ground for a production that orders no picture (issue 453): black, and silent about it.
   *
   * Distinct from a slate rather than a slate with an empty label, because the two say opposite
   * things. A slate names work the story asked for and nobody has delivered; this names nothing,
   * because nothing was asked for — the clips are the film. Rendering the same black rectangle is
   * a coincidence, and folding them together would make "unfinished" and "finished" identical.
   */
  | { type: "black"; durationSec: number };

/**
 * One overlay, in the exporter's terms (82a): a file, a window, and whether it is a still.
 *
 * The distinction is the whole of it. A still has one frame and must be held for the film's
 * length so the window has something to show; a clip has its own timeline and must be *shifted*
 * to where it was placed, or it plays from the top of the film instead of from its own start.
 */
export interface ExportOverlay {
  path: string;
  startSec: number;
  endSec: number;
  still: boolean;
}

export interface ExportPlan {
  preset: ExportPreset;
  items: ExportItem[];
  /** Laid over the assembled picture, in order; each covers only its own window. */
  overlays: ExportOverlay[];
  /** Mixed under the whole film, each delayed to its own window. */
  audio: ExportAudioClip[];
  totalSec: number;
}

// ---------------------------------------------------------------------------
// A production that is only media (issue 453)
// ---------------------------------------------------------------------------

/*
 * A production with no story still has a film: whatever somebody placed on a lane.
 *
 * The picture stays derived for a production that HAS a story — there is still exactly one answer
 * to what such a film is (R-14, D9), and none of this touches it. What it adds is the case that
 * derivation has nothing to work from: no scenes, so no shots, so no clock. Until now that meant
 * no timeline at all, because the ruler's only source was the sum of shot durations and every
 * gesture refuses at zero — you could not drop the first clip, which made the empty state a dead
 * end rather than a beginning.
 *
 * Two lengths, deliberately, because they answer different questions. The CANVAS is how much
 * timeline to draw: it has to extend past the last clip or there is nowhere to drop the next one.
 * The FILM is how long the thing actually is, and trailing empty canvas is not part of it — an
 * export that padded to the canvas would end in black nobody asked for, and would grow every time
 * the canvas did.
 */

/** Room to work in before anything is placed. A canvas of zero cannot be dropped onto. */
export const MEDIA_CANVAS_MIN_SEC = 60;

/** Space kept past the last clip, so there is always somewhere to drop the next one. */
export const MEDIA_CANVAS_HEADROOM_SEC = 15;

/**
 * True when the production orders no picture of its own, so the clips ARE the film.
 *
 * Read off the derived cut rather than the production, because that is what both callers already
 * hold, and because "no entries" is the precise condition — a production with scenes that hold no
 * shots derives nothing either, and wants the same treatment as one with no scenes at all.
 */
export function isMediaOnly(cut: DerivedCut): boolean {
  return cut.entries.length === 0;
}

/**
 * How far the placed work reaches. Picture and sound both count: a bed laid past the last picture
 * is still part of the film, and cutting the film short of it would silently discard what someone
 * placed.
 */
export function placedExtentSec(placed: readonly { endSec: number }[]): number {
  return placed.reduce((furthest, one) => Math.max(furthest, one.endSec), 0);
}

/** How much timeline to draw: the work, plus somewhere to put the next thing. */
export function mediaCanvasSec(placed: readonly { endSec: number }[]): number {
  return Math.max(MEDIA_CANVAS_MIN_SEC, placedExtentSec(placed) + MEDIA_CANVAS_HEADROOM_SEC);
}

/** Which artifact kinds are picture. A document is not a frame; audio has no picture to lay. */
const OVERLAY_STILL_KINDS: ReadonlySet<string> = new Set(["image", "board"]);

/** One clip's sound, in the exporter's terms: a file, a window, and how loud. */
export interface ExportAudioClip {
  path: string;
  startSec: number;
  endSec: number;
  gainDb: number;
}

/** What resolving a clip needs to know about the artifact it cites. */
type ClipArtifact = { id: string; file: string; kind: string; mediaInfo?: { hasAudio: boolean } };

/**
 * Lane first, then time.
 *
 * Both resolvers walk in this order so the picture composites bottom lane upward — a higher lane
 * is nearer the viewer — and two clips sharing a lane fall back to the order they play in. Audio
 * is merely organised by it: a mix has no stacking, so the lane changes nothing about how a sound
 * comes out, only where its clip is drawn.
 */
function byLaneThenStart(a: CutOverlay, b: CutOverlay): number {
  return (a.lane ?? 0) - (b.lane ?? 0) || a.startSec - b.startSec;
}

/**
 * Resolve the picture of each filed clip against the world's artifacts (82a).
 *
 * A clip citing an artifact this world does not have is dropped rather than guessed at, and one
 * citing something that is not picture — an audio file, a document — has no picture to lay, so
 * nothing is laid. A clip whose sound was split out keeps its picture here and is skipped only
 * when it is the sound half. All of it is silent and counted by the caller, never rendered as an
 * absence.
 */
/**
 * Where an artifact's bytes sit, relative to the world.
 *
 * A sidecar's `file` is a filename *within* `artifacts/` (R-WORLD-3) and the scanner files it
 * verbatim, so every consumer names the directory itself — the scan's own visual-asset list and
 * the spine exporter's master track both do. Omitting it hands ffmpeg a path one directory too
 * high and the encode dies on "No such file or directory" for a file that is plainly there.
 */
const artifactPath = (artifact: ClipArtifact): string => `artifacts/${artifact.file}`;

export function exportOverlays(
  overlays: readonly CutOverlay[],
  artifacts: readonly ClipArtifact[],
): ExportOverlay[] {
  const resolved: ExportOverlay[] = [];
  for (const overlay of [...overlays].sort(byLaneThenStart)) {
    // The sound half of a split carries no picture, even though it cites a file that has one.
    if ((overlay.audio ?? "keep") === "only") continue;
    const artifact = artifacts.find((a) => a.id === overlay.artifactId);
    if (artifact === undefined) continue;
    const still = OVERLAY_STILL_KINDS.has(artifact.kind);
    if (!still && artifact.kind !== "video") continue;
    resolved.push({ path: artifactPath(artifact), startSec: overlay.startSec, endSec: overlay.endSec, still });
  }
  return resolved;
}

/**
 * Resolve the sound of each filed clip (lanes).
 *
 * The mirror of `exportOverlays`, and deliberately a separate walk: picture composites and sound
 * mixes, which are different operations on different streams, so a single list that meant both
 * would have to be re-split by every caller anyway.
 *
 * A video contributes sound only when it is *known* to carry a stream. This is the same rule the
 * spine exporter learned the hard way: naming an audio input that is not there fails the whole
 * encode rather than the one clip, and an unprobed file is not evidence of audio. An artifact
 * filed as audio needs no probe — its kind is the evidence — so a machine with no ffprobe can
 * still lay a music bed.
 */
export function exportAudioClips(
  overlays: readonly CutOverlay[],
  artifacts: readonly ClipArtifact[],
): ExportAudioClip[] {
  const resolved: ExportAudioClip[] = [];
  for (const overlay of [...overlays].sort(byLaneThenStart)) {
    if ((overlay.audio ?? "keep") === "mute") continue;
    const artifact = artifacts.find((a) => a.id === overlay.artifactId);
    if (artifact === undefined) continue;
    const carries =
      artifact.kind === "audio" || (artifact.kind === "video" && artifact.mediaInfo?.hasAudio === true);
    if (!carries) continue;
    resolved.push({ path: artifactPath(artifact), startSec: overlay.startSec, endSec: overlay.endSec, gainDb: 0 });
  }
  return resolved;
}

/** Assemble from the derived cut: accepted material as clips, gaps as slates (D10, D11). */
export function buildExportPlan(
  cut: DerivedCut,
  preset: ExportPreset,
  overlays: readonly ExportOverlay[] = [],
  audio: readonly ExportAudioClip[] = [],
): ExportPlan {
  /*
   * Nothing derived, so the placed work is the whole film (issue 453): one black bed as long as
   * the furthest thing reaches, with the clips laid over it exactly as they are laid over a
   * derived picture. The overlay and audio machinery below needs no special case — it already
   * works in absolute time and has never known what a shot is.
   *
   * An empty plan cannot be the answer here: `concat=n=0` is not a filter graph, so a production
   * with no story would fail the encode rather than export what it has.
   */
  if (isMediaOnly(cut)) {
    const film = placedExtentSec([...overlays, ...audio]);
    return {
      preset,
      items: film > 0 ? [{ type: "black" as const, durationSec: film }] : [],
      overlays: [...overlays],
      audio: [...audio],
      totalSec: film,
    };
  }
  const items: ExportItem[] = cut.entries.map((entry) => {
    if (entry.media) {
      return {
        type: "clip" as const,
        path: entry.media.path,
        ...(entry.media.inSec !== undefined ? { inSec: entry.media.inSec } : {}),
        ...(entry.media.outSec !== undefined ? { outSec: entry.media.outSec } : {}),
        durationSec: entry.durationSec,
        label: entry.label,
      };
    }
    // A black slate reading "SHOT 15 · 6.0s" beats a silent omission (R-20, D10).
    return { type: "slate" as const, label: `${entry.label} · ${entry.durationSec.toFixed(1)}s`, durationSec: entry.durationSec };
  });
  return { preset, items, overlays: [...overlays], audio: [...audio], totalSec: cut.totalSec };
}

/**
 * One ffmpeg invocation for the whole plan (D11): slates from the lavfi color source with a
 * drawtext label; clips trimmed by their ranges; everything concatenated in a single encode.
 */
export function buildFfmpegArgs(plan: ExportPlan, worldDir: string, outFile: string, slateFont: string): string[] {
  const p = PRESETS[plan.preset];
  const args: string[] = ["-y"];
  const filters: string[] = [];
  let inputIndex = 0;
  for (const item of plan.items) {
    if (item.type === "clip") {
      if (item.inSec !== undefined) args.push("-ss", String(item.inSec));
      if (item.outSec !== undefined) args.push("-to", String(item.outSec));
      args.push("-i", `${worldDir}/${item.path}`);
      /*
       * Conformed to the shot's slot, which is what makes the slot binding (issue 450).
       *
       * Ranging the input is not enough and for an ordinary take there is nothing to range: only
       * a pass segment carries `outSec`, so an untrimmed take handed its whole source to the
       * concat and `durationSec` — the authored slot the story ordered — decided nothing. A 4s
       * shot holding an 8s take exported eight seconds of picture against a cut that said four,
       * and because a placed clip is positioned in absolute output time, every shot after it slid
       * out from under whatever had been laid over it while the sound, correctly conformed to
       * `totalSec`, stopped early and left the overrun silent.
       *
       * `tpad` then `trim` yields exactly the slot whether the source runs long or short — the
       * same conform the spine exporter arrived at, and for the same reason it records there:
       * `fps` alone rounds each clip from its own source length independently, so it cannot make
       * two clips agree about what four seconds is. Cloning the last frame is what fills a short
       * one, which beats both a black hole in the picture and a film that quietly changes length.
       */
      const slot = item.durationSec;
      filters.push(
        `[${inputIndex}:v]scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${p.fps},tpad=stop_mode=clone:stop_duration=${slot},trim=duration=${slot},setpts=PTS-STARTPTS[v${inputIndex}]`,
      );
    } else if (item.type === "black") {
      // Ground for a production with no story (issue 453). The same source a slate is drawn on
      // and nothing written on it: there is no missing work to name, so naming it would be a lie.
      args.push("-f", "lavfi", "-t", String(item.durationSec), "-i", `color=c=black:s=${p.width}x${p.height}:r=${p.fps}`);
      filters.push(`[${inputIndex}:v]null[v${inputIndex}]`);
    } else {
      args.push("-f", "lavfi", "-t", String(item.durationSec), "-i", `color=c=black:s=${p.width}x${p.height}:r=${p.fps}`);
      assertSlateLabelSupported(item.label);
      const text = item.label.replace(/[':\\]/g, " ");
      filters.push(`[${inputIndex}:v]drawtext=expansion=none:fontfile=${ffmpegFilterPath(slateFont)}:text='${text}':fontcolor=white:fontsize=48:x=(w-tw)/2:y=(h-th)/2[v${inputIndex}]`);
    }
    inputIndex += 1;
  }
  const concatInputs = plan.items.map((_, i) => `[v${i}]`).join("");
  filters.push(`${concatInputs}concat=n=${plan.items.length}:v=1:a=0[out]`);

  /*
   * Overlays, laid over the assembled picture (82a binding 4: one that does not reach the export
   * is decoration). Verified against ffmpeg 8.1 rather than assumed — a blue film with a red
   * plate placed 2s→4s reads blue, red, blue at 1s, 3s and 5s.
   *
   * `enable` is what confines each to its window; `eof_action=pass` is what stops a clip overlay
   * ending the whole film when it runs out. Untouched when there are none, so an export with no
   * overlays emits exactly the arguments it always did.
   */
  let last = "out";
  plan.overlays.forEach((overlay, i) => {
    const index = plan.items.length + i;
    // A still has one frame: held for the film's length, so its window has something to show.
    if (overlay.still) args.push("-loop", "1", "-t", String(plan.totalSec));
    args.push("-i", `${worldDir}/${overlay.path}`);
    // A clip carries its own timeline and must be moved to where it was placed, or it plays from
    // the top of the film and the window shows the wrong seconds of it.
    const shift = overlay.still ? "" : `,setpts=PTS-STARTPTS+${overlay.startSec}/TB`;
    filters.push(`[${index}:v]scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease${shift}[o${i}]`);
    const next = `ov${i}`;
    filters.push(
      `[${last}][o${i}]overlay=(W-w)/2:(H-h)/2:eof_action=pass:enable='between(t,${overlay.startSec},${overlay.endSec})'[${next}]`,
    );
    last = next;
  });

  /*
   * Sound (lanes). Every clip that carries any is delayed to where it was placed and mixed under
   * the whole film; nothing else on the story clock makes a sound, so a cut with no placed audio
   * adds none of these arguments — the same promise trim makes about an export that does not use
   * it.
   *
   * `normalize=0` is load-bearing and is the one thing to be careful about here: amix divides
   * every input by the number of inputs by default, so laying a second sound anywhere would
   * quietly duck the first for its whole duration — an automatic mix nobody asked for.
   *
   * Each clip is conformed before it is delayed. `apad` then `atrim` yields exactly the window's
   * length whether the file runs long or short, so a bed that is thirty seconds of a four-minute
   * track occupies thirty seconds rather than the rest of the film.
   */
  const audioLabels: string[] = [];
  plan.audio.forEach((clip, i) => {
    const index = plan.items.length + plan.overlays.length + i;
    args.push("-i", `${worldDir}/${clip.path}`);
    const d = Math.max(clip.endSec - clip.startSec, 0);
    const delayMs = Math.round(clip.startSec * 1000);
    filters.push(
      `[${index}:a]apad=whole_dur=${d},atrim=duration=${d},asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1,volume=${clip.gainDb}dB[ac${i}]`,
    );
    audioLabels.push(`[ac${i}]`);
  });
  if (audioLabels.length > 0) {
    // One clip needs no mixer; asking amix for a single input is a filter that does nothing.
    const mixed = audioLabels.length === 1 ? audioLabels[0]! : "[amix]";
    if (audioLabels.length > 1) {
      filters.push(
        `${audioLabels.join("")}amix=inputs=${audioLabels.length}:normalize=0:duration=longest[amix]`,
      );
    }
    // Conformed to the film, so a sound placed near the end cannot extend it and one that stops
    // early does not shorten it.
    filters.push(
      `${mixed}apad=whole_dur=${plan.totalSec},atrim=duration=${plan.totalSec},asetpts=PTS-STARTPTS[aout]`,
    );
  }

  args.push("-filter_complex", filters.join(";"), "-map", `[${last}]`);
  if (audioLabels.length > 0) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  args.push("-crf", String(PRESETS[plan.preset].crf), outFile);
  return args;
}
