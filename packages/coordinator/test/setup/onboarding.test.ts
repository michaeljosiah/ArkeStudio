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

it("writing setup sets one writer default without pinning inheriting or private agents", async () => {
  const path = join(await tempDir("arke-onboarding-model-"), "settings.json");
  const file = new AppSettingsFile(path);
  const plan = OnboardingPlanSchema.parse({ persona: "guided", writing: "account", account: "openai", step: "review", modelId: "openai/chosen" });
  const saved = await file.setOnboarding(plan, "openai/chosen");
  assert.deepEqual(saved.agents, { "story-writer": { model: "openai/chosen" } });
  await file.setAgent("story-writer", { model: "openai/custom" });
  await file.setAgent("world-builder", { model: "openai/other", brief: "Keep my brief." });
  await file.setAgent("stage-designer", { model: "openai/vision" });
  const before = (await file.load()).agents;
  await file.setOnboarding(plan, "openai/new-choice");
  assert.deepEqual((await new AppSettingsFile(path).load()).agents, before);
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

it("voice onboarding selects the chosen recognizer's format without treating GGML as converted weights", () => {
  const components = ["tts-kokoro-82m", "stt-whisper-base-en", "stt-faster-whisper-base-en"].map(id =>
    SetupComponentSchema.parse({ id, displayName: id, purpose: id, sizeMb: 100, installLocation: null, state: "available" }));
  const plan = { ...NEW_ONBOARDING, voice: true };
  assert.deepEqual(onboardingComponents(plan, components, "pipecat").map(component => component.id), ["tts-kokoro-82m", "stt-whisper-base-en", "stt-faster-whisper-base-en"]);
  assert.deepEqual(onboardingComponents(plan, components, "voxa").map(component => component.id), ["tts-kokoro-82m", "stt-whisper-base-en"]);
});
