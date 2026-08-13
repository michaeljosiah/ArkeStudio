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
  // Compared against the furthest endpoint seen so far, not merely the previous anchor.
  // Sorting by start puts a long anchor first, so [0,100) [1,2) [3,4) would report the second and
  // clear the third — it is checked against [1,2) and looks fine, while sitting inside [0,100)
  // all along. A running maximum is what makes every conflicting shot get named.
  let furthest: { shotId: string; endSec: number } | null = null;
  for (const { shotId, anchor } of ordered) {
    // Half-open ranges: touching is legal, so this is a strict comparison on purpose.
    if (furthest !== null && anchor.startSec < furthest.endSec) {
      problems.push({
        shotId,
        kind: "overlaps",
        // The intersection, not the distance to the furthest end (Codex round 2): [0,100) then
        // [1,2) overlap by one second, and reporting 99 tells the user to move something 99
        // seconds. The number is there to be acted on.
        detail: `overlaps ${furthest.shotId} by ${(Math.min(furthest.endSec, anchor.endSec) - anchor.startSec).toFixed(3)}s`,
      });
    }
    if (furthest === null || anchor.endSec > furthest.endSec) furthest = { shotId, endSec: anchor.endSec };
  }
  return problems;
}

/** The shot's window in seconds — the budget every spine-aware plan measures material against. */
export function anchorBudgetSec(anchor: SpineAnchor): number {
  return anchor.endSec - anchor.startSec;
}

// ---------------------------------------------------------------------------
// Marker import (#253): a map somebody else made, read exactly or not at all
// ---------------------------------------------------------------------------

/**
 * Why an import was refused, in terms of the file the user is looking at.
 *
 * `line` is one-based because that is what an editor shows. A parser that reports "index 16" for
 * the seventeenth line is a parser nobody can act on without counting.
 */
export interface MarkerImportRefusal {
  message: string;
  /** One-based line of the offending row, for LRC. Absent for a whole-document JSON failure. */
  line?: number;
  /** Dotted path of the offending row, for JSON. Absent for LRC. */
  path?: string;
}

export type MarkerImportResult<T> = { ok: true; value: T } | { ok: false; refusal: MarkerImportRefusal };

/**
 * Standard LRC metadata, and the only tags ignored rather than refused.
 *
 * Anchored at both ends on purpose. Matching the prefix alone swallowed `[ar:Artist` — unclosed,
 * and therefore a line somebody mistyped — and worse, `[ar:Artist][00:30]words`, which would
 * discard a real lyric marker as though the whole line were a tag.
 */
const LRC_METADATA = /^\[(ar|al|ti|by):[^\]]*\]$/i;
const LRC_OFFSET = /^\[offset:\s*([+-]?\d+)\s*\]$/i;
/** `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss.xxx]` — nothing looser, because a guess here moves a lyric. */
const LRC_STAMP = /\[(\d{1,3}):([0-5]\d)(?:\.(\d{1,3}))?\]/g;

/**
 * Parse an LRC lyric sheet into timed lines (#253).
 *
 * Strict on purpose. A lyric marker is what a shot gets anchored to, so a timestamp read
 * generously — `[1:0d.20]` taken as 1:00, a three-minute mark parsed as three seconds — silently
 * moves a shot to the wrong bar, and the person who imported it has no way to know. Any nonblank
 * line that is neither metadata, offset, nor at least one timestamp followed by text refuses the
 * whole file and says which line.
 *
 * Refusing wholesale rather than skipping bad rows is the same argument: half a lyric sheet is
 * worse than none, because the markers you kept are the ones the file happened to list first.
 */
export function parseLrc(
  text: string,
  /**
   * The measured master duration, when there is one. A lyric past the end of the song belongs to
   * a different recording, and refusing it *here* is the only place the offending line number
   * still exists — the JSON-shaped helper can only say `lyrics[7]`, which is not what the person
   * is looking at.
   */
  trackDurationSec?: number,
): MarkerImportResult<Array<{ text: string; atSec: number }>> {
  const lines = text.split(/\r?\n/);
  let offsetMs = 0;
  const rows: Array<{ text: string; atSec: number; order: number }> = [];

  // The offset applies to every timestamp in the file including ones read before it, so it is
  // resolved in its own pass rather than mid-parse.
  for (const raw of lines) {
    const match = LRC_OFFSET.exec(raw.trim());
    if (match) offsetMs = Number(match[1]);
  }

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (LRC_METADATA.test(line) || LRC_OFFSET.test(line)) continue;

    LRC_STAMP.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    let consumed = 0;
    while ((match = LRC_STAMP.exec(line)) !== null) {
      // Stop at the first stamp that is not contiguous with the run; whatever it is, the body
      // scan below decides whether the row is refused.
      if (match.index !== consumed) break;
      consumed = match.index + match[0].length;
      consumed = match.index + match[0].length;
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      // ".5" is five tenths and ".05" is five hundredths — padding right, not left, is the
      // difference between a marker at 30.5s and one at 30.05s.
      const fraction = match[3] ? Number(match[3].padEnd(3, "0")) / 1000 : 0;
      stamps.push(minutes * 60 + seconds + fraction);
    }
    if (stamps.length === 0) {
      return { ok: false, refusal: { line: index + 1, message: `${line} is not a timestamped lyric line` } };
    }
    const body = line.slice(consumed).trim();
    if (body.length === 0) {
      return { ok: false, refusal: { line: index + 1, message: `line ${index + 1} has a timestamp and no words` } };
    }
    // A second bracket where the words should start is a timestamp this parser did not accept —
    // `[00:30][00:61]first` would otherwise keep the first stamp and make `[00:61]first` the
    // lyric, quietly dropping the repeat the file asked for and burying a malformed row inside
    // text. Refusing is the only reading consistent with importing wholesale or not at all.
    /*
     * One rule, because the narrow ones kept missing a corner (Codex rounds 1-3).
     *
     * The failures form a square: a stamp may be well-formed or malformed, and it may sit at the
     * start of the words or later in them. Round 1 guarded malformed-at-start, round 2 guarded
     * well-formed-later, and malformed-later — `[00:30]first[00:61]second` — fell through both,
     * keeping one marker whose words were "first[00:61]second" and losing the intended one.
     *
     * So the body is scanned for anything timestamp-*shaped* anywhere in it: an open bracket, a
     * one-to-three digit number, a colon. That covers all four corners at once and refuses the
     * whole row, which is the promise. Bracketed lyric text that is not shaped like a time —
     * "[chorus]", "[ad lib]" — still passes, because the point is catching mistyped times rather
     * than punishing brackets.
     */
    const timestampish = /\[\s*\d{1,3}\s*:/.exec(body);
    if (timestampish !== null) {
      const token = body.slice(timestampish.index).split("]")[0];
      return {
        ok: false,
        refusal: {
          line: index + 1,
          message: `${token}] is a timestamp among the words — every stamp belongs before them`,
        },
      };
    }
    for (const atSec of stamps) {
      const shifted = atSec + offsetMs / 1000;
      if (shifted < 0) {
        return {
          ok: false,
          refusal: {
            line: index + 1,
            message: `offset ${offsetMs}ms moves ${body} to ${shifted.toFixed(3)}s, before the song starts`,
          },
        };
      }
      if (trackDurationSec !== undefined && shifted > trackDurationSec) {
        return {
          ok: false,
          refusal: {
            line: index + 1,
            message: `${body} at ${shifted.toFixed(3)}s is past the track's ${trackDurationSec.toFixed(3)}s`,
          },
        };
      }
      // Multiple stamps on one line are one marker each, all carrying the same words — that is
      // what a repeated chorus line looks like in every LRC file in the wild.
      rows.push({ text: body, atSec: shifted, order: rows.length });
    }
  }
  return { ok: true, value: rows.map(({ text: body, atSec }) => ({ text: body, atSec })) };
}

/**
 * Turn imported rows into markers, refusing anything past the end of the song.
 *
 * A marker at 4:10 of a 3:42 track is not a late lyric, it is a file that belongs to a different
 * recording — and accepting it would put a section label somewhere no shot can ever be anchored.
 * `mintId` is injected so the caller owns id generation and this stays pure.
 */
export function markersFromImport(
  imported: SpineMarkerImport,
  trackDurationSec: number,
  mintId: () => string,
): MarkerImportResult<SpineMarker[]> {
  // Every row is checked before a single id is minted (Codex round 2). Minting as it went meant a
  // refused import had already advanced a stateful allocator — an id burned for a marker that
  // never existed, from a function whose whole contract is that it changes nothing on refusal.
  for (const [index, section] of imported.sections.entries()) {
    if (section.atSec > trackDurationSec) {
      return {
        ok: false,
        refusal: {
          path: `sections[${index}]`,
          message: `${section.label} at ${section.atSec}s is past the track's ${trackDurationSec.toFixed(3)}s`,
        },
      };
    }
  }
  for (const [index, lyric] of imported.lyrics.entries()) {
    if (lyric.atSec > trackDurationSec) {
      return {
        ok: false,
        refusal: {
          path: `lyrics[${index}]`,
          message: `${lyric.text} at ${lyric.atSec}s is past the track's ${trackDurationSec.toFixed(3)}s`,
        },
      };
    }
  }
  const markers: SpineMarker[] = [
    ...imported.sections.map((section): SpineMarker => ({
      kind: "section", id: mintId(), label: section.label, atSec: section.atSec, source: "json",
    })),
    ...imported.lyrics.map((lyric): SpineMarker => ({
      kind: "lyric", id: mintId(), text: lyric.text, atSec: lyric.atSec, source: "json",
    })),
  ];
  return { ok: true, value: orderedMarkers(markers) };
}

/**
 * What the spine's markers become after an import is accepted.
 *
 * A JSON import owns both kinds and replaces both. An LRC file is a lyric sheet and says nothing
 * about song structure, so it replaces lyrics alone — importing one must not cost the sections
 * somebody placed by hand. Neither touches anchors: markers describe the song, anchors describe
 * the film, and re-importing a corrected lyric sheet should never move a shot.
 */
export function applyMarkerImport(
  existing: readonly SpineMarker[],
  imported: readonly SpineMarker[],
  scope: "sections-and-lyrics" | "lyrics-only",
): SpineMarker[] {
  const kept = scope === "lyrics-only" ? existing.filter((marker) => marker.kind === "section") : [];
  return orderedMarkers([...kept, ...imported]);
}
