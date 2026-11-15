import assert from "node:assert/strict";
import { it } from "node:test";
import type { Proposal } from "@arke-studio/contracts";
import { projectReview } from "../../src/gate/review.js";

/** A graph scene as the store writes it: Entry, the shots in order, Exit. */
function sceneFile(shots: readonly { id: string; title: string; description: string; durationSec?: number; camera?: string }[], over: Record<string, unknown> = {}): string {
  const entry = "sfn_sc-intro-lagoon-entry", exit = "sfn_sc-intro-lagoon-exit";
  const nodes = shots.map((shot) => `sfn_${shot.id.replace("_", "-")}`);
  const chain = [entry, ...nodes, exit];
  return JSON.stringify({
    id: "sc_intro-lagoon", number: 1, slug: "intro-lagoon", title: "Intro: the lagoon", synopsis: "Black water at night.", status: "draft", version: 1,
    flow: {
      schemaVersion: 1, entryNodeId: entry, exitNodeId: exit,
      nodes: [{ id: entry, kind: "entry" }, ...shots.map((shot, index) => ({ id: nodes[index], kind: "shot", shot: { ...shot, number: index + 1 } })), { id: exit, kind: "exit" }],
      edges: chain.slice(1).map((to, index) => ({ id: `sfe_${index}`, kind: "sequence", from: { nodeId: chain[index], port: "out" }, to: { nodeId: to, port: "in" } })),
      storyboardGroups: [],
    },
    ...over,
  });
}

const path = "productions/why-you-do-me/scenes/01-intro-lagoon.json";
const proposal: Proposal = { id: "pr_01J8H0000000000000000000Z9", kind: "scene-edit", summary: "Shot 2: the hold", source: "world-chat:cv_01J8H0000000000000000000C1",
  targets: [{ path, baseVersion: 1, baseHash: "base" }], baseCanonRevision: 1, reservedCanonIds: [], created: "2026-11-14T00:00:00Z", draftRevision: 1 };
const water = { id: "sh_water", title: "Black water", description: "Gold knocks on gold off-screen.", durationSec: 4 };
const hold = { id: "sh_hold", title: "The hold", description: "Nothing moves but the water.", durationSec: 3, camera: "locked wide" };

it("shows a scene's shots by number, title and length rather than its JSON (issue 3093)", () => {
  const [target] = projectReview({ proposal, base: () => sceneFile([water]), proposed: () => sceneFile([water, hold]) }).targets;
  assert.ok(target);
  assert.equal(target.label, "Intro: the lagoon");
  assert.deepEqual(target.fields.map((field) => field.field), ["Shots", "Shot 2 · The hold"], "only what changed, and no file");
  const shots = target.fields.find((field) => field.field === "Shots")!;
  assert.equal(shots.before, "1. Black water · 4s");
  assert.equal(shots.proposed, "1. Black water · 4s\n2. The hold · 3s");
  const added = target.fields.find((field) => field.field === "Shot 2 · The hold")!;
  assert.equal(added.before, null);
  assert.equal(added.proposed, "Nothing moves but the water.\nCamera: locked wide");
  assert.ok(target.fields.every((field) => !String(field.proposed).includes('"flow"')));
});

it("shows a prompt override's settings when only they change", () => {
  const override = (capability: "image" | "video", version: number) =>
    ({ ...hold, promptOverride: { text: "A locked wide on the water.", capability, sheetVersions: { "the-lady": version } } });
  const [target] = projectReview({ proposal, base: () => sceneFile([override("image", 1)] as never), proposed: () => sceneFile([override("video", 2)] as never) }).targets;
  assert.deepEqual(target!.fields.map((field) => field.field), ["Shot sh_hold · Prompt override settings"], "the words did not change, what they are for did");
  assert.match(target!.fields[0]!.before!, /"capability": "image"/);
  assert.match(target!.fields[0]!.proposed!, /"capability": "video"[\s\S]*"the-lady": 2/);
});

it("still shows a change the shot list does not cover", () => {
  const [target] = projectReview({ proposal, base: () => sceneFile([water]), proposed: () => sceneFile([water], { inherits: { timeOfDay: "night" } }) }).targets;
  assert.deepEqual(target!.fields.map((field) => field.field), ["Other scene details"]);
  assert.match(target!.fields[0]!.proposed!, /"timeOfDay": "night"/);
});
