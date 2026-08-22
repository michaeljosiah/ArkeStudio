import { effectiveFraming, type Scene, type Shot } from "./scene.js";
import type { ProductionBundle } from "./client-state.js";

/**
 * What a review of one scene can say before anybody has read it (design turn 102).
 *
 * Turn 98 asked for a Director — an agent that reads the scene and says what is wrong in the
 * words of the specific thing wrong. That agent does not exist. What does exist is everything
 * the scene already knows about itself, and it is worth saying: a shot with nothing written, a
 * script that moved after it was read, two neighbours framed identically.
 *
 * Derived at read and never stored, for the same reason the season's findings are (SPEC-023
 * R-16): stored intelligence goes stale silently. There is no score — a number would hide the
 * sentence a creator can act on — and no finding blocks, because none of these is a reason a
 * scene cannot be generated. They are suggestions, and the strip that shows them says so.
 */

export type SceneFindingKind = "empty-shot" | "stale-coverage" | "repeated-framing" | "no-shots";

export interface SceneFinding {
  kind: SceneFindingKind;
  /** The shot it is about, where it is about one. */
  about?: string;
  /** The finding as a sentence a creator can act on. */
  message: string;
  /** What it stands on — the shot ids or values that make it true. */
  evidence: string[];
}

/** A shot with nothing in it to generate from: no script, and no prompt written over it. */
function isEmpty(shot: Shot): boolean {
  return shot.description.trim() === "" && (shot.promptOverride?.text ?? "").trim() === "";
}

/** How a shot is named in a sentence: its number where it has one, its id otherwise. */
function name(shot: Shot): string {
  return shot.number !== undefined ? `Shot ${shot.number}` : shot.id;
}

export function sceneFindings(
  scene: Scene,
  /**
   * Shots whose script has moved since it was last read into coverage, computed by the caller —
   * the digests are hashed in the browser, which contracts cannot do (SPEC-023's coverage rule).
   */
  staleShotIds: readonly string[] = [],
): SceneFinding[] {
  const shots = scene.shots ?? [];
  if (shots.length === 0) {
    return [
      {
        kind: "no-shots",
        message: "This scene has no shots yet.",
        evidence: [scene.id],
      },
    ];
  }
  const found: SceneFinding[] = [];
  for (const shot of shots) {
    if (isEmpty(shot)) {
      found.push({
        kind: "empty-shot",
        about: shot.id,
        message: `${name(shot)} has nothing written.`,
        evidence: [shot.id],
      });
    }
  }
  const stale = new Set(staleShotIds);
  for (const shot of shots) {
    if (stale.has(shot.id)) {
      found.push({
        kind: "stale-coverage",
        about: shot.id,
        message: `${name(shot)}'s script changed after it was read.`,
        evidence: [shot.id],
      });
    }
  }
  /*
   * Neighbours framed the same way. Only neighbours: a scene may legitimately return to a wide
   * three times, and saying so every time would train a person to ignore the strip. Two in a row
   * is the case where one of them is usually meant to be something else.
   */
  for (let i = 1; i < shots.length; i += 1) {
    const before = shots[i - 1]!;
    const here = shots[i]!;
    const a = effectiveFraming(scene, before).size;
    const b = effectiveFraming(scene, here).size;
    if (a !== undefined && a === b) {
      found.push({
        kind: "repeated-framing",
        about: here.id,
        message: `${name(before)} and ${name(here)} are both ${a}.`,
        evidence: [before.id, here.id, a],
      });
    }
  }
  return found;
}

/**
 * What deleting this scene would break, in words (round 3's gap: a scene made by accident had no
 * way out, and lived in the production forever).
 *
 * Two things stop a deletion, and both are things the person can undo themselves first.
 *
 * Accepted footage, because a take is money already spent and a scene is the only thing that
 * still says which shot it was for; deleting the scene would leave paid clips in the folder
 * belonging to nothing. Reject the take or accept it elsewhere, then the scene is free.
 *
 * A routing reference, because an interactive graph names scenes by id — as its start, on either
 * end of a choice, as an ending, as an exclusion — and a deleted scene turns the branch map into
 * a promise the player cannot keep. Redraw the edge first.
 *
 * Everything else that mentions the scene is repaired in the same commit rather than refused:
 * episode membership and the selections its shots carried. Those are bookkeeping the deletion
 * owns, not decisions the person has to make twice.
 */
export function sceneDeleteBlockers(production: ProductionBundle, scene: Scene): string[] {
  const reasons: string[] = [];
  const accepted = scene.shots.filter((shot) => production.selections[shot.id]?.acceptedTakeId != null);
  if (accepted.length > 0) {
    reasons.push(
      `${accepted.map((s) => `shot ${s.number}`).join(", ")} ${accepted.length === 1 ? "has" : "have"} an accepted take — reject it first, or the footage is left belonging to nothing`,
    );
  }
  const routing = production.routing;
  if (routing) {
    const named: string[] = [];
    if (routing.start === scene.id) named.push("it is where the story starts");
    for (const choice of routing.choices) {
      if (choice.from === scene.id) named.push(`the choice "${choice.label}" leads out of it`);
      if (choice.to === scene.id) named.push(`the choice "${choice.label}" leads to it`);
    }
    if (routing.endings.some((e) => e.sceneId === scene.id)) named.push("it is marked as an ending");
    if (routing.excluded.some((e) => e.sceneId === scene.id)) named.push("it is on the excluded list");
    if (named.length > 0) {
      reasons.push(`the branch map still names it: ${named.slice(0, 4).join("; ")} — redraw that first`);
    }
  }
  return reasons;
}
