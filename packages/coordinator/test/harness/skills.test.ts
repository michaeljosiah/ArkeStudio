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
  assert.match(body, /Before you write the next shot, look at the end of the shot before it as the Cut plays it/);
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
  assert.match(route, /Keep the other hand out of the shot/);
  assert.doesNotMatch(route, /his right wrist\s+bare/);
  assert.match(route, /24 frames a second/);
  const sound = (await loadCraftSkill("sound-and-pace"))!.body;
  assert.match(sound, /Turn ducking off for it/);
  assert.match(sound, /No mouth moves without a line/);
  assert.match(sound, /An insert lasts about a second/);
  const continuity = (await loadCraftSkill("continuity-across-cuts"))!.body;
  assert.match(continuity, /an insert about a second/);
  assert.match(continuity, /Say how the seats face/);
});

it("shot 7's lessons reach the continuity skill: the Cut's end of a clip, and a hand named by what it wears", async () => {
  // Arke matched shot 7 to the end of a take the Cut plays for one second, and two frames put the
  // card in the wrong hand until the card was tied to the hand that wears the watch.
  const continuity = (await loadCraftSkill("continuity-across-cuts"))!.body;
  assert.match(continuity, /look where the Cut ends that clip, not where its take ends/);
  assert.match(continuity, /Name a hand by what it wears/);
});

it("the local route's skill knows a face the start frame hides comes out a stranger (shot 5, 2026-11-23)", async () => {
  const route = (await loadCraftSkill("local-h3-video"))!.body;
  assert.match(route, /So does a face the start frame hides/);
  assert.match(route, /When a face turns or rises into view, make the shot on the reference route/);
});

it("the continuity skill names in the first frame only who is in it (She sits, 2026-11-23)", async () => {
  const continuity = (await loadCraftSkill("continuity-across-cuts"))!.body;
  assert.match(continuity, /Name in the first frame only who is in it/);
  assert.match(continuity, /Place the camera without naming him/);
  assert.match(continuity, /leave them out of the first frame's words\s+entirely, their clothes too/);
});

it("the owner's notes of 2026-11-24 reach the skills: a quoted line, a pause in the voice line, a near hand", async () => {
  // Shot 4 gave Tunde words of its own until its line was quoted whole; the goat's face got its second from a pause cut
  // into the voice line; a wide put Ade's glass in his far hand twice until the hand was named by where it is.
  const route = (await loadCraftSkill("local-h3-video"))!.body;
  assert.match(route, /Quote the line whole in a shot that speaks/);
  assert.match(route, /It keeps the voice line's timing, its silences too/);
  assert.match(route, /cutting that silence into the voice line before the clip is made/);
  assert.match(route, /Its sound may carry music/);
  const continuity = (await loadCraftSkill("continuity-across-cuts"))!.body;
  assert.match(continuity, /his near\s+hand, the one nearest the camera, which wears the watch, holds the glass/);
  const sound = (await loadCraftSkill("sound-and-pace"))!.body;
  assert.match(sound, /If a take starts talking before its line, start the line there/);
  assert.match(sound, /Start the close shot's\s+picture that much later into its take/);
});

it("the owner's notes of 2026-11-25 reach the skills: a moving camera, split cuts, one room, a line on the take's voice", async () => {
  // Fifty clips made "locked off" never breathed; no line crossed a cut; every take brought its own room tone; five
  // re-read lines sat 60 to 120 ms off the lips, and a frame lost at each cut slid the voices 0.7 s off by a part's end.
  const continuity = (await loadCraftSkill("continuity-across-cuts"))!.body;
  assert.match(continuity, /Leave room to split the cut/);
  assert.match(continuity, /Move the camera as the production does/);
  assert.match(continuity, /Never write "locked off" or "does not move" to do it/);
  assert.match(continuity, /Say whether each camera does what its shot asked/);
  const sound = (await loadCraftSkill("sound-and-pace"))!.body;
  assert.match(sound, /Run the last words over the listener/);
  assert.match(sound, /Start an interruption under the shot before/);
  assert.match(sound, /trim the picture, never the line/);
  assert.match(sound, /One room under every take/);
  assert.match(sound, /Gate the rest of it away/);
  assert.match(sound, /place the\s+recording by the take's voice/);
  assert.match(sound, /Check the sync at the end of a cut as well as at its start/);
});

it("the continuity skill fills the room the place describes, and says who is at a table (the club, 2026-11-23)", async () => {
  // "Nobody else is in the picture", written to keep strangers out of the booth, emptied a busy club in
  // every shot that saw the room.
  const continuity = (await loadCraftSkill("continuity-across-cuts"))!.body;
  assert.match(continuity, /A place's views are drawn empty/);
  assert.match(continuity, /Write the place's crowd into\s+every shot that sees the room/);
  assert.match(continuity, /never "nobody else is in the picture"/);
  assert.match(continuity, /A full floor in one shot is full in the next/);
});

it("the local route's skill says it speaks a line anew and can garble it (shot 8, 2026-11-23)", async () => {
  const route = (await loadCraftSkill("local-h3-video"))!.body;
  assert.match(route, /It says the line again, in its own way/);
  assert.match(route, /play the shot's own\s+voice line under the picture/);
});

it("the local route's skill knows the first-frame sibling: an exact opening, and 2,000 characters (shot 5, 2026-11-23)", async () => {
  // Shot 5 matched shot 4's last pose from a new angle only because the first-frame route opens on the drawn
  // frame; Arke's wording for it ran to 2,007 characters, which that route refuses to send.
  const route = (await loadCraftSkill("local-h3-video"))!.body;
  assert.match(route, /It opens on the shot's start frame, exactly/);
  assert.match(route, /It takes 2,000 characters at most/);
  assert.match(route, /start the clip in the Cut just before it/);
});

it("the local route's skill knows who comes out a stranger, and where a crossing walks (shots 10 and 11, 2026-11-23)", async () => {
  // Shot 10's first-frame take gave Ife another dress and build; the reference take kept her look and the
  // glass at the cut but walked her through the foreground; a closer shot of its own kept her behind him.
  const route = (await loadCraftSkill("local-h3-video"))!.body;
  assert.match(route, /Someone who is not in the start frame comes out a stranger on the first-frame route/);
  assert.match(route, /Make such a shot on the reference route/);
  assert.match(route, /may walk through the foreground/);
  assert.match(route, /split the shot/);
  assert.match(route, /none on another/);
});

it("the board skill names the read, the length and each seam command Arke can send (2026-11-25)", async () => {
  const body = (await loadCraftSkill("board-seams"))!.body;
  for (const term of [/get_scene_boards/, /set-board-target/, /move-board-boundary/, /set-board-override/, /target length/, /Only consecutive shots/]) {
    assert.match(body, term);
  }
});
