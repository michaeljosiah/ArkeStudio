import { effectiveFraming, type Scene, type Selections, type Shot } from "./scene.js";
import type { Take } from "./take.js";

/**
 * Board packing (SPEC-035).
 *
 * Generating each frame of a scene independently causes drift: the face, the light and the
 * grade all move between shots. Generating several consecutive shots as one pass — one grid
 * image for stills, one clip for video — forces one rendering of all three across them. But a
 * video route caps a clip at 10–30 seconds, so a scene maps to a *sequence* of such groups.
 * That group is a **board**, and this is the one function that produces boards.
 *
 * Boards are derived, never authored (SPEC-035 §1.2). Membership depends on the model's cap,
 * and the cap is not authored: an authored group either ignores it and lies, or is rewritten by
 * it and stops being authored. Continuity breaks are facts of the shots, and facts should not
 * be maintained by hand in a second place. What *is* authored is two thin overrides — a split
 * before a shot, and a merge across a boundary the walk would otherwise break at — and one
 * honesty rule: a break that does not appear is carried as a warning, so a seam the author
 * chose stays visible and a seam that appears by accident is impossible.
 *
 * Pure, and every consumer calls it: the workspace surface, frame-sheet requests, and
 * whole-scene video planning. Two packers would be two answers to where the seams are.
 */

/** A note under a board: a risk the author accepted, or a fact nobody needs to accept (R-6, R-11). */
export interface BoardNote {
  kind: "warning" | "accent";
  text: string;
}

export type BoardReason =
  | "clip limit"
  | "panel limit"
  | "by hand"
  | "time of day changes"
  | "cast changes";

export interface PackedBoard {
  /** `A`…`Z`, then `AA` — positional, renumbered on every pack, stored nowhere (R-8). */
  letter: string;
  memberShotIds: string[];
  durationSec: number;
  /** Members with no frame — what the generate dialog's scope preview counts. */
  missingFrames: number;
  /** Why this board begins. The first board begins because the scene does, and says nothing. */
  reason: BoardReason | null;
  notes: BoardNote[];
}

export type BoardPack =
  | { ok: true; boards: PackedBoard[] }
  /**
   * A shot longer than the cap refuses the whole pack (R-5) — the contract `packScene` already
   * keeps. Packing it anyway would build a board over the cap, which is a request the provider
   * rejects *after* the money has moved.
   */
  | { ok: false; oversizeShot: { shotId: string; number: number; durationSec: number; capSec: number } };

/** What the packer reads about one shot. Assembled by `packShotsFor`; see its rules. */
export interface PackShot {
  id: string;
  number: number;
  durationSec: number;
  /** Effective time of day; `null` is unset, and unset never breaks and never overrides. */
  timeOfDay: string | null;
  /** Effective lighting, on the same terms. */
  lighting: string | null;
  /** Resolved sheet ids, first appearance first. Empty means unknown, not "nobody". */
  cast: string[];
  /** A clip of this shot alone — not a segment cut from a pass, which is the opposite. */
  solo: boolean;
}

/**
 * Spreadsheet letters (R-8).
 *
 * `String.fromCharCode(65 + i)` runs off the end of the alphabet into `[`, `\`, `]` — and a
 * scene reaches 27 boards honestly, on a 10-second cap or a stack of hand splits. Shot counts
 * are unbounded, so the labels must be too.
 */
export function boardLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * The memo key (R-14).
 *
 * The packer runs on nearly every render of the workspace, so the surface memoises on this.
 * It covers everything that can change the output and nothing else: editing a shot's title or
 * synopsis must not bust it, or the memo buys nothing on the edit path that needs it most.
 */
export function boardPackKey(
  shots: readonly PackShot[],
  capSec: number,
  splits: ReadonlySet<string>,
  merges: ReadonlySet<string>,
  /** A caller-supplied digest of `hasFrame` across the same shots, e.g. `"1101"`. */
  frames: string,
  maxMembers?: number,
): string {
  /*
   * JSON, not delimiters. `timeOfDay` and `lighting` are free text from art direction, so a
   * separator-joined key is not injective: `timeOfDay: "night:blue hour"` with
   * `lighting: "lantern"` would encode identically to `"night"` with `"blue hour:lantern"`,
   * and those two scenes pack differently. A memo keyed by an ambiguous string hands back
   * another scene's boards.
   */
  return JSON.stringify([
    capSec,
    maxMembers ?? null,
    // `number` is in here because it reaches the OUTPUT: oversize refusals, continuity
    // warnings, lighting accents and solo warnings all name it. Renumbering a shot without
    // touching anything else would otherwise return a cached pack naming the old number.
    shots.map((s) => [s.id, s.number, s.durationSec, s.timeOfDay, s.lighting, s.solo, s.cast]),
    [...splits].sort(),
    [...merges].sort(),
    frames,
  ]);
}

export function packBoards(
  shots: readonly PackShot[],
  capSec: number,
  splits: ReadonlySet<string>,
  merges: ReadonlySet<string>,
  hasFrame: (shotId: string) => boolean,
  /** Frame-sheet packing passes the sheet's panel cap, so a board always fits one sheet (R-12). */
  maxMembers?: number,
): BoardPack {
  // R-5: refuse before walking. Nothing downstream can rescue a shot no cap can hold.
  for (const shot of shots) {
    if (shot.durationSec > capSec) {
      return {
        ok: false,
        oversizeShot: {
          shotId: shot.id,
          number: shot.number,
          durationSec: shot.durationSec,
          capSec,
        },
      };
    }
  }

  /*
   * R-4's disjoint rule, applied at read. The commands keep the two sets disjoint on write, but
   * a hand-edited file can carry an id in both — and a dormant merge that wakes up when a split
   * is later cleared is a seam nobody chose. Split wins; the merge is dropped here.
   */
  const liveMerges = new Set([...merges].filter((id) => !splits.has(id)));

  /*
   * R-2: the scene's own values are the MODAL value across the shots that set one, never a
   * stored default. A scene whose defaults say dusk while four of five shots say night is a
   * night scene with one dusk shot; comparing against the default would break it into five
   * boards. Unset values are not counted — absence inherits, so it votes for nothing.
   */
  const modal = (pick: (shot: PackShot) => string | null): string | null => {
    const tally = new Map<string, number>();
    for (const shot of shots) {
      const value = pick(shot);
      if (value !== null) tally.set(value, (tally.get(value) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [value, count] of tally) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  };
  const sceneTime = modal((shot) => shot.timeOfDay);
  const sceneLight = modal((shot) => shot.lighting);

  /*
   * A difference worth a seam. Equal values never break, and an unset value never breaks —
   * absence inherits, so it compares equal to everything. Two shots that both differ from the
   * scene's own value still break from each other: dusk beside night is a change whichever of
   * them the scene mostly is.
   */
  const differs = (a: string | null, b: string | null, scene: string | null): boolean => {
    if (a === null || b === null || a === b) return false;
    return a !== scene || b !== scene;
  };

  /*
   * R-3, D5: an empty cast overlaps with everything. A shot that names nobody is an unknown,
   * not a cast change, and breaking on it would punish terse writing.
   */
  const castBreaks = (previous: PackShot, next: PackShot): boolean => {
    if (previous.cast.length === 0 || next.cast.length === 0) return false;
    return !previous.cast.some((id) => next.cast.includes(id));
  };

  const breakNote = (reason: BoardReason, at: PackShot): BoardNote =>
    reason === "time of day changes"
      ? {
          kind: "warning",
          text: `spans a time-of-day change · shot ${at.number} ${at.timeOfDay} in a ${sceneTime} board`,
        }
      : {
          kind: "warning",
          text: `spans a cast change · shot ${at.number} brings ${at.cast.join(", ")}`,
        };

  /** `byHand` is not on the board itself: it is a fact about the walk that the collapse reads. */
  type Working = PackedBoard & { byHand: boolean };
  const out: Working[] = [];
  let current: Working | null = null;
  let previous: PackShot | null = null;

  // The walk (R-5). The order of these tests is the specification: cap, then panel limit, then
  // a hand split, then a merge (which carries what it suppressed), then the automatic breaks.
  for (const shot of shots) {
    let reason: BoardReason | null = null;
    if (current !== null && previous !== null) {
      const auto: BoardReason | null = differs(previous.timeOfDay, shot.timeOfDay, sceneTime)
        ? "time of day changes"
        : castBreaks(previous, shot)
          ? "cast changes"
          : null;
      if (current.durationSec + shot.durationSec > capSec) reason = "clip limit";
      else if (maxMembers !== undefined && current.memberShotIds.length >= maxMembers) {
        reason = "panel limit";
      } else if (splits.has(shot.id)) reason = "by hand";
      else if (liveMerges.has(shot.id)) {
        if (auto !== null) current.notes.push(breakNote(auto, shot));
      } else reason = auto;
    }
    if (current === null || reason !== null) {
      current = {
        letter: "",
        memberShotIds: [],
        durationSec: 0,
        missingFrames: 0,
        reason,
        notes: [],
        byHand: reason === "by hand",
      };
      out.push(current);
    }
    current.memberShotIds.push(shot.id);
    current.durationSec += shot.durationSec;
    if (!hasFrame(shot.id)) current.missingFrames += 1;
    // R-6: lighting is an accent, never a break. A practical lantern inside a blue-hour scene
    // is an accent; breaking on it once produced four single-shot boards out of five shots,
    // which is the feature defeating itself.
    if (shot.lighting !== null && sceneLight !== null && shot.lighting !== sceneLight) {
      current.notes.push({
        kind: "accent",
        text: `lighting accent · shot ${shot.number} · ${shot.lighting}, inside a ${sceneLight} scene`,
      });
    }
    previous = shot;
  }

  /*
   * R-7: fold a board of one into a neighbour with room, previous first. A board of one
   * delivers no cross-shot consistency at all — it is per-shot generation wearing a board
   * label — so it is worth suppressing a seam to avoid.
   *
   * Never across a hand seam in either direction: a board the author split by hand is not
   * folded, and a singleton is not folded FORWARD into a board whose own start is by hand,
   * because that boundary is the one that would vanish.
   */
  const byId = new Map(shots.map((shot) => [shot.id, shot]));
  for (let i = 0; i < out.length; i++) {
    const board = out[i]!;
    if (board.memberShotIds.length > 1 || out.length === 1 || board.byHand) continue;
    const fits = (candidate: Working | undefined): boolean =>
      candidate !== undefined &&
      candidate.durationSec + board.durationSec <= capSec &&
      (maxMembers === undefined || candidate.memberShotIds.length + 1 <= maxMembers);
    const before = out[i - 1];
    const after = out[i + 1];
    const into = fits(before) ? before! : fits(after) && after!.byHand !== true ? after! : null;
    if (into === null) continue;
    /*
     * Which boundary actually disappears depends on the direction. Folding BACK removes the
     * seam this singleton began with; folding FORWARD removes the seam the *next* board began
     * with — that boundary sat between the two — while the singleton's own start reason
     * survives as the combined board's start.
     */
    const suppressed =
      into === after
        ? { reason: after!.reason, at: byId.get(after!.memberShotIds[0]!) }
        : { reason: board.reason, at: byId.get(board.memberShotIds[0]!) };
    if (
      suppressed.reason !== null &&
      suppressed.reason !== "clip limit" &&
      suppressed.reason !== "panel limit" &&
      suppressed.reason !== "by hand" &&
      suppressed.at !== undefined
    ) {
      into.notes.push(breakNote(suppressed.reason, suppressed.at));
    }
    into.notes.push(...board.notes);
    if (into === before) {
      into.memberShotIds.push(...board.memberShotIds);
    } else {
      into.memberShotIds.unshift(...board.memberShotIds);
      into.reason = board.reason;
      into.byHand = board.byHand;
    }
    into.durationSec += board.durationSec;
    into.missingFrames += board.missingFrames;
    out.splice(i, 1);
    i -= 1;
  }

  // R-9: a shot rendered on its own, sitting inside a board, may not match what the board makes.
  for (const board of out) {
    if (board.memberShotIds.length < 2) continue;
    for (const id of board.memberShotIds) {
      const shot = byId.get(id);
      if (shot?.solo === true) {
        board.notes.push({
          kind: "warning",
          text: `shot ${shot.number} rendered separately · may not match this board`,
        });
      }
    }
  }

  return {
    ok: true,
    boards: out.map(({ byHand: _byHand, ...board }, i) => ({ ...board, letter: boardLetter(i) })),
  };
}

/**
 * The packer's input, assembled from what the world already holds (SPEC-035 §2.3).
 *
 * Split from `packBoards` so the packer stays pure and memoisable: these lookups are the
 * caller's context, and threading a world bundle through the algorithm would make the memo key
 * unwriteable.
 *
 * `shots` arrive in canonical order — the caller reads them through the scene-sequence boundary
 * (SPEC-029 R-17), never a private walk of `shots[]`.
 */
function renderedWithNeighbours(take: Take, takeById: ReadonlyMap<string, Take>): boolean {
  if (take.segment === undefined) return false;
  const parent = takeById.get(take.segment.passTakeId);
  return parent !== undefined && parent.coversShots.length > 1;
}

export function packShotsFor(input: {
  scene: Pick<Scene, "defaults" | "inherits">;
  shots: readonly Shot[];
  selections: Selections;
  takes: readonly Take[];
  /** Resolves a shot's description to sheet ids — `resolveCast`, applied by the caller's world. */
  castOf: (shot: Shot) => string[];
  defaultDurationSec: number;
}): PackShot[] {
  const takeById = new Map(input.takes.map((take) => [take.id, take]));
  return input.shots.map((shot) => {
    const framing = effectiveFraming(input.scene, shot);
    const accepted = input.selections[shot.id]?.acceptedTakeId ?? null;
    const take = accepted === null ? undefined : takeById.get(accepted);
    return {
      id: shot.id,
      number: shot.number,
      durationSec: shot.durationSec ?? input.defaultDurationSec,
      /*
       * The framing chain, then the scene's own inheritance. `effectiveFraming` covers
       * shot-over-defaults; `inherits.timeOfDay` is the scene-level answer beneath both, and
       * lighting has no `inherits` equivalent to fall through to.
       */
      timeOfDay: framing.timeOfDay ?? input.scene.inherits?.timeOfDay ?? null,
      lighting: framing.lighting ?? null,
      cast: input.castOf(shot),
      /*
       * Rendered on its own, and genuinely on its own.
       *
       * Kind `clip`, not merely a take in the clip slot: an upgraded world can still hold a
       * still misfiled there (SPEC-036 §2.5 reads those as *framed*), and without the kind
       * check every board holding that shot would warn about a video render that never
       * happened.
       *
       * And a pass segment is judged by its PARENT, not by its own coverage. Arrival derives
       * one `clip` per shot from a pass, each covering exactly its own shot and naming the
       * pass in `segment` — so by coverage alone a segment is indistinguishable from a solo
       * render. What separates them is what the parent covered: several shots means this
       * footage was made WITH its neighbours, which is the opposite of solo and must not
       * warn. But a pass can cover ONE shot — the cap isolated it — and that segment is a
       * solo render in every sense that matters here, so if a later repack groups that shot
       * with neighbours the board must still say so.
       *
       * An unresolvable parent counts as solo: this spec's honesty rule prefers a seam that
       * is visible to one that is silent, and the warning is advisory rather than blocking.
       */
      solo:
        take?.kind === "clip" &&
        !renderedWithNeighbours(take, takeById) &&
        take.coversShots.length === 1 &&
        take.coversShots[0] === shot.id,
    };
  });
}
