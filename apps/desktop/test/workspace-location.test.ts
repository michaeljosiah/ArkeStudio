import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NEW_ONBOARDING } from "@arke-studio/contracts";
import { prepareWorkspace, rememberWorkspace, workspaceRoot } from "../src/workspace-location.js";
import { tempDir } from "../../../packages/coordinator/test/tmp.js";

it("workspace selection survives reopening, with explicit launch settings taking precedence", async () => {
  const root = await tempDir("arke-workspace-selection-");
  const file = join(root, "selection.json"), target = join(root, "library");
  assert.equal(workspaceRoot(file, root), root);
  await prepareWorkspace(target, { ...NEW_ONBOARDING, persona: "lightweight" });
  await rememberWorkspace(file, target);
  assert.equal(workspaceRoot(file, root), target);
  assert.equal(workspaceRoot(file, root, root), root);
  assert.equal(JSON.parse(await readFile(join(target, "settings.json"), "utf8")).onboarding.step, "lightweight");
});

it("never overwrites an existing workspace or treats an arbitrary nonempty folder as a library", async () => {
  const root = await tempDir("arke-workspace-preserve-");
  await writeFile(join(root, "settings.json"), "{}");
  await prepareWorkspace(root, NEW_ONBOARDING);
  assert.equal(await readFile(join(root, "settings.json"), "utf8"), "{}");
  const arbitrary = join(root, "pictures"); await mkdir(arbitrary); await writeFile(join(arbitrary, "photo.txt"), "keep");
  await assert.rejects(prepareWorkspace(arbitrary, NEW_ONBOARDING), /empty folder/);
  const world = join(root, "world"); await mkdir(world); await writeFile(join(world, "world.json"), "{}");
  await assert.rejects(prepareWorkspace(world, NEW_ONBOARDING), /world folder/);
});
