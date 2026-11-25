import { readFile } from "node:fs/promises";
import { craftSkill, skillFor, skillLabel, type CraftSkill, type SessionConfigInput } from "@arke-studio/contracts";

/**
 * One craft skill's body, by id, for `read_skill` (design turn 286), or null for an id that is not
 * shipped. Read from the same shipped folder as the authoring skills, never a world, Settings or
 * environment path. A registered skill whose file is missing or empty is a packaging fault and
 * throws, as `loadSkillBodies` does, rather than reading as "no such skill".
 */
export async function loadCraftSkill(
  id: string,
  directory = new URL("./skills/", import.meta.url),
): Promise<{ skill: CraftSkill; body: string } | null> {
  const skill = craftSkill(id);
  if (!skill) return null;
  try {
    const body = await readFile(new URL(skill.bodyPath, directory), "utf8");
    if (!body.trim()) throw new Error("the file is empty");
    return { skill, body: body.trimEnd() };
  } catch (cause) {
    throw new Error(`Could not load craft skill ${skill.id}@v${skill.version} (${skill.bodyPath}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/** Read the closed shipped set once for this session; no world, Settings or environment paths. */
export async function loadSkillBodies(
  input: Pick<SessionConfigInput, "skillFamily" | "skillModelId">,
  directory = new URL("./skills/", import.meta.url),
): Promise<Record<string, string>> {
  const bodies: Record<string, string> = {};
  for (const purpose of ["scene-drafting", "storyboard", "chapter-script-review", "chapter-visual-review", "chapter-prose-review"] as const) {
    const skill = skillFor(purpose, input.skillFamily, input.skillModelId);
    if (!skill) continue;
    try {
      const body = await readFile(new URL(skill.bodyPath, directory), "utf8");
      if (!body.trim()) throw new Error("the file is empty");
      bodies[skill.id] = body.trimEnd();
    } catch (cause) {
      throw new Error(`Could not load authoring skill ${skillLabel(skill)} (${skill.bodyPath}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  }
  return bodies;
}
