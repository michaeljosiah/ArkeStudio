import type { ProductionBundle } from "./client-state.js";
import type { Take } from "./take.js";
import { anchorBudgetSec, anchorProblems, orderedAnchors, type ClipAudioPolicy, type ProductionSpine } from "./spine.js";

/**
 * The picture cut of a production that is cut to a track (#253, SPEC-013 D9).
 *
 * `deriveCut` answers "what does the film contain" by laying shots end to end and summing their
 * authored durations. That question has a different answer once a spine exists: the song is the
 * clock, its length is fixed before a single shot is generated, and a shot's duration is the
 * window it was anchored to. Deriving picture from shot order would produce a second timeline
 * disagreeing with the first, which is exactly what storing a sequence was avoided to prevent.
 *
 * So this walks the *track* from zero to its measured end and asks what covers each moment.
 * Everything the walk cannot cover is emitted as a segment too. A cut with eleven seconds of
 * black in the second verse is a true statement about where the work is; a cut that quietly
 * runs eleven seconds short is not, and it is the one nobody notices until the export is
 * playing next to the song.
 */

/** Below a millionth of a second is float noise, not a gap — one frame at 24fps is 0.0417s. */
const EPSILON = 1e-6;

export type SpineCutSegmentKind = "clip" | "slate" | "black";

export interface SpineCutSegment {
  kind: SpineCutSegmentKind;
  /** Position on the master, not on the assembled picture: the two are the same by construction. */
  startSec: number;
  endSec: number;
  label: string;
  shotId?: string;
  sceneNumber?: number;
  takeId?: string;
  /** World-relative source and the exact window taken from it, trim already applied. */
  media?: { path: string; inSec: number; outSec: number };
  clipAudio?: ClipAudioPolicy;
}

export type SpineCutProblemKind =
  | "orphaned"
  | "out-of-bounds"
  | "overlaps"
  | "occluded"
  | "no-take"
  | "short"
  | "unmeasured";

export interface SpineCutProblem {
  shotId: string;
  kind: SpineCutProblemKind;
  detail: string;
}

export interface DerivedSpineCut {
  trackDurationSec: number;
  /** Contiguous and gapless from 0 to `trackDurationSec`: every moment of the song is accounted for. */
  segments: SpineCutSegment[];
  problems: SpineCutProblem[];
  clipSec: number;
  slateSec: number;
  blackSec: number;
  /** Shots with no anchor. In a spine production these are not in the picture at all. */
  unanchoredShotIds: string[];
}

interface Material {
  path: string;
  /** Where the usable material starts in the source file. */
  inSec: number;
  /** How much is usable from `inSec`, or undefined when the file has never been measured. */
  availableSec: number | undefined;
}

/**
 * What a take actually offers, in the source file's own time.
 *
 * A segment's in/out range is the *plan* -- boundaries chosen before dispatch (R-4, D3) -- and a
 * plan is not a measurement. A provider that returned a shorter pass than asked for leaves a
 * range whose end is past the end of the file, and trusting it emits an outSec pointing at
 * nothing: an export that truncates or fails, with no `short` problem raised because the
 * arithmetic all agreed (Codex round 1). So availability is the measured pass, capped to the
 * planned range, and unknown when the pass has never been probed.
 *
 * Unknown is reported rather than assumed everywhere here. Guessing that material covers its
 * window is the assumption that produces a cut running short against the song with nothing in
 * the diagnostics to say why.
 */
function materialFor(take: Take, production: ProductionBundle, takesById: ReadonlyMap<string, Take>): Material | null {
  const productionId = production.meta.id;
  if (take.segment) {
    const pass = takesById.get(take.segment.passTakeId);
    if (!pass?.media) return null;
    const probed = production.takeMediaInfo[pass.id]?.mediaInfo.durationSec;
    const planned = take.segment.outSec - take.segment.inSec;
    return {
      path: `productions/${productionId}/takes/${pass.id}/${pass.media}`,
      inSec: take.segment.inSec,
      availableSec: probed === undefined ? undefined : Math.max(0, Math.min(planned, probed - take.segment.inSec)),
    };
  }
  if (!take.media) return null;
  return {
    path: `productions/${productionId}/takes/${take.id}/${take.media}`,
    inSec: 0,
    availableSec: production.takeMediaInfo[take.id]?.mediaInfo.durationSec,
  };
}

/**
 * Derive the picture timeline from the spine.
 *
 * `trackDurationSec` is measured from the master, never authored. Passing it in rather than
 * reading it off the spine keeps this pure and keeps one measurement — the probe's — as the only
 * answer to how long the song is.
 */
export function deriveSpineCut(
  production: ProductionBundle,
  spine: ProductionSpine,
  trackDurationSec: number,
): DerivedSpineCut {
  const takesById = new Map(production.takes.map((t) => [t.id, t]));
  const shotsById = new Map<string, { sceneNumber: number; number: number; title: string }>();
  for (const scene of production.scenes) {
    for (const shot of scene.shots) {
      shotsById.set(shot.id, { sceneNumber: scene.number, number: shot.number, title: shot.title });
    }
  }

  const segments: SpineCutSegment[] = [];
  // Shot-level diagnostics start from the spine's own, so the Cut screen and the spine editor
  // never disagree about whether a set of anchors is sound.
  const problems: SpineCutProblem[] = anchorProblems(spine, trackDurationSec, new Set(shotsById.keys()));

  /**
   * Black is emitted from three places -- the gap before an anchor, an orphan's held window, and
   * the tail after the last anchor -- and two of them can land back to back. Extending the run
   * rather than appending keeps one stretch of black as one segment, which is what it is, and
   * spares the exporter a second source producing the identical nothing.
   */
  const black = (to: number): void => {
    if (to - cursor <= EPSILON) return;
    const last = segments.at(-1);
    if (last?.kind === "black") last.endSec = to;
    else segments.push({ kind: "black", startSec: cursor, endSec: to, label: "" });
    cursor = to;
  };

  let cursor = 0;
  for (const { shotId, anchor } of orderedAnchors(spine)) {
    const shot = shotsById.get(shotId);
    if (!shot) {
      // Orphaned anchors are already reported by anchorProblems. Skipping to the next anchor left
      // the cursor where it was, so a later shot overlapping the orphan simply moved into the
      // deleted shot's window -- reallocating time nobody agreed to give up, which is the exact
      // thing reporting the orphan was meant to prevent (Codex round 1). The window is held black.
      black(Math.min(anchor.endSec, trackDurationSec));
      continue;
    }

    const label = `SHOT ${shot.number} · ${shot.title}`;
    const start = Math.max(anchor.startSec, cursor);
    const end = Math.min(anchor.endSec, trackDurationSec);
    if (end - start <= EPSILON) {
      // Fully covered by something earlier, or entirely past the end of the song. Either way it
      // renders nothing, and a shot that silently renders nothing is the failure this names.
      problems.push({
        shotId,
        kind: "occluded",
        detail:
          anchor.startSec >= trackDurationSec
            ? `starts at ${anchor.startSec.toFixed(3)}s, past the end of the track`
            : `is covered by earlier anchors and contributes no picture`,
      });
      continue;
    }

    black(start);

    const budget = end - start;
    // Null and absent both mean "nothing accepted": a selection row can exist with the take
    // cleared, and treating that as a take id is a lookup on the string "null".
    const takeId = production.selections[shotId]?.acceptedTakeId ?? null;
    const take = takeId === null ? undefined : takesById.get(takeId);
    const material = take ? materialFor(take, production, takesById) : null;

    if (!take || !material) {
      // R-20: a labelled black slate beats a silent omission. The budget is in the label because
      // the number a user needs is how long the missing shot has to be, not that it is missing.
      problems.push({
        shotId,
        kind: "no-take",
        detail: `has no accepted take for its ${anchorBudgetSec(anchor).toFixed(3)}s window`,
      });
      segments.push({ kind: "slate", startSec: start, endSec: end, label: `${label} · ${budget.toFixed(1)}s`, shotId, sceneNumber: shot.sceneNumber });
      cursor = end;
      continue;
    }

    const trim = production.selections[shotId]?.trimInSec ?? 0;
    // When an earlier anchor already covered the head of this one, `start` moved forward but the
    // source has to move with it. Leaving the in-point alone plays the take's first frame two
    // seconds late -- different content than the anchor asked for, and a shortfall hidden because
    // the discarded head still counted as usable material (Codex round 1).
    const discarded = start - anchor.startSec;
    const inSec = material.inSec + trim + discarded;
    const usable = material.availableSec === undefined ? undefined : material.availableSec - trim - discarded;

    if (usable !== undefined && usable <= EPSILON) {
      problems.push({
        shotId,
        kind: "short",
        detail:
          discarded > EPSILON
            ? `trim of ${trim.toFixed(3)}s and ${discarded.toFixed(3)}s covered by an earlier anchor leave nothing of a ${material.availableSec?.toFixed(3)}s take`
            : `trim of ${trim.toFixed(3)}s leaves nothing of a ${material.availableSec?.toFixed(3)}s take`,
      });
      segments.push({ kind: "slate", startSec: start, endSec: end, label: `${label} · ${budget.toFixed(1)}s`, shotId, sceneNumber: shot.sceneNumber });
      cursor = end;
      continue;
    }

    if (usable === undefined) {
      // Unmeasured: the clip is laid in for its whole window because that is the only guess that
      // produces a watchable cut, and the guess is stated rather than hidden.
      problems.push({ shotId, kind: "unmeasured", detail: `take ${take.id} has not been probed, so its length is assumed to cover the window` });
    }

    const used = usable === undefined ? budget : Math.min(usable, budget);
    const clipEnd = start + used;
    segments.push({
      kind: "clip",
      startSec: start,
      endSec: clipEnd,
      label,
      shotId,
      sceneNumber: shot.sceneNumber,
      takeId: take.id,
      media: { path: material.path, inSec, outSec: inSec + used },
      clipAudio: anchor.clipAudio,
    });

    if (end - clipEnd > EPSILON) {
      // The take is shorter than the window it was anchored to. The shortfall is a slate rather
      // than a held frame: a frozen frame reads as a creative choice, and this is unfinished work.
      problems.push({
        shotId,
        kind: "short",
        detail: `take runs ${used.toFixed(3)}s against a ${budget.toFixed(3)}s window, ${(end - clipEnd).toFixed(3)}s short`,
      });
      segments.push({
        kind: "slate",
        startSec: clipEnd,
        endSec: end,
        label: `${label} · ${(end - clipEnd).toFixed(1)}s SHORT`,
        shotId,
        sceneNumber: shot.sceneNumber,
      });
    }
    cursor = end;
  }

  black(trackDurationSec);

  const anchored = new Set(Object.keys(spine.anchors));
  const total = (kind: SpineCutSegmentKind): number =>
    segments.filter((s) => s.kind === kind).reduce((a, s) => a + (s.endSec - s.startSec), 0);

  return {
    trackDurationSec,
    segments,
    problems,
    clipSec: total("clip"),
    slateSec: total("slate"),
    blackSec: total("black"),
    unanchoredShotIds: [...shotsById.keys()].filter((id) => !anchored.has(id)),
  };
}
