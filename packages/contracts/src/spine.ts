import { z } from "zod";
import { ArtifactIdSchema, IsoDateTimeSchema, ShotIdSchema, prefixedIdSchema } from "./ids.js";

/**
 * The audio spine (#253, design turn 60): a master track as the production's timeline.
 *
 * For a music video the song *is* the clock. Every shot exists at a timestamp in it, and a cut
 * only means anything played against the track — which today means keeping the timing map in a
 * side document and eyeballing it in another application.
 *
 * The sole authority is `productions/<productionId>/spine.json`. Nothing here is duplicated into
 * `production.json`, `cut.json`, scene files or selections: two records of one timeline disagree
 * eventually, and the disagreement presents as a cut that plays correctly for the person who
 * made it and nobody else.
 */

export const SpineMarkerIdSchema = prefixedIdSchema("mk");

/**
 * A point on the track worth naming. Sections carve the song up ("Verse 1"); lyrics say what is
 * being sung at a moment, so a shot can be anchored to a line rather than to a stopwatch.
 *
 * `source` is kept because it decides what a later import may replace: a JSON import replaces
 * sections and lyrics, an LRC import replaces lyrics alone, and a marker somebody placed by hand
 * should not be silently outlived by a file they imported for a different purpose.
 */
export const SpineMarkerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("section"),
      id: SpineMarkerIdSchema,
      label: z.string().trim().min(1),
      atSec: z.number().min(0),
      source: z.enum(["manual", "json"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("lyric"),
      id: SpineMarkerIdSchema,
      text: z.string().trim().min(1),
      atSec: z.number().min(0),
      source: z.enum(["manual", "json", "lrc"]),
    })
    .strict(),
]);
export type SpineMarker = z.infer<typeof SpineMarkerSchema>;

/**
 * What happens to a generated clip's own audio when the song is playing over it.
 *
 * Mute is the default because a generated clip's soundtrack is the model's invention, and the
 * master track is the thing being cut to. Keeping it is a deliberate choice for the shots where
 * the sound is the point — a saxophone case opening on wet tarmac — and it rides *under* the
 * master at a stated gain rather than fighting it. The master never ducks automatically: a bed
 * that dips whenever a clip has audio is a mix nobody chose, arriving at export.
 */
export const ClipAudioPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("mute") }).strict(),
  z
    .object({
      mode: z.literal("keep-diegetic"),
      gainDb: z.number().min(-60).max(0).default(-12),
    })
    .strict(),
]);
export type ClipAudioPolicy = z.infer<typeof ClipAudioPolicySchema>;

/**
 * Where one shot sits in the song: a half-open range `[startSec, endSec)` against the master.
 *
 * Half-open so that touching anchors are legal and a boundary belongs to exactly one shot — the
 * alternative is a frame that two shots both claim, resolved by whichever the code happens to
 * read second. `endSec - startSec` is the shot's duration budget everywhere spine-aware planning
 * runs; `shot.durationSec` stays the authored fallback for unanchored shots and productions with
 * no spine, and anchoring never rewrites it.
 */
export const SpineAnchorSchema = z
  .object({
    startSec: z.number().min(0),
    endSec: z.number().positive(),
    clipAudio: ClipAudioPolicySchema.default({ mode: "mute" }),
  })
  .strict()
  .refine((value) => value.endSec > value.startSec, {
    message: "endSec must be greater than startSec",
    path: ["endSec"],
  });
export type SpineAnchor = z.infer<typeof SpineAnchorSchema>;

/**
 * `productions/<productionId>/spine.json`.
 *
 * `revision` increments exactly once per accepted edit and is what a stale write is caught by:
 * anchors are never silently merged, because two people dragging the same twelve seconds is not
 * a conflict a machine can split the difference on.
 */
export const ProductionSpineSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().min(1),
    trackArtifactId: ArtifactIdSchema,
    markers: z.array(SpineMarkerSchema).default([]),
    anchors: z.record(ShotIdSchema, SpineAnchorSchema).default({}),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type ProductionSpine = z.infer<typeof ProductionSpineSchema>;

const ImportedSectionSchema = z
  .object({
    label: z.string().trim().min(1),
    atSec: z.number().min(0),
  })
  .strict();

const ImportedLyricSchema = z
  .object({
    text: z.string().trim().min(1),
    atSec: z.number().min(0),
  })
  .strict();

/**
 * The one JSON marker format Arke accepts. Both arrays are required and may be empty — an import
 * that omitted `lyrics` and one that supplied `[]` would otherwise mean the same thing on the way
 * in and different things on the way out.
 */
export const SpineMarkerImportSchema = z
  .object({
    sections: z.array(ImportedSectionSchema),
    lyrics: z.array(ImportedLyricSchema),
  })
  .strict();
export type SpineMarkerImport = z.infer<typeof SpineMarkerImportSchema>;

/**
 * Markers in the order they are stored and shown: ascending time, insertion order preserved on a
 * tie. Sorted on every write rather than on every read — a file a person opens by hand should
 * already be in the order they expect, and a tie broken differently by two readers is a lyric
 * that changes places depending on who is looking.
 */
export function orderedMarkers(markers: readonly SpineMarker[]): SpineMarker[] {
  return markers
    .map((marker, index) => ({ marker, index }))
    .sort((a, b) => (a.marker.atSec === b.marker.atSec ? a.index - b.index : a.marker.atSec - b.marker.atSec))
    .map((entry) => entry.marker);
}

/** Anchors in play order, which is the order the spine-aware cut uses — never scene order. */
export function orderedAnchors(spine: ProductionSpine): Array<{ shotId: string; anchor: SpineAnchor }> {
  return Object.entries(spine.anchors)
    .map(([shotId, anchor]) => ({ shotId, anchor }))
    .sort((a, b) => a.anchor.startSec - b.anchor.startSec);
}

/**
 * Every reason a set of anchors is not yet a timeline, named rather than counted.
 *
 * Overlap is checked here rather than at export because an overlap discovered at export is a cut
 * somebody has already watched and believed. `trackDurationSec` is the measured length of the
 * master: an anchor past the end of the song is not a long shot, it is a shot that does not exist.
 */
export function anchorProblems(
  spine: ProductionSpine,
  trackDurationSec: number,
  shotIds: ReadonlySet<string>,
): Array<{ shotId: string; kind: "orphaned" | "out-of-bounds" | "overlaps"; detail: string }> {
  const problems: Array<{ shotId: string; kind: "orphaned" | "out-of-bounds" | "overlaps"; detail: string }> = [];
  const ordered = orderedAnchors(spine);
  for (const { shotId, anchor } of ordered) {
    if (!shotIds.has(shotId)) {
      // Deleting a shot does not silently delete its place in the song: twelve seconds nobody
      // agreed to give up would otherwise vanish from the cut with no record that they had.
      problems.push({ shotId, kind: "orphaned", detail: `${shotId} is anchored but no longer a shot` });
    }
    if (anchor.endSec > trackDurationSec) {
      problems.push({
        shotId,
        kind: "out-of-bounds",
        detail: `ends at ${anchor.endSec.toFixed(3)}s, past the track's ${trackDurationSec.toFixed(3)}s`,
      });
    }
  }
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    // Half-open ranges: touching is legal, so this is a strict comparison on purpose.
    if (current.anchor.startSec < previous.anchor.endSec) {
      problems.push({
        shotId: current.shotId,
        kind: "overlaps",
        detail: `overlaps ${previous.shotId} by ${(previous.anchor.endSec - current.anchor.startSec).toFixed(3)}s`,
      });
    }
  }
  return problems;
}

/** The shot's window in seconds — the budget every spine-aware plan measures material against. */
export function anchorBudgetSec(anchor: SpineAnchor): number {
  return anchor.endSec - anchor.startSec;
}
