import { readFile } from "node:fs/promises";
import { skillFor, skillLabel, type SessionConfigInput } from "@arke-studio/contracts";

/** Read the closed shipped set once for this session; no world, Settings or environment paths. */
export async function loadSkillBodies(
  input: Pick<SessionConfigInput, "skillFamily" | "skillModelId">,
  directory = new URL("./skills/", import.meta.url),
): Promise<Record<string, string>> {
  const bodies: Record<string, string> = {};
  for (const purpose of ["scene-drafting", "storyboard"] as const) {
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
