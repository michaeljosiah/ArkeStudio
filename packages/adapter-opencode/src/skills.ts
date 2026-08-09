/**
 * Authoring skills (SPEC-019 §2.7, R-14..R-20).
 *
 * A skill is model-family authoring guidance: how actions, expressions, camera moves and
 * storyboards are best written for one family of video models. It is loaded into an authoring
 * session so that what an agent *drafts* has the shape the target model answers.
 *
 * Three places could hold this and two are wrong (D12). Not the manifest: that carries numbers a
 * picker or an estimate reads, and pages of craft advice in a row makes "one row to update"
 * false. Not an agent brief: briefs are one per agent rather than one per family, and Settings
 * can replace them — the harness's own note on that override says an agent talked out of its
 * constraints fails in ways that look like our bugs, and this is knowledge the output quality
 * depends on.
 *
 * **Shipped, never fetched** (R-15). Architecture settles this rather than principle: authoring
 * sessions have no network tools (SPEC-005 R-10), so a skill that had to be fetched could not be
 * fetched by the agent that needs it. These documents live in the repository and travel with the
 * application, which is also what keeps first run working on a machine that has never been
 * online.
 *
 * **Shapes authoring, never dispatch** (R-17). What a skill influences is a draft, and a draft
 * arrives as a proposal and waits for an accept. It does not reach prompt assembly: the assembled
 * prompt stays derivable from the world, so Reset still restores it and override staleness stays
 * computable. There is deliberately no path from here to SPEC-012's assembly.
 */

export interface Skill {
  /** Stable identity, recorded on the proposals this skill shaped (R-19). */
  id: string;
  /**
   * Bumped whenever the body changes. Two scenes drafted under different guidance differ for a
   * reason that is otherwise unrecoverable, which is why the version travels with the id.
   */
  version: number;
  /** The model family this is written for (R-16). */
  family: string;
  /** Which authoring job it applies to. */
  purpose: SkillPurpose;
  /** The document itself. */
  body: string;
}

export type SkillPurpose = "scene-drafting" | "storyboard";

// ---------------------------------------------------------------------------
// Seedance — scene drafting (T-10)
// ---------------------------------------------------------------------------

const SEEDANCE_SCENE_DRAFTING = `## Writing shots for this model family

The shots you draft become a structured brief: a summary, what holds throughout, and a timed
body. Write each shot so it survives that assembly.

**Action.** Prefer a general description of what happens to beat-by-beat choreography. "They
trade a few probing strikes before the first real exchange" carries further than a list of
individual blows. Write specific detail only for the one or two actions a viewer would remember,
and do not repeat the same action across consecutive shots.

**Expression.** Describe what the face and body do, in plain words. Idiom does not survive: "she
is beside herself" is rendered literally or ignored, where "her jaw tightens and she looks away"
is neither. The same goes for "sees red", "lights up", "falls apart".

**Camera.** Standard vocabulary can be written directly and needs no explanation — shot size
(extreme wide, wide, medium, medium close-up, close-up), movement (push in, pull out, pan,
track, follow, orbit, tilt up, handheld), angle (low, overhead, first person), and named
techniques (one-shot, dolly zoom, aerial, FPV, bullet time, speed ramp). An unusual term needs a
clause explaining it: "rack focus: the foreground trees blur as the figure behind them sharpens".

**Transitions.** Give both the trigger and the method: "at the cut, a fast whip pan left into the
next setup". A transition with only one of the two is guesswork.

**Duration.** Whole seconds. A shot's length is the time its action needs — too little and the
model improvises past what you wrote, too much and it either pads or drops part of the beat. Do
not use duration to control fast repeated motion.

**Cast and place.** Every character and location gets an @mention, every time it appears. The
mention is the only cast list there is. Do not describe a character's appearance in the shot
description: their sheet carries it, and repeating it there competes with the reference image
that will travel.

**Audio.** Put dialogue in the shot's audio direction, not in the description. Ambient and action
sound is worth naming when it matters. Do not ask for music or subtitles — those are decided
elsewhere and asking here fights that decision.`;

// ---------------------------------------------------------------------------
// Seedance — storyboards (T-11)
// ---------------------------------------------------------------------------

const SEEDANCE_STORYBOARD = `## Drawing a storyboard this model family can read

A storyboard drawn as a *reference* is not a presentation board. It is read for plot, staging and
shot progression, and the qualities that make it readable are close to the opposite of the ones
that make it look finished.

**Line art only.** Stick figures and simple contour drawing. Flat, clean, uncluttered, no
rendering, no shading, no texture, no colour grading. A dense, heavily rendered board reads as
noise and produces a still output or panels in the wrong order.

**No text inside the image.** No labels, captions, shot numbers, arrows with words, or titles.
Text drawn on a panel is text the model may render into the frame, and a burned-in caption cannot
be removed from the footage afterwards.

**Few panels.** Stay at or under the cap you are given. Past it, sequence order degrades before
anything else does — the panels stop being read in the order they are drawn.

**One panel per shot, in order.** Left to right, top to bottom. Each panel shows the staging: who
is in frame, where they stand relative to each other, what the shot size is, and where the camera
is. Draw the composition, not the finish.

**Agree with the prompt.** A panel that contradicts its shot description is worse than no panel,
because the two are read together and neither wins cleanly. If the description changes, the board
is redrawn.`;

/**
 * The shipped skills. Vendored here rather than fetched (R-15), and keyed by family rather than
 * by model id, because two routes of one family answer the same conventions.
 */
export const SKILLS: readonly Skill[] = [
  {
    id: "seedance-scene-drafting",
    version: 1,
    family: "seedance",
    purpose: "scene-drafting",
    body: SEEDANCE_SCENE_DRAFTING,
  },
  {
    id: "seedance-storyboard",
    version: 1,
    family: "seedance",
    purpose: "storyboard",
    body: SEEDANCE_STORYBOARD,
  },
];

/**
 * The skill for a purpose and a family, or null (R-16, R-20).
 *
 * Null is an ordinary answer, not an error: a family with no skill drafts under general guidance
 * and says so. Never falls back to another family's document — advice written for one model
 * produces shots for a model that will not read them, which is worse than no advice at all.
 */
export function skillFor(purpose: SkillPurpose, family: string | undefined): Skill | null {
  if (family === undefined) return null;
  return SKILLS.find((skill) => skill.purpose === purpose && skill.family === family) ?? null;
}

/** How a skill is named where one is recorded or reported. */
export function skillLabel(skill: Skill): string {
  return `${skill.id}@v${skill.version}`;
}
