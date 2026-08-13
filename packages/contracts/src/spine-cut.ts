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

/**
 * The only kind that is moving picture.
 *
 * `frame` and `still` are single images produced by image jobs and offered by the same Accept
 * action; they have a file and no duration, so laying one in as a clip spanning its anchor
 * invents an outSec and asks the renderer to freeze or loop something nobody chose to freeze
 * (Codex round 3). Everything else -- voice, sheets, looks, main photos, location views -- is
 * reference or audio.
 */
const MOVING_PICTURE_KINDS: ReadonlySet<Take["kind"]> = new Set(["clip"]);

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
  /**
   * A boundary the material may never be read past, whatever the anchor asks for.
   *
   * Distinct from `availableSec` because a measurement can be missing while a boundary is still
   * authoritative: a pass segment's planned end is where the next shot begins, and reading past
   * it plays somebody else's shot regardless of how long the file turns out to be.
   */
  limitSec: number | undefined;
}

/**
 * Why a take cannot be this shot's picture, named rather than collapsed into "none".
 *
 * Three rounds of review each found a different take reaching the cut as material it was not:
 * an audio file, a static image, and the backing pass of a whole-scene job. Each was fixed as a
 * missing case in a whitelist, which is the wrong shape -- the question is not "is this kind
 * allowed" but "is this a moving picture whose start is this shot's start". So the conditions
 * are enumerated in one predicate that answers with a reason, and the reason reaches the user
 * instead of a shot silently reading as uncovered.
 */
export type MaterialRefusal = "not-picture" | "static" | "backing-pass" | "no-media" | "other-shot";

type MaterialResult = { ok: true; material: Material } | { ok: false; reason: MaterialRefusal };

/**
 * What a take offers as this shot's picture, in the source file's own time.
 *
 * A segment's in/out range is the *plan* -- boundaries chosen before dispatch (R-4, D3) -- and a
 * plan is not a measurement: a provider returning a shorter pass leaves a range ending past the
 * end of the file. It is still a boundary, because the far side of it is the next shot. Those
 * are separate facts and they are carried separately.
 */
function materialFor(
  take: Take,
  shotId: string,
  production: ProductionBundle,
  takesById: ReadonlyMap<string, Take>,
): MaterialResult {
  const productionId = production.meta.id;
  // acceptTake verifies that the take exists, not that it belongs to the shot, so a frame pairing
  // an existing take with another valid shotId persists and the cut would export that shot's
  // footage under this anchor with nothing to say so (Codex round 4). The take says which shots
  // it covers; that is the answer, and it is cheap to ask.
  if (!take.coversShots.includes(shotId)) return { ok: false, reason: "other-shot" };
  if (take.kind === "frame" || take.kind === "still") return { ok: false, reason: "static" };
  if (!MOVING_PICTURE_KINDS.has(take.kind)) return { ok: false, reason: "not-picture" };

  if (take.segment) {
    const pass = takesById.get(take.segment.passTakeId);
    if (!pass?.media) return { ok: false, reason: "no-media" };
    const probed = production.takeMediaInfo[pass.id]?.mediaInfo.durationSec;
    const planned = take.segment.outSec - take.segment.inSec;
    return {
      ok: true,
      material: {
        path: `productions/${productionId}/takes/${pass.id}/${pass.media}`,
        inSec: take.segment.inSec,
        availableSec: probed === undefined ? undefined : Math.max(0, Math.min(planned, probed - take.segment.inSec)),
        limitSec: planned,
      },
    };
  }

  // The primary take of a whole-scene pass carries every shot it covers and no range of its own,
  // and the Generate workspace offers it for each of them. Read from zero it puts the top of the
  // scene into whichever shot accepted it -- wrong picture, exported clean (Codex round 3). Its
  // per-shot segment takes are the material; the pass itself never is.
  if (take.coversShots.length > 1) return { ok: false, reason: "backing-pass" };

  if (!take.media) return { ok: false, reason: "no-media" };
  return {
    ok: true,
    material: {
      path: `productions/${productionId}/takes/${take.id}/${take.media}`,
      inSec: 0,
      availableSec: production.takeMediaInfo[take.id]?.mediaInfo.durationSec,
      limitSec: undefined,
    },
  };
}

const REFUSAL_DETAIL: Record<MaterialRefusal, string> = {
  "not-picture": "accepted take is not moving picture",
  static: "accepted take is a single image, which has no duration to fill the window",
  "backing-pass": "accepted take is a whole-scene pass; its per-shot segment is the material",
  "no-media": "accepted take has no media file",
  "other-shot": "accepted take does not cover this shot",
};

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

  /*
   * Black comes from three places -- the gap before an anchor, an orphan's held window, and the
   * tail after the last anchor -- and two of them can land back to back, so a run is extended
   * rather than appended to.
   *
   * Nothing here rounds (Codex round 4). An earlier attempt absorbed sub-epsilon residue into a
   * neighbouring segment to avoid emitting a half-microsecond of black, and that one convenience
   * produced three separate defects: a clip whose master duration no longer matched its source
   * window, a negative source in-point when the residue sat at the head, and a snap that crossed
   * a pass segment's boundary the type documents as inviolable. Tolerance belongs in comparisons,
   * never in the geometry. The derivation emits exactly what the numbers say and the exporter
   * quantises to the frame grid, where "too small to render" is a question with an answer.
   */
  const black = (to: number): void => {
    if (to <= cursor) return;
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
    const from = cursor;

    const budget = end - from;
    // Null and absent both mean "nothing accepted": a selection row can exist with the take
    // cleared, and treating that as a take id is a lookup on the string "null".
    const takeId = production.selections[shotId]?.acceptedTakeId ?? null;
    const take = takeId === null ? undefined : takesById.get(takeId);
    const found = take ? materialFor(take, shotId, production, takesById) : null;
    const material = found?.ok === true ? found.material : null;

    if (!take || !material) {
      // R-20: a labelled black slate beats a silent omission. The budget is in the label because
      // the number a user needs is how long the missing shot has to be, not that it is missing.
      // When a take was accepted but is not usable, saying which is the difference between a user
      // regenerating a shot and a user re-accepting the same wrong take.
      const why = found?.ok === false ? `: ${REFUSAL_DETAIL[found.reason]}` : "";
      problems.push({
        shotId,
        kind: "no-take",
        detail: `has no usable picture for its ${anchorBudgetSec(anchor).toFixed(3)}s window${why}`,
      });
      segments.push({ kind: "slate", startSec: from, endSec: end, label: `${label} · ${budget.toFixed(1)}s`, shotId, sceneNumber: shot.sceneNumber });
      cursor = end;
      continue;
    }

    const trim = production.selections[shotId]?.trimInSec ?? 0;
    // When an earlier anchor already covered the head of this one, `start` moved forward but the
    // source has to move with it. Leaving the in-point alone plays the take's first frame two
    // seconds late -- different content than the anchor asked for, and a shortfall hidden because
    // the discarded head still counted as usable material (Codex round 1).
    const discarded = Math.max(0, from - anchor.startSec);
    const inSec = material.inSec + trim + discarded;
    const usable = material.availableSec === undefined ? undefined : material.availableSec - trim - discarded;
    const limited = material.limitSec === undefined ? undefined : material.limitSec - trim - discarded;

    /*
     * Everything that can shorten the clip, resolved once (Codex round 2).
     *
     * The boundary binds whether or not a measurement exists: making an unprobed segment's
     * availability unknown was right, and letting unknown then mean "take the whole window" read
     * an unprobed [12,18) segment as [14,20) and played two seconds of the next shot. Checking
     * only `usable` for exhaustion had the same blind spot from the other side -- a cap that
     * leaves nothing produces a zero-length clip rather than a slate.
     */
    const capped = [budget, usable, limited]
      .filter((v): v is number => v !== undefined)
      .reduce((a, b) => Math.min(a, b));

    if (capped <= EPSILON) {
      const consumed = discarded > EPSILON ? `trim of ${trim.toFixed(3)}s and ${discarded.toFixed(3)}s covered by an earlier anchor` : `trim of ${trim.toFixed(3)}s`;
      problems.push({
        shotId,
        kind: "short",
        detail:
          usable !== undefined && usable <= EPSILON
            ? `${consumed} leave nothing of a ${material.availableSec?.toFixed(3)}s take`
            : `${consumed} leave nothing inside the take's ${material.limitSec?.toFixed(3)}s segment`,
      });
      segments.push({ kind: "slate", startSec: from, endSec: end, label: `${label} · ${budget.toFixed(1)}s`, shotId, sceneNumber: shot.sceneNumber });
      cursor = end;
      continue;
    }

    if (usable === undefined) {
      // Unmeasured: the clip is laid in for its whole window because that is the only guess that
      // produces a watchable cut, and the guess is stated rather than hidden.
      problems.push({ shotId, kind: "unmeasured", detail: `take ${take.id} has not been probed, so its length is assumed to cover the window` });
    }

    // No snap to the budget: `capped` already respects every boundary that binds, and rounding it
    // up was what crossed a segment limit into the next shot (Codex round 4). A residue too small
    // to be a frame is emitted honestly and quantised downstream.
    const used = capped;
    const clipEnd = from + used;
    segments.push({
      kind: "clip",
      startSec: from,
      endSec: clipEnd,
      label,
      shotId,
      sceneNumber: shot.sceneNumber,
      takeId: take.id,
      media: { path: material.path, inSec, outSec: inSec + used },
      clipAudio: anchor.clipAudio,
    });

    if (end > clipEnd) {
      // The take is shorter than the window it was anchored to. The shortfall is a slate rather
      // than a held frame: a frozen frame reads as a creative choice, and this is unfinished work.
      // The segment is emitted at its true size whatever that is; only the *diagnostic* has a
      // threshold, since telling a user a shot is 0.0000005s short is not telling them anything.
      if (end - clipEnd > EPSILON) {
        problems.push({
          shotId,
          kind: "short",
          detail: `take runs ${used.toFixed(3)}s against a ${budget.toFixed(3)}s window, ${(end - clipEnd).toFixed(3)}s short`,
        });
      }
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
