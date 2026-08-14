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
  /*
   * Any named problem disqualifies, not merely visible holes (Codex round 1).
   *
   * Counting slate and black seconds asks "does picture cover the song", which a cut can pass
   * while still being unfit to deliver: an `unmeasured` take fills its window on an assumption
   * nobody verified, and `overlaps` means two shots claim the same seconds and one of them was
   * silently dropped. Both leave the timeline visually complete. A master is a claim that the
   * film is finished, and every problem the derivation names is a reason that claim is not yet
   * true -- so the check is for problems, and the seconds are only how it is described.
   */
  if (missingSec <= 0 && cut.problems.length === 0) return null;

  const kinds = [...new Set(cut.problems.map((p) => p.kind))].sort();
  const shots = cut.segments.filter((s) => s.kind === "slate").length;
  const holes =
    shots > 0
      ? `${shots} shot${shots === 1 ? "" : "s"} and ${cut.blackSec.toFixed(1)}s of unanchored song have no picture`
      : missingSec > 0
        ? `${cut.blackSec.toFixed(1)}s of the song has no picture`
        : "picture covers the song";
  return {
    reason: "incomplete",
    detail: kinds.length > 0 ? `${holes}; unresolved: ${kinds.join(", ")}` : holes,
    missingSec,
  };
}

/**
 * Lay the derived segments out as render items.
 *
 * Boundaries are quantised, not durations (Codex round 1). Rounding each length independently
 * lets error accumulate: sixty contiguous 1.02s segments each round to 1s, and the export ends a
 * minute into a song that runs 61.2s, truncated by its own `-t`. Snapping absolute positions to
 * the grid keeps adjacent items sharing a frame boundary and keeps the total equal to the song.
 *
 * This is where rounding belongs. The derivation reports exact seconds on purpose; a frame is a
 * real unit and a millionth of a second is not, so a segment that lands between two frame
 * boundaries collapses and is dropped here rather than being invented into a frame it never had.
 */
export function buildSpineExportPlan(cut: DerivedSpineCut, preset: ExportPreset, trackPath: string): SpineExportPlan {
  const { fps } = PRESETS[preset];
  const grid = (sec: number): number => Math.round(sec * fps) / fps;
  const items: SpineExportItem[] = [];
  for (const segment of cut.segments) {
    const startSec = grid(segment.startSec);
    const durationSec = grid(segment.endSec) - startSec;
    if (durationSec <= 0) continue;
    items.push(itemFor(segment, startSec, durationSec));
  }
  return { preset, trackPath, items, totalSec: grid(cut.trackDurationSec) };
}

function itemFor(segment: SpineCutSegment, startSec: number, durationSec: number): SpineExportItem {
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
    /*
     * Only when the file is *known* to carry a stream (Codex rounds 1 and 2).
     *
     * Referencing an audio input that is not there fails the whole export rather than the one
     * shot. `!== false` handled a measured silence and still treated the unknown state as
     * present -- and unknown is exactly the state a review cut is allowed to be in, since it
     * tolerates the `unmeasured` problem a master refuses. An unprobed clip is not evidence of
     * audio, so nothing is kept from it.
     */
    audio:
      segment.clipAudio?.mode === "keep-diegetic" && segment.hasAudio === true
        ? // The quantised start, the same one the picture was placed at: delaying the audio to
          // the unrounded boundary while the picture sits on the grid puts them up to half a
          // frame apart for no reason anybody chose (Codex round 4).
          { gainDb: segment.clipAudio.gainDb, atSec: startSec }
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
      // Input-level seeking so the audio arrives windowed exactly like the picture. The read
      // stays inside [inSec, outSec) because the far side of a pass segment is the next shot.
      args.push("-ss", String(item.inSec), "-to", String(item.outSec), "-i", `${worldDir}/${item.path}`);
      /*
       * Conformed to the planned duration, not merely resampled to the frame rate (Codex round 2).
       *
       * Quantising the plan's boundaries fixed the arithmetic and not the render: `fps` rounds
       * each clip from its own source length independently, so sixty 1.02s segments each became
       * 24 frames and the drift the boundaries had just eliminated came back through the filter
       * graph. Padding by cloning the last frame and then trimming yields exactly the planned
       * length whether the source ran a fraction long or a fraction short -- a sub-frame conform,
       * which is what the residue the derivation refused to round always was.
       */
      const d = item.durationSec;
      filters.push(
        `[${index}:v]scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${p.fps},tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d},setpts=PTS-STARTPTS[v${index}]`,
      );
      if (item.audio) {
        const delayMs = Math.round(item.audio.atSec * 1000);
        filters.push(
          `[${index}:a]apad=whole_dur=${d},atrim=duration=${d},asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1,volume=${item.audio.gainDb}dB[a${index}]`,
        );
        audioLabels.push(`[a${index}]`);
      }
    } else {
      args.push("-f", "lavfi", "-t", String(item.durationSec), "-i", `color=c=black:s=${p.width}x${p.height}:r=${p.fps}`);
      if (item.type === "slate") {
        // A black slate reading "SHOT 15 · 6.0s" beats a silent omission (R-20, D10).
        // expansion=none: a shot titled "100% Practical" is a label, not a drawtext expression.
        // ffmpeg expands %{...} in text by default, so a percent sign in somebody's own shot
        // title could fail their review cut instead of appearing on the slate (Codex round 1).
        const text = item.label.replace(/[':\\]/g, " ");
        filters.push(
          `[${index}:v]drawtext=expansion=none:text='${text}':fontcolor=white:fontsize=48:x=(w-tw)/2:y=(h-th)/2[v${index}]`,
        );
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
