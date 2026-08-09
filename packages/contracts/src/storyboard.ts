import { assembleBlocks } from "./planning.js";
import type { ManifestModel } from "./manifest.js";
import type { Scene, Selections, Shot } from "./scene.js";
import type { Sheet, WorldMeta } from "./world.js";

/**
 * Storyboards drawn to be read (SPEC-019 §2.12, R-22..R-25, R-27).
 *
 * Not the compiled review board. That one is a dense four-column grid of generated frames with
 * labels and no panel cap — the discouraged input, in the discouraged quantity, in the
 * discouraged style (R-48, D31). This one is drawn on purpose: line art, no text inside the
 * image, and no more panels than the family that will read it handles.
 *
 * It exists because keyframes presuppose accepted frames for every shot, so they are unavailable
 * at exactly the moment previz is wanted. A line-art board is what you have before anything has
 * been shot.
 */

export interface StoryboardPanel {
  shotId: string;
  number: number;
  /** What the panel shows, derived from the shot's own assembled description (R-24). */
  text: string;
}

export interface StoryboardPlan {
  /** Panels to draw, in shot order. */
  panels: StoryboardPanel[];
  /**
   * Shots past the cap, named before commit rather than drawn into an over-long board (R-23).
   * Past the cap the documented failure is a still output or panels rendered out of order, so
   * the excess is dropped visibly instead of degrading the whole board silently.
   */
  dropped: Array<{ shotId: string; number: number }>;
  /** The cap that applied, or null when the target model states none. */
  cap: number | null;
  /** Human notice; null when every shot fits. */
  notice: string | null;
  /** The prompt the drawing model is given. */
  prompt: string;
}

/**
 * The instruction the board is drawn to. Every constraint here is enforced rather than advised,
 * and the no-text rule is not cosmetic: text drawn on a panel is text the model may render into
 * the frame later, which the subtitle negative already spends a clause preventing at the other
 * end (R-23, D8, D27).
 */
function storyboardPrompt(panels: StoryboardPanel[], style: string | undefined): string {
  const header = [
    `A ${panels.length}-panel storyboard, drawn as rough black-and-white line art on white.`,
    "Stick figures and simple contour drawing only: flat, clean, uncluttered, no shading, no",
    "texture, no colour, no rendering, no finish.",
    "Panels are laid out in a plain grid and read in order, left to right, top to bottom.",
    "Each panel shows staging only — who is in frame, where they stand, the shot size, and where",
    "the camera is.",
    "No text anywhere in the image: no captions, no labels, no shot numbers, no titles, no",
    "lettering of any kind.",
  ].join(" ");
  const body = panels.map((panel) => `Panel ${panel.number}: ${panel.text}`).join("\n");
  // The world's look is named only as subject matter, never as a rendering instruction: a board
  // rendered in the world's style stops being line art, which is the one thing it must be.
  const tail = style
    ? `The subjects and setting come from: ${style}. Draw them as line art regardless — the style informs what is depicted, never how it is drawn.`
    : null;
  return [header, body, tail].filter((part): part is string => part !== null).join("\n\n");
}

/**
 * Plan a storyboard for the shots a dispatch would cover.
 *
 * `target` is the model that will *read* the board, not the one that draws it: the panel cap is
 * a property of the consumer (R-23). Panels come from `assembleBlocks(...).body`, the same text
 * prompt assembly emits, so the board and the prompt cannot contradict each other (R-24, D28) —
 * two artefacts authored separately diverge the first time a shot is edited and only one of them
 * is redrawn.
 */
export function planStoryboard(input: {
  world: WorldMeta;
  sheets: Sheet[];
  scene: Scene;
  shots?: Shot[];
  target: ManifestModel;
  artDirection?: string;
}): StoryboardPlan {
  const shots = input.shots ?? input.scene.shots;
  const cap = input.target.limits.storyboardPanels ?? null;
  const kept = cap === null ? shots : shots.slice(0, cap);
  const excess = cap === null ? [] : shots.slice(cap);
  const panels: StoryboardPanel[] = kept.map((shot) => ({
    shotId: shot.id,
    number: shot.number,
    text: assembleBlocks({
      world: input.world,
      sheets: input.sheets,
      scene: input.scene,
      shot,
      ...(input.artDirection !== undefined ? { artDirection: input.artDirection } : {}),
    }).body,
  }));
  const dropped = excess.map((shot) => ({ shotId: shot.id, number: shot.number }));
  return {
    panels,
    dropped,
    cap,
    notice:
      dropped.length > 0
        ? `${input.target.displayName} reads ${cap} storyboard panel${cap === 1 ? "" : "s"}: drawing shots ${kept
            .map((shot) => shot.number)
            .join(", ")} — leaving out ${dropped.map((shot) => shot.number).join(", ")}`
        : null,
    prompt: storyboardPrompt(panels, input.artDirection),
  };
}

/**
 * May this scene's storyboard steer a generation (R-25, R-27)?
 *
 * Two conditions and both are gates rather than warnings. It must have been accepted, because
 * the accept gate is what decides which images drive generation — a board nobody looked at,
 * silently steering a scene, is that gate inverted. And it must have been drawn from the scene as
 * it stands: an edited shot description beside an unredrawn panel is exactly the contradiction
 * R-24 exists to make unrepresentable, reintroduced by time rather than by authorship.
 */
export function storyboardUsable(scene: Scene): { usable: boolean; reason: string | null } {
  const board = scene.storyboard;
  if (board === undefined) return { usable: false, reason: "no storyboard has been drawn for this scene" };
  if (!board.accepted) return { usable: false, reason: "the storyboard has not been accepted yet" };
  if (board.sceneVersion !== scene.version) {
    return {
      usable: false,
      reason: `the storyboard was drawn from v${board.sceneVersion} and the scene is at v${scene.version} — redraw it`,
    };
  }
  return { usable: true, reason: null };
}


// ---------------------------------------------------------------------------
// Which pictures steer this dispatch (SPEC-019 R-26, D30)
// ---------------------------------------------------------------------------

export type ReferenceSteering =
  | {
      mode: "keyframes";
      frames: Array<{ shotId: string; number: number; takeId: string }>;
      statement: string;
    }
  | { mode: "storyboard"; file: string; statement: string }
  | { mode: "none"; statement: string };

/** The frame a shot would contribute, pinned first, then whatever take it currently uses. */
function frameFor(shotId: string, selections: Selections): string | null {
  const selection = selections[shotId];
  return selection?.startFrameTakeId ?? selection?.acceptedTakeId ?? null;
}

/**
 * Keyframes or a storyboard, decided rather than picked (R-26, D30).
 *
 * The two are not alternatives on aesthetics: storyboard input is documented as *loose* — a
 * high-level plot reference the output need not match — while keyframe input is *aligned*.
 * Nobody should have to know which is stricter, so the preference is automatic.
 *
 * But "every shot has a frame" is not sufficient on its own, and this is the gap that is easy to
 * miss. A scene can have a frame per shot and still hold more shots than the model's reference
 * cap, at which point the budget truncates the sequence and the dispatch carries some shots'
 * keyframes and not others. **A partial sequence is worse than none**: the model aligns to the
 * frames it received and invents the shots it did not, with nothing saying which is which. So
 * the whole sequence has to survive intact or keyframes are not chosen at all.
 *
 * Whatever is decided, the statement says why — including the fallback, because a choice made
 * silently is one nobody can correct.
 */
export function chooseReferenceSteering(input: {
  scene: Scene;
  shots?: Shot[];
  selections: Selections;
  model: ManifestModel;
}): ReferenceSteering {
  const shots = input.shots ?? input.scene.shots;
  const board = storyboardUsable(input.scene);
  const boardFile = input.scene.storyboard?.file ?? null;
  const fallback = (why: string): ReferenceSteering =>
    board.usable && boardFile !== null
      ? { mode: "storyboard", file: boardFile, statement: `storyboard — ${why}` }
      : { mode: "none", statement: `no reference images — ${why}, and ${board.reason}` };

  if (shots.length === 0) return fallback("this dispatch covers no shots");

  const missing = shots.filter((shot) => frameFor(shot.id, input.selections) === null);
  if (missing.length > 0) {
    return fallback(
      `shot${missing.length === 1 ? "" : "s"} ${missing.map((shot) => shot.number).join(", ")} ${
        missing.length === 1 ? "has" : "have"
      } no frame, so a keyframe sequence would be incomplete`,
    );
  }

  const cap = input.model.accepts.referenceImages;
  if (shots.length > cap) {
    return fallback(
      `${shots.length} shots exceed ${input.model.displayName}'s ${cap} reference image${
        cap === 1 ? "" : "s"
      }, so a keyframe sequence would be truncated`,
    );
  }

  return {
    mode: "keyframes",
    frames: shots.map((shot) => ({
      shotId: shot.id,
      number: shot.number,
      takeId: frameFor(shot.id, input.selections)!,
    })),
    statement: `keyframes — every shot has a frame and all ${shots.length} fit ${input.model.displayName}'s reference budget`,
  };
}
