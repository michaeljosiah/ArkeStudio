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
 * **Shipped, never fetched** (R-15). Public-web research is off by default and may be enabled in
 * Settings (SPEC-005 R-10); it is not a reliable delivery path for the guidance authoring depends
 * on. These documents live in the repository and travel with the application, which keeps first
 * run working on a machine that has never been online and keeps a vendor CDN out of drafting.
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
  /** Shipped Markdown filename, resolved by session preparation (never a user path). */
  bodyPath: string;
}

export type SkillPurpose = "scene-drafting" | "storyboard";

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
    bodyPath: "seedance-scene-drafting.md",
  },
  {
    id: "seedance-2.5-scene-drafting",
    version: 1,
    family: "seedance",
    models: ["seedance-2.5"],
    purpose: "scene-drafting",
    bodyPath: "seedance-2.5-scene-drafting.md",
  },
  {
    id: "seedance-storyboard",
    version: 1,
    family: "seedance",
    purpose: "storyboard",
    bodyPath: "seedance-storyboard.md",
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
