/**
 * What one agent conversation may spend before it is called a runaway (§8.5).
 *
 * Shared by the two services that hold a session open across turns — world creation and sheet
 * authoring. Both kept the same flat figure regardless of what was answering: a number picked
 * once, against models whose windows differ by more than a factor of four.
 *
 * What this guards is an agent looping on its own output until somebody notices. It was never
 * meant to ration honest work, and as a flat figure it did — an author who attaches a document
 * spends most of the budget having it read, and every turn after is interrupted mid-sentence.
 */

/**
 * How many full windows one conversation may spend.
 *
 * A single turn may legitimately fill the model's input window, so a session budget worth less
 * than a few of them stops the work rather than the loop. Ten is not a measured figure; it is
 * comfortably more than a person types through and still finite, which is the only property the
 * guard actually needs.
 */
const SESSION_WINDOWS = 10;

/**
 * The budget for a session, from the window of the model that answers it.
 *
 * `floor` is what the service used before any of this, and applies whenever no window can be
 * named — a fresh install with no session to learn from, or an adapter that cannot say. Behaviour
 * there is exactly what it was rather than a guess that might cut work short on a small model.
 */
export function sessionTokenBudget(inputTokenLimit: number | null | undefined, floor: number): number {
  if (!inputTokenLimit || inputTokenLimit <= 0) return floor;
  return Math.max(floor, inputTokenLimit * SESSION_WINDOWS);
}
