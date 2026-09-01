import { pictureAtSec, pictureEdges, type ExportPlan } from "@arke-studio/contracts";
import type { PlaybackSpan } from "./cut-playback.js";

/**
 * The browser executor's reading of the render plan (SPEC-038 R-1, R-8, D1; issue #680).
 *
 * The preview does not walk the story, the lanes or the timeline: it asks the plan what is
 * visible between every pair of edges where the answer could change, and plays that. The FFmpeg
 * builder reads the same plan, so a placed still appears in the viewer at exactly the window the
 * file will show it (GitHub issue #486).
 */
export function planSpans(plan: ExportPlan): PlaybackSpan[] {
  const edges = pictureEdges(plan);
  const spans: PlaybackSpan[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const startSec = edges[index]!;
    const endSec = edges[index + 1]!;
    if (endSec <= startSec) continue;
    const visible = pictureAtSec(plan, startSec);
    if (visible === null) continue;
    const last = spans[spans.length - 1];
    // Adjacent windows of one continuous source merge, so a clip under a short overlay does not
    // reload when the overlay ends and its own source resumes at the right offset.
    if (
      last !== undefined &&
      last.path === visible.path &&
      last.label === visible.label &&
      (last.still ?? false) === visible.still &&
      last.endSec === startSec &&
      (visible.path === null || last.mediaInSec + (startSec - last.startSec) === visible.sourceSec)
    ) {
      last.endSec = endSec;
      continue;
    }
    spans.push({
      startSec,
      endSec,
      path: visible.path,
      mediaInSec: visible.sourceSec,
      label: visible.label,
      ...(visible.still ? { still: true } : {}),
    });
  }
  return spans;
}
