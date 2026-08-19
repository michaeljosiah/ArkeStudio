import { z } from "zod";
import { ArtifactIdSchema, ShotIdSchema, SlugSchema, TakeIdSchema, prefixedIdSchema } from "./ids.js";
import type { ProductionBundle } from "./client-state.js";
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
// Overlays (82a) — the one thing on the cut whose position a person chooses
// ---------------------------------------------------------------------------

/**
 * An artifact laid over the picture for a window you placed it in (82a).
 *
 * It is deliberately four fields. An overlay cites an artifact and says when; it carries no
 * provenance, no canon revision, no cost and no review, because nothing about it was dispatched
 * or judged — it is not a take and never becomes one. Deleting it removes the placement and
 * never the artifact.
 *
 * This is the only stored *position* on the cut, and it is why it lives on its own lane: the
 * picture stays derived (R-14), so there is still exactly one answer to where a shot sits.
 */
export const CutOverlaySchema = z
  .object({
    id: prefixedIdSchema("ov"),
    artifactId: ArtifactIdSchema,
    startSec: z.number().min(0),
    endSec: z.number().positive(),
  })
  .strict()
  .refine((v) => v.endSec > v.startSec, { message: "endSec must be greater than startSec", path: ["endSec"] });
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
  const takesById = new Map(production.takes.map((t) => [t.id, t]));
  const entries: CutEntry[] = [];
  // Explicit scene order, with the birth number as the legacy fallback (issue #387): the
  // ordinary cut follows the same sequence every display shows.
  for (const scene of sortScenes(production.scenes)) {
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
          // No `inSec` at all when nothing is trimmed, so an untrimmed export is byte-identical
          // to the one this repo has always produced.
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
  | { type: "slate"; label: string; durationSec: number };

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
  totalSec: number;
}

/** Which artifact kinds are picture. Audio belongs on its own track; a document is not a frame. */
const OVERLAY_STILL_KINDS: ReadonlySet<string> = new Set(["image", "board"]);

/**
 * Resolve filed overlays against the world's artifacts (82a).
 *
 * An overlay citing an artifact this world does not have is dropped rather than guessed at, and
 * one citing something that is not picture — an audio file, a document — is dropped too: the OV
 * lane accepts anything draggable, and the exporter is where "over the picture" has to mean
 * something. Both are silent here and counted by the caller, never rendered as an absence.
 */
export function exportOverlays(
  overlays: readonly CutOverlay[],
  artifacts: readonly { id: string; file: string; kind: string }[],
): ExportOverlay[] {
  const resolved: ExportOverlay[] = [];
  for (const overlay of [...overlays].sort((a, b) => a.startSec - b.startSec)) {
    const artifact = artifacts.find((a) => a.id === overlay.artifactId);
    if (artifact === undefined) continue;
    const still = OVERLAY_STILL_KINDS.has(artifact.kind);
    if (!still && artifact.kind !== "video") continue;
    resolved.push({ path: artifact.file, startSec: overlay.startSec, endSec: overlay.endSec, still });
  }
  return resolved;
}

/** Assemble from the derived cut: accepted material as clips, gaps as slates (D10, D11). */
export function buildExportPlan(cut: DerivedCut, preset: ExportPreset, overlays: readonly ExportOverlay[] = []): ExportPlan {
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
  return { preset, items, overlays: [...overlays], totalSec: cut.totalSec };
}

/**
 * One ffmpeg invocation for the whole plan (D11): slates from the lavfi color source with a
 * drawtext label; clips trimmed by their ranges; everything concatenated in a single encode.
 */
export function buildFfmpegArgs(plan: ExportPlan, worldDir: string, outFile: string): string[] {
  const p = PRESETS[plan.preset];
  const args: string[] = ["-y"];
  const filters: string[] = [];
  let inputIndex = 0;
  for (const item of plan.items) {
    if (item.type === "clip") {
      if (item.inSec !== undefined) args.push("-ss", String(item.inSec));
      if (item.outSec !== undefined) args.push("-to", String(item.outSec));
      args.push("-i", `${worldDir}/${item.path}`);
      filters.push(
        `[${inputIndex}:v]scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${p.fps}[v${inputIndex}]`,
      );
    } else {
      args.push("-f", "lavfi", "-t", String(item.durationSec), "-i", `color=c=black:s=${p.width}x${p.height}:r=${p.fps}`);
      const text = item.label.replace(/[':\\]/g, " ");
      filters.push(`[${inputIndex}:v]drawtext=text='${text}':fontcolor=white:fontsize=48:x=(w-tw)/2:y=(h-th)/2[v${inputIndex}]`);
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

  args.push("-filter_complex", filters.join(";"), "-map", `[${last}]`, "-crf", String(PRESETS[plan.preset].crf), outFile);
  return args;
}
