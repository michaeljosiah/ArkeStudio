import { effectiveFraming, type Scene, type Shot } from "./scene.js";

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
