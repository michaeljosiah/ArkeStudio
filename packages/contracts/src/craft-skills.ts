/**
 * Craft skills: how a director does one task, read by Arke when the task begins (design turn 286;
 * issues 3273 and 3278).
 *
 * The authoring skills in `skills.ts` are keyed by a model family and pasted whole into a drafting
 * agent's prompt. These are keyed by task and read in a chat thread through `read_skill`, because
 * they are too long to ride in every turn and only one task needs each. What does ride in every
 * turn is `CRAFT_SKILLS_LINE`: the id of each skill and when to read it. That line is the trigger;
 * a skill nobody is told about is never read, which is exactly how issue 3273 arose.
 *
 * Shipped beside the authoring skills (`coordinator/src/harness/skills/`, copied whole into the
 * desktop build) and never fetched, for the reasons SPEC-019 R-15 gives. Bump `version` whenever a
 * body changes: the read's receipt records `id@vN`, so two cuts judged under different guidance
 * differ for a reason that can be found again.
 */
export interface CraftSkill {
  id: string;
  version: number;
  title: string;
  /** When to read it, as the brief says it. Plain words; it completes "read it ...". */
  when: string;
  /** Shipped Markdown filename beside the authoring skills (never a user path). */
  bodyPath: string;
}

export const CRAFT_SKILLS: readonly CraftSkill[] = [
  {
    id: "continuity-across-cuts",
    // v2: two frames per cut and at most ten cuts a turn. v1 asked for four frames a cut, which
    // spends a turn's 24 frames by the sixth cut of a ten-shot scene.
    // v3: look before writing the shot beside a take, answer from the pictures, and never read a
    // measurement that finds no motion as a still (tested on 0.5.127: all three went wrong).
    // v4: look again each time (0.5.128: in a long thread it repeated a wrong earlier finding).
    // v5: an insert lasts about a second, and a view of shared seats says how they face (the owner's
    // notes on the film, 2026-11-22: a two-second card insert dragged, and a view left to choose drew
    // a corner seat where the next view had two benches).
    // v6: match the shot before as the Cut plays it, and name a hand by what it wears (0.5.131, shot 7:
    // it matched the end of a take the Cut cuts at one second, and two frames put the card in the
    // wrong hand until the card was tied to "the hand that wears the watch").
    // v7: fill the room the place describes, and say who is at a table rather than who is missing (the
    // film's club, 2026-11-23: "Nobody else is in the picture", written to keep strangers out of the booth,
    // emptied the whole room in every shot; with the crowd written in, the same empty view drew it full).
    version: 7,
    title: "Continuity across cuts",
    when: "before you plan, review or change a shot beside one that has a take, and before you review a cut",
    bodyPath: "continuity-across-cuts.md",
  },
  {
    // What the local route did on the film (2026-11-21/22): it spoke a sentence of feeling written in
    // the prompt, invented talk after a line, and put a watch on both wrists.
    // v2: v1 said to name the bare wrist, which take 7d had already disproved; three takes drew the second
    // watch once the other hand showed, and what held was keeping that hand out of the shot.
    // v3: it speaks the line anew rather than playing the voice given, and garbled one (shot 8, 2026-11-23).
    // v4: the first-frame sibling opens on the start frame exactly and takes 2,000 characters (shot 5,
    // 2026-11-23: the same moment from a new angle matched there, and Arke's wording ran to 2,007).
    // v5: someone who enters after the first frame comes out a stranger on the first-frame route; the
    // reference route kept her look and, with the start frame riding, the glass at the cut; a tighter shot
    // kept her crossing behind him; the first-frame route does not always hold before moving (shots 10 and
    // 11, 2026-11-23).
    id: "local-h3-video",
    version: 5,
    title: "Writing for local H3 Reference Video",
    when: "before you write or change a shot's prompt for either local H3 video route (Reference Video, or the first-frame H3 Video)",
    bodyPath: "local-h3-video.md",
  },
  {
    // The owner's notes on the film's cut (2026-11-22): the club's music pumped with ducking, a shot
    // left a mouth moving with no line, and an insert held too long.
    id: "sound-and-pace",
    version: 1,
    title: "Sound and pace in the cut",
    when: "before you change the Cut's music or mix, or the length of a clip",
    bodyPath: "sound-and-pace.md",
  },
];

export function craftSkill(id: string): CraftSkill | null {
  return CRAFT_SKILLS.find((skill) => skill.id === id) ?? null;
}

/** The trigger every video thread carries: each skill's id and when to read it. */
export const CRAFT_SKILLS_LINE = `Craft skills you can read with read_skill, by id: ${CRAFT_SKILLS.map(
  (skill) => `${skill.id} (read it ${skill.when})`,
).join("; ")}.`;
