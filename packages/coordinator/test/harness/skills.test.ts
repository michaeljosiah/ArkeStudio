import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFile, copyFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join, sep } from "node:path";
import { CRAFT_SKILLS, sessionSkillForAgent, agentPromptFor } from "@arke-studio/contracts";
import { loadCraftSkill, loadSkillBodies } from "../../src/harness/skills.js";
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


it("injects review rubrics into read-only agent prompts without enabling native delegation", async () => {
  const bodies = await loadSkillBodies({ skillFamily: "chapter-review" });
  for (const agent of ["chapter-script-reviewer", "chapter-visual-reviewer", "chapter-prose-reviewer"]) {
    const skill = sessionSkillForAgent(agent, { skillFamily: "chapter-review", skillBodies: bodies })!;
    const prompt = agentPromptFor({ brief: "Review", needsProposal: false, readOnly: true, skill });
    assert.match(prompt, /<AUTHORING_SKILL/);
    assert.ok(prompt.includes(skill.body));
    assert.match(prompt, /cannot do/);
  }
});

it("ships every craft skill the brief names, and reads none it does not (design turn 286)", async () => {
  for (const skill of CRAFT_SKILLS) {
    const read = await loadCraftSkill(skill.id);
    assert.ok(read, skill.id);
    assert.equal(read.skill.version, skill.version);
    assert.match(read.body, new RegExp(`^# ${skill.title}`), "the file is the skill it is registered as");
  }
  assert.equal(await loadCraftSkill("../seedance-storyboard"), null, "an id is looked up, never used as a path");
  const dir = await tempDir("arke-craft-skills-");
  await assert.rejects(loadCraftSkill("continuity-across-cuts", pathToFileURL(dir + sep)), new RegExp(`continuity-across-cuts@v${CRAFT_SKILLS[0]!.version}`), "a registered skill that is missing is a fault, not an absence");
});

it("the continuity skill holds the cut to the standard the test on the film showed it needed", async () => {
  const body = (await loadCraftSkill("continuity-across-cuts"))!.body;
  assert.match(body, /Two still frames cannot show movement/);
  assert.match(body, /never explain it away as movement/i);
  for (const fix of [/Move the cut/, /Cut inside a movement/, /Redraw the opening/, /Change the camera/, /Make it deliberate/]) assert.match(body, fix);
  assert.match(body, /Overlap the action/);
  assert.match(body, /cut_contact_sheet/);
  assert.match(body, /sample_video/);
  // A turn sees about 24 frames; four a cut spent them by the sixth cut of a ten-shot scene.
  assert.match(body, /with a count of 2/);
  assert.match(body, /no more than ten cuts in\s+one turn/);
});

it("the continuity skill looks before it writes, and does not take an unmeasured shot for a still (tested on 0.5.127)", async () => {
  // Planning shot 11 it asked which wrist the bangles were on, which shot 10's take shows; reviewing
  // ten shots it called three slow, dark shots stills because the export review gave them no figures.
  const body = (await loadCraftSkill("continuity-across-cuts"))!.body;
  assert.match(body, /Before you write the next shot, look at the end of the take before it/);
  assert.match(body, /Never ask the person what a take already shows/);
  assert.match(body, /A contact sheet shows no cut/);
  assert.match(body, /A measurement that finds no motion is not a still/);
  assert.match(body, /Never repeat an earlier finding without looking/);
});

it("the film's notes reach the skills: the local route's habits, and the sound and pace of the cut (2026-11-22)", async () => {
  // The local route spoke a sentence of feeling from its prompt, talked on after a line and drew a
  // watch on both wrists; the owner found the club's music pumping, a mouth moving with no line and a
  // two-second insert dragging.
  const route = (await loadCraftSkill("local-h3-video"))!.body;
  assert.match(route, /Quote only the line that is spoken/);
  assert.match(route, /it may invent more words/);
  assert.match(route, /transcribe_audio/);
  assert.match(route, /his right wrist\s+bare/);
  assert.match(route, /24 frames a second/);
  const sound = (await loadCraftSkill("sound-and-pace"))!.body;
  assert.match(sound, /Turn ducking off for it/);
  assert.match(sound, /No mouth moves without a line/);
  assert.match(sound, /An insert lasts about a second/);
  const continuity = (await loadCraftSkill("continuity-across-cuts"))!.body;
  assert.match(continuity, /an insert about a second/);
  assert.match(continuity, /Say how the seats face/);
});
