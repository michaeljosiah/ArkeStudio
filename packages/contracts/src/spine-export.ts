import { PRESETS, type ExportPreset } from "./cut.js";
import type { DerivedSpineCut, SpineCutSegment } from "./spine-cut.js";

/**
 * Rendering a spine cut (#253, SPEC-013 R-19..R-21, D10, D11).
 *
 * The picture is already a timeline by the time it arrives here — `deriveSpineCut` laid every
 * segment against the master and made them contiguous from zero to the song's measured end. So
 * this adds the one thing the derivation deliberately has no opinion about: sound.
 *
 * The master track plays across the whole export, unducked. A generated clip's own audio is the
 * model's invention and is muted unless the anchor said otherwise, and when it is kept it rides
 * *under* the master at the gain the anchor stated. Nothing here decides a mix: a bed that dips
 * whenever a clip has audio is a mix nobody chose, arriving at export.
 */

/** The frame grid is where "too small to render" becomes a question with an answer. */
function frameFloor(sec: number, fps: number): number {
  return Math.round(sec * fps) / fps;
}

export type SpineExportItem =
  | { type: "clip"; path: string; inSec: number; outSec: number; durationSec: number; label: string; audio: { gainDb: number; atSec: number } | null }
  | { type: "slate"; label: string; durationSec: number }
  | { type: "black"; durationSec: number };

export interface SpineExportPlan {
  preset: ExportPreset;
  /** World-relative path of the master. The picture is cut to it; it is never cut to the picture. */
  trackPath: string;
  items: SpineExportItem[];
  totalSec: number;
}

/**
 * Why a cut is not ready to leave the building.
 *
 * A review cut renders whatever exists, because seeing the gaps against the song is the entire
 * point of watching one. A master with a slate in it is a film with a hole in it, and the moment
 * to say so is before an encode, not after somebody sends it on.
 */
export interface SpineExportRefusal {
  reason: "incomplete";
  detail: string;
  missingSec: number;
}

export function spineExportRefusals(cut: DerivedSpineCut, preset: ExportPreset): SpineExportRefusal | null {
  if (preset === "review-cut") return null;
  const missingSec = cut.slateSec + cut.blackSec;
  if (missingSec <= 0) return null;
  const shots = cut.segments.filter((s) => s.kind === "slate").length;
  return {
    reason: "incomplete",
    detail:
      shots > 0
        ? `${shots} shot${shots === 1 ? "" : "s"} and ${cut.blackSec.toFixed(1)}s of unanchored song have no picture`
        : `${cut.blackSec.toFixed(1)}s of the song has no picture`,
    missingSec,
  };
}

/**
 * Lay the derived segments out as render items.
 *
 * Durations are quantised to the preset's frame grid here rather than in the derivation, which
 * reports exact seconds on purpose. A segment shorter than a frame collapses to nothing and is
 * dropped — that is the honest place for the rounding the derivation refuses to do, because a
 * frame is a real unit and a millionth of a second is not.
 */
export function buildSpineExportPlan(cut: DerivedSpineCut, preset: ExportPreset, trackPath: string): SpineExportPlan {
  const { fps } = PRESETS[preset];
  const items: SpineExportItem[] = [];
  let totalSec = 0;
  for (const segment of cut.segments) {
    const durationSec = frameFloor(segment.endSec - segment.startSec, fps);
    if (durationSec <= 0) continue;
    items.push(itemFor(segment, durationSec));
    totalSec += durationSec;
  }
  return { preset, trackPath, items, totalSec };
}

function itemFor(segment: SpineCutSegment, durationSec: number): SpineExportItem {
  if (segment.kind === "black") return { type: "black", durationSec };
  if (segment.kind === "slate") return { type: "slate", label: segment.label, durationSec };
  const media = segment.media!;
  return {
    type: "clip",
    path: media.path,
    inSec: media.inSec,
    outSec: media.outSec,
    durationSec,
    label: segment.label,
    // Mute is the default because the sound is the model's invention. Keeping it is a decision
    // recorded on the anchor, and it arrives here as the gain that decision named.
    audio:
      segment.clipAudio?.mode === "keep-diegetic"
        ? { gainDb: segment.clipAudio.gainDb, atSec: segment.startSec }
        : null,
  };
}

/**
 * One ffmpeg invocation for the whole plan (D11).
 *
 * The master is a single input mixed at unity; kept clip audio is delayed to its position in the
 * song and attenuated to its stated gain. `normalize=0` on the mix is load-bearing: amix's
 * default divides every input by the number of inputs, so a shot that keeps its audio would
 * quietly pull the song down for exactly its duration — the automatic duck this design refuses.
 */
export function buildSpineFfmpegArgs(plan: SpineExportPlan, worldDir: string, outFile: string): string[] {
  const p = PRESETS[plan.preset];
  const args: string[] = ["-y"];
  const filters: string[] = [];
  const audioLabels: string[] = [];
  let index = 0;

  for (const item of plan.items) {
    if (item.type === "clip") {
      // Input-level seeking so the audio arrives windowed exactly like the picture.
      args.push("-ss", String(item.inSec), "-to", String(item.outSec), "-i", `${worldDir}/${item.path}`);
      filters.push(
        `[${index}:v]scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${p.fps}[v${index}]`,
      );
      if (item.audio) {
        const delayMs = Math.round(item.audio.atSec * 1000);
        filters.push(`[${index}:a]adelay=${delayMs}:all=1,volume=${item.audio.gainDb}dB[a${index}]`);
        audioLabels.push(`[a${index}]`);
      }
    } else {
      args.push("-f", "lavfi", "-t", String(item.durationSec), "-i", `color=c=black:s=${p.width}x${p.height}:r=${p.fps}`);
      if (item.type === "slate") {
        // A black slate reading "SHOT 15 · 6.0s" beats a silent omission (R-20, D10).
        const text = item.label.replace(/[':\\]/g, " ");
        filters.push(`[${index}:v]drawtext=text='${text}':fontcolor=white:fontsize=48:x=(w-tw)/2:y=(h-th)/2[v${index}]`);
      } else {
        filters.push(`[${index}:v]null[v${index}]`);
      }
    }
    index += 1;
  }

  const trackIndex = index;
  args.push("-i", `${worldDir}/${plan.trackPath}`);

  const concat = plan.items.map((_, i) => `[v${i}]`).join("");
  filters.push(`${concat}concat=n=${plan.items.length}:v=1:a=0[out]`);

  if (audioLabels.length > 0) {
    filters.push(`[${trackIndex}:a]anull[master]`);
    filters.push(`[master]${audioLabels.join("")}amix=inputs=${audioLabels.length + 1}:normalize=0:duration=first[aout]`);
  } else {
    filters.push(`[${trackIndex}:a]anull[aout]`);
  }

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-map",
    "[aout]",
    "-crf",
    String(p.crf),
    // The song is the clock, so the encode ends when the song does.
    "-t",
    String(plan.totalSec),
    outFile,
  );
  return args;
}
