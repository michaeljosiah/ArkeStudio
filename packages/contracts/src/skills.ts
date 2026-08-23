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
  /**
   * The models inside that family this narrows to, when the family is not of one mind (2026-08-23).
   *
   * Absent means the whole family, which is still the ordinary case and the reason skills are
   * keyed by family at all. Present is for a version that genuinely directs differently: Seedance
   * 2.5 runs to thirty seconds where 2.0 stops at fifteen, and thirty seconds is not fifteen
   * twice — it is a sequence with movements, where fifteen is a shot or two. Guidance that hedged
   * across both would be guidance that fits neither.
   *
   * A narrowed skill beats the family's own for the models it names; the family document stays
   * for everything else, so adding a version never leaves a route with no advice.
   */
  models?: string[];
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

**Emotion.** State the intended emotion directly and support it with one observable cue. Do not
turn an emotional beat into a chain of actions — the chain reads as choreography and the feeling
is lost in the traffic.
Wrong: "He crosses the room, stops, turns, wipes his eye, looks down, then sits."
Right: "He is overwhelmed; his lower lip trembles as he moves so slowly it barely reads as walking."

**Expression.** Describe what the face and body do, in plain words. Idiom does not survive: "she
is beside herself" is rendered literally or ignored, where "her jaw tightens and she looks away"
is neither. The same goes for "sees red", "lights up", "falls apart".

**Shot continuity.** Each shot you author is one uninterrupted camera setup. Describing per-second
phases inside a shot invites an internal hard cut the description never asked for. This rule holds
within one shot: it does not stop several authored shots from being packed into a whole-scene clip
with explicit boundaries — that packing happens downstream and keeps your shots intact.
Wrong: "In the first 3 seconds he reaches the door; in the next 3 seconds he turns and sits."
Right: "One continuous shot: overwhelmed, he drifts to the door and sinks into the chair."

**Motion.** Give the shot one smooth, dominant motion. Stacked micro-gestures morph into one
another instead of reading in sequence. A single gesture also stays legible if the production
later reverses the clip in post — a plan some shots are written for.

**Camera.** Standard vocabulary can be written directly and needs no explanation — shot size
(extreme wide, wide, medium, medium close-up, close-up), movement (push in, pull out, pan,
track, follow, orbit, tilt up, handheld), angle (low, overhead, first person), and named
techniques (one-shot, dolly zoom, aerial, FPV, bullet time, speed ramp). An unusual term needs a
clause explaining it: "rack focus: the foreground trees blur as the figure behind them sharpens".

**Camera anchors.** When the location prose or the user's brief names a fixture, anchor the
camera to it: put the fixture and the facing direction in the shot's camera value first, then the
ordinary size and movement vocabulary. Never invent a fixture the location or brief does not
support, and never write relative corrections — a nudge moves the furniture, not the camera.
Wrong: "move the camera closer to the fridge."
Right: "at the kettle beside the fridge, facing the hallway; medium close-up, slow push-in."

**Framing.** The shot's framing fields — size, angle, lens, focus, movement, pace, lighting, time
of day, grade — are sent as camera grammar, in that order, exactly as set. They are read
literally, so set the ones you mean and leave the rest: an unset lens is silence, and silence is
better than a lens nobody chose. A field the scene already sets is inherited and still spoken, so
do not repeat the scene's own lens on every shot to make sure.

**Transitions.** Give both the trigger and the method: "at the cut, a fast whip pan left into the
next setup". A transition with only one of the two is guesswork. Better still, give the two shots
something in common for the cut to land on — a shape, a movement, a colour that is in the last
frame of one and the first of the next. "The circle of the drum head, then the circle of the ring
light" is a cut the model can actually make; "cut to the studio" is a hope.

**What must not be in it.** A shot can say what to keep out, and it is sent as a negative rather
than as part of the description. That is the whole reason to use it: a thing named in the
description is a thing you have handed the model. "No wristwatch" written into the action puts a
wristwatch in the room. Keep-outs are for what a model reliably adds unasked — a modern object in
a period frame, a second light source, a crowd where there should be three people.

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
// Seedance 2.5 — scene drafting (2026-08-23)
//
// Everything the family document says still holds; what changes is the length. 2.5 takes up to
// thirty seconds in one call where 2.0 stops at fifteen, and thirty seconds is not fifteen twice.
// It is long enough to hold a sequence with movements in it, which makes a handful of things
// worth saying that would be noise at six seconds — and makes one of the family's rules need
// restating rather than dropping, because the temptation to break a shot into timed phases gets
// much stronger when there is room for them.
// ---------------------------------------------------------------------------

const SEEDANCE_25_SCENE_DRAFTING = `${SEEDANCE_SCENE_DRAFTING}

## What is different about this model

**It runs to thirty seconds.** A shot here can hold a whole movement — an approach, a turn and a
consequence — where a shorter model holds one gesture. Write the longer shot when the beat earns
it, and keep writing short ones when it does not: length is not quality, and a thirty-second shot
of someone crossing a room is thirty seconds of someone crossing a room.

**The one-setup rule holds anyway, and matters more.** Room for phases is not permission to write
them. "In the first six seconds… then for the next eight…" still asks for an internal hard cut
inside what you declared to be one continuous take. If a beat genuinely needs a cut, it is two
shots, and the packing downstream gives you the boundary properly.

**Say what must not change.** With a longer take there is more time for a face to drift, a
garment to re-cut itself, or a room to redecorate between the start and the end. Name the
invariant rather than asking for consistency in general: "the scar stays on the left cheek", "the
wrapper keeps its pattern", "the light stays hard and from the window". A named invariant is
something a model can check against; "keep it consistent" is not.

**Reference images are numbered, but not by you.** This family reads numbered references — the
route's own words are "refer to them in the prompt as @Image1, @Image2" — and the numbering is
worked out at dispatch, per shot, from whichever artifacts exist and fit the budget. So never
write @Image1 into a shot: the slot it lands in is not knowable when you are writing, and a
citation bound to the wrong subject is worse than none. Name the character or the location with
its ordinary @mention; the reference that travels for it is chosen and numbered downstream.

**It can hear.** This family takes reference audio and video alongside the images, each between
1.8 and 30.2 seconds. Nothing asks you to supply them, but audio direction on a long shot is worth
placing where the sound happens rather than as one line about the whole clip.`;

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
    // v3: framing, keep-outs and cuts-on-a-shared-shape, once those fields began reaching the
    // model. Bumped because two scenes drafted either side of this were drafted differently.
    version: 3,
    family: "seedance",
    purpose: "scene-drafting",
    body: SEEDANCE_SCENE_DRAFTING,
  },
  {
    id: "seedance-2.5-scene-drafting",
    version: 1,
    family: "seedance",
    models: ["seedance-2.5"],
    purpose: "scene-drafting",
    body: SEEDANCE_25_SCENE_DRAFTING,
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
export function skillFor(purpose: SkillPurpose, family: string | undefined, modelId?: string): Skill | null {
  if (family === undefined) return null;
  const mine = SKILLS.filter((skill) => skill.purpose === purpose && skill.family === family);
  // The narrowed one first: a version that directs differently should not be told the family's
  // general advice when its own exists. Falls through to the family document, so a model with no
  // entry of its own is never left without one.
  return (
    (modelId !== undefined ? mine.find((skill) => skill.models?.includes(modelId)) : undefined) ??
    mine.find((skill) => skill.models === undefined) ??
    null
  );
}

/** How a skill is named where one is recorded or reported. */
export function skillLabel(skill: Skill): string {
  return `${skill.id}@v${skill.version}`;
}
