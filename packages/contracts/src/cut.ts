import { z } from "zod";
import { ArtifactIdSchema, ShotIdSchema, SlugSchema, TakeIdSchema } from "./ids.js";
import type { ProductionBundle } from "./client-state.js";
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

/** cut.json: audio only (R-16). The picture sequence is derived, deliberately absent. */
export const CutFileSchema = z
  .object({
    audio: z.array(AudioTrackSchema).default([]),
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
  for (const scene of [...production.scenes].sort((a, b) => a.number - b.number)) {
    for (const shot of scene.shots) {
      const takeId = production.selections[shot.id]?.acceptedTakeId ?? null;
      const take = takeId !== null ? (takesById.get(takeId) ?? null) : null;
      let media: CutEntry["media"] = null;
      if (take) {
        if (take.segment) {
          const pass = takesById.get(take.segment.passTakeId);
          media = pass?.media
            ? {
                path: `productions/${production.meta.id}/takes/${pass.id}/${pass.media}`,
                inSec: take.segment.inSec,
                outSec: take.segment.outSec,
              }
            : null;
        } else if (take.media) {
          media = { path: `productions/${production.meta.id}/takes/${take.id}/${take.media}` };
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

export interface ExportPlan {
  preset: ExportPreset;
  items: ExportItem[];
  totalSec: number;
}

/** Assemble from the derived cut: accepted material as clips, gaps as slates (D10, D11). */
export function buildExportPlan(cut: DerivedCut, preset: ExportPreset): ExportPlan {
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
  return { preset, items, totalSec: cut.totalSec };
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
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-crf", String(PRESETS[plan.preset].crf), outFile);
  return args;
}
