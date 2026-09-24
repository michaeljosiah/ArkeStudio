import { readFileSync } from "node:fs";
import { SKILLS, skillFor } from "../src/skills.js";

// Test fixtures use the same shipped bytes as session preparation; contracts runtime stays pure.
export const shippedSkillBodies = Object.fromEntries(SKILLS.map(skill => [
  skill.id, readFileSync(new URL(`../../coordinator/src/harness/skills/${skill.bodyPath}`, import.meta.url), "utf8").trimEnd(),
]));
export function loadedSkillFor(...args: Parameters<typeof skillFor>) {
  const skill = skillFor(...args);
  return skill ? {...skill, body: shippedSkillBodies[skill.id]!} : null;
}
