import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { NEW_ONBOARDING, onboardingComponents, OnboardingPlanSchema, SetupComponentSchema } from "@arke-studio/contracts";
import { AppSettingsFile } from "../../src/app-settings.js";
import { checkOnboardingWorkspace, validateOnboardingPlan } from "../../src/setup/onboarding.js";
import { ReadModel } from "../../src/read-model.js";
import { tempDir } from "../tmp.js";

it("checks a real writable workspace without leaving probe files", async () => {
  const root = await tempDir("arke-onboarding-");
  assert.deepEqual(await checkOnboardingWorkspace(root), { path: root, ready: true, detail: null });
  assert.deepEqual(await readdir(root), ["worlds"]);
  assert.deepEqual(await readdir(join(root, "worlds")), []);
  const file = join(root, "not-a-folder"); await writeFile(file, "keep me");
  assert.equal((await checkOnboardingWorkspace(file))?.ready, false);
  assert.equal(await readFile(file, "utf8"), "keep me");
});

it("a fresh install resumes its saved journey; legacy settings do not force onboarding", async () => {
  const path = join(await tempDir("arke-onboarding-settings-"), "settings.json");
  const file = new AppSettingsFile(path);
  assert.deepEqual((await file.load()).onboarding, NEW_ONBOARDING);
  const plan = OnboardingPlanSchema.parse({ persona: "advanced", step: "sources", writing: "existing", harness: "codex" });
  await file.setOnboarding(plan);
  const reopened = await new AppSettingsFile(path).load();
  assert.deepEqual(reopened.onboarding, plan); assert.equal(reopened.harness.engine, "codex");
  await writeFile(path, "{}"); assert.equal((await file.load()).onboarding, undefined);
});

it("writing setup fills existing authoring settings without rerouting private agents or custom choices", async () => {
  const path = join(await tempDir("arke-onboarding-model-"), "settings.json");
  const file = new AppSettingsFile(path);
  await file.setAgent("story-writer", { model: "openai/custom" });
  const plan = OnboardingPlanSchema.parse({ persona: "guided", writing: "account", account: "openai", step: "review", modelId: "openai/chosen" });
  const saved = await file.setOnboarding(plan, "openai/chosen");
  assert.equal(saved.agents["world-builder"]?.model, "openai/chosen");
  assert.equal(saved.agents["story-writer"]?.model, "openai/custom");
  for (const name of ["studio-assistant", "diagnostic-specialist", "stage-designer", "chapter-visual-reviewer"]) assert.equal(saved.agents[name], undefined);
});

it("Lightweight has no AI closure, while selected capabilities include missing dependencies once", () => {
  const component = (id: string, requires: string[] = [], state = "available") => SetupComponentSchema.parse({ id, displayName: id, purpose: id, sizeMb: 10, installLocation: null, state, requires });
  const components = [component("ollama-runtime"), { ...component("text", ["ollama-runtime"]), engine: "ollama" as const, provides: ["writer"] }, component("comfyui-runtime"), component("tts-kokoro-82m"), component("stt-whisper-base-en")];
  assert.deepEqual(onboardingComponents(NEW_ONBOARDING, components), []);
  assert.deepEqual(onboardingComponents({ ...NEW_ONBOARDING, writing: "local", modelId: "writer", media: true }, components).map(c => c.id), ["ollama-runtime", "text", "comfyui-runtime"]);
  components[0]!.state = "present";
  assert.deepEqual(onboardingComponents({ ...NEW_ONBOARDING, writing: "local", modelId: "writer" }, components).map(c => c.id), ["text"]);
});

it("unknown hardware cannot turn a local writing choice into an accepted download", () => {
  const app = new ReadModel("test").getState().app;
  assert.match(validateOnboardingPlan({ ...NEW_ONBOARDING, persona: "guided", writing: "local", modelId: "made-up" }, app)!, /not been confirmed/);
  assert.equal(validateOnboardingPlan({ ...NEW_ONBOARDING, persona: "lightweight" }, app), null);
});
