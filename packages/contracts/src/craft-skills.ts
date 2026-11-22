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
    version: 2,
    title: "Continuity across cuts",
    when: "before you plan, review or change shots that already have takes, and before a cut is approved",
    bodyPath: "continuity-across-cuts.md",
  },
];

export function craftSkill(id: string): CraftSkill | null {
  return CRAFT_SKILLS.find((skill) => skill.id === id) ?? null;
}

/** The trigger every video thread carries: each skill's id and when to read it. */
export const CRAFT_SKILLS_LINE = `Craft skills you can read with read_skill, by id: ${CRAFT_SKILLS.map(
  (skill) => `${skill.id} (read it ${skill.when})`,
).join("; ")}.`;
