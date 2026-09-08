import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFile, copyFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join, sep } from "node:path";
import { sessionSkillForAgent, agentPromptFor } from "@arke-studio/contracts";
import { loadSkillBodies } from "../../src/harness/skills.js";
import { writeSessionFiles } from "../../src/harness/session-files.js";
import { tempDir } from "../tmp.js";

it("captures shipped guidance at preparation with the same narrowed identity and fixed confinement", async () => {
  const input = {skillFamily:"seedance",skillModelId:"seedance-2.5"};
  let captured = {};
  await writeSessionFiles({prepareSession: prepared => {captured = prepared;}}, await tempDir("arke-skills-"), input);
  const skill = sessionSkillForAgent("scene-writer", captured)!;
  assert.equal(skill.id,"seedance-2.5-scene-drafting");
  assert.match(skill.body,/thirty seconds/);
  const prompt = agentPromptFor({brief:"A user brief",needsProposal:true,skill,postscript:"Fixed result shape"});
  assert.ok(prompt.indexOf("Edit only files") < prompt.indexOf("<AUTHORING_SKILL"));
  assert.match(prompt,/<AUTHORING_SKILL id="seedance-2.5-scene-drafting" version="1">/);
  assert.match(prompt,/<\/AUTHORING_SKILL>\s+Fixed result shape$/);
  assert.throws(() => sessionSkillForAgent("scene-writer", input),/was not loaded/);
});

it("fails missing or empty registered files, reloads only for the next construction, and leaves unknown families alone", async () => {
  const dir=await tempDir("arke-skill-files-"), directory=pathToFileURL(dir+sep);
  const input={skillFamily:"seedance"};
  await assert.rejects(loadSkillBodies(input,directory),/seedance-scene-drafting@v3/);
  await writeFile(join(dir,"seedance-scene-drafting.md")," \n");
  await assert.rejects(loadSkillBodies(input,directory),/file is empty/);
  await copyFile(new URL("../../src/harness/skills/seedance-storyboard.md",import.meta.url),join(dir,"seedance-storyboard.md"));
  await writeFile(join(dir,"seedance-scene-drafting.md"),"First text");
  const first=await loadSkillBodies(input,directory);
  await writeFile(join(dir,"seedance-scene-drafting.md"),"Next text");
  assert.equal(first["seedance-scene-drafting"],"First text");
  assert.equal((await loadSkillBodies(input,directory))["seedance-scene-drafting"],"Next text");
  assert.deepEqual(await loadSkillBodies({skillFamily:"unknown"},directory),{});
});
