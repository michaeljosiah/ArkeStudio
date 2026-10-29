import { z } from "zod";
import { HarnessEngineSchema } from "./harness.js";
import { setupClosure, type SetupComponent } from "./setup.js";
import { harnessModelDisabled, harnessModelMissingInput, harnessModelReference } from "./harness-models.js";
import type { ClientState } from "./client-state.js";

/** SPEC-016 R-21–R-28. Journey progress, not another runtime/settings authority. */
export const OnboardingPlanSchema = z.object({
  version: z.literal(1).default(1),
  persona: z.enum(["guided", "advanced", "lightweight"]).nullable().default(null),
  step: z.enum(["choose", "check", "assistant", "writing", "accounts", "account", "capabilities", "sources", "review", "progress", "lightweight", "done"]).default("choose"),
  writing: z.enum(["none", "local", "account", "existing"]).default("none"),
  harness: HarnessEngineSchema.default("opencode"),
  account: z.enum(["openai", "github-copilot"]).nullable().default(null),
  modelId: z.string().min(1).nullable().default(null),
  media: z.boolean().default(false),
  voice: z.boolean().default(false),
}).strict();
export type OnboardingPlan = z.infer<typeof OnboardingPlanSchema>;
export const NEW_ONBOARDING: OnboardingPlan = OnboardingPlanSchema.parse({});
export const OnboardingWorkspaceSchema = z.object({
  path: z.string(), ready: z.boolean(), detail: z.string().nullable(),
}).strict();
export const OnboardingStatusSchema = z.object({
  plan: OnboardingPlanSchema,
  workspace: OnboardingWorkspaceSchema.nullable().default(null),
  localModel: z.object({ modelId: z.string(), endpoint: z.string().nullable(), ready: z.boolean(), detail: z.string() }).strict().nullable().default(null),
}).strict();
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;

/** Only qualified, fitting catalogue models with a concrete acquisition path are offered. */
export function onboardingLocalModels(app: ClientState["app"]) {
  const components = app.setup?.components ?? [];
  return (app.runtime?.models ?? []).filter(model => model.capability === "llm" && model.provider === "ollama" &&
    model.locality === "local" && model.fit === "runs-well" && !app.models.disabled.includes(model.modelId) &&
    app.manifest?.models.some(entry => entry.id === model.modelId && entry.unverified !== true) &&
    components.some(c => c.provides?.includes(model.modelId) && c.explicitChoiceOnly !== true))
    .sort((a, b) => Number(b.modelId === app.runtime?.recommended.llm) - Number(a.modelId === app.runtime?.recommended.llm));
}

export function onboardingComponents(plan: OnboardingPlan, components: readonly SetupComponent[]): SetupComponent[] {
  const roots: string[] = [];
  if (plan.writing === "local" && plan.modelId) {
    const model = components.find(c => c.engine === "ollama" && c.provides?.includes(plan.modelId!));
    if (model) roots.push(model.id);
  }
  if (plan.media) roots.push("comfyui-runtime");
  if (plan.voice) roots.push("tts-kokoro-82m", "stt-whisper-base-en");
  const ids = new Set<string>();
  for (const root of roots) {
    ids.add(root);
    for (const id of setupClosure(components, root).componentIds) ids.add(id);
  }
  return components.filter(c => ids.has(c.id));
}

/** The account catalogue comes from the running harness; no generation is used as a sign-in probe. */
export function onboardingWritingModels(app: ClientState["app"], plan: OnboardingPlan) {
  const running = app.harnessInfo?.generation === "v2" ? "opencode" : app.harnessInfo?.generation ?? app.harness?.launchEngine;
  if (app.harnessModelStatus.status !== "ready" || running !== plan.harness) return [];
  return app.harnessModels.filter(model =>
    (plan.writing !== "account" || model.provider === plan.account) &&
    (plan.writing !== "local" || model.provider === "ollama") &&
    !harnessModelMissingInput(model) && model.tools !== false &&
    !harnessModelDisabled(model, app.models.disabled, app.manifest?.models))
    .sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true));
}

export function onboardingWritingReadiness(app: ClientState["app"], plan: OnboardingPlan): { ready: boolean; detail: string } {
  if (plan.writing === "none") return { ready: false, detail: "Not set up. You can write manually." };
  const running = app.harnessInfo?.generation === "v2" ? "opencode" : app.harnessInfo?.generation ?? app.harness?.launchEngine;
  if (running !== plan.harness) return { ready: false, detail: "Restart Arke to use your selected assistant." };
  if (app.health.harness.status !== "healthy") return { ready: false, detail: "Your writing assistant is not responding yet." };
  if (plan.writing === "account") {
    const vendor = app.vendorAuth.vendors.find(v => v.id === plan.account);
    if (!vendor || vendor.needsSignIn || !vendor.connections.some(c => c.kind === "stored")) return { ready: false, detail: "Sign in to the account you selected." };
  }
  const models = onboardingWritingModels(app, plan);
  const model = models.find(m => harnessModelReference(m) === plan.modelId ||
    (plan.writing === "local" && app.manifest?.models.some(entry => entry.id === plan.modelId && entry.provider === m.provider &&
      (entry.providerModelId ?? entry.id) === m.id)));
  if (!model) return { ready: false, detail: "Choose an available writing model after checking your connection." };
  if (plan.writing === "local" && app.ollama?.state !== "ready") return { ready: false, detail: "The selected local model service is not ready." };
  if (plan.writing === "local" && (app.onboarding?.localModel?.modelId !== plan.modelId || !app.onboarding.localModel.ready || app.onboarding.localModel.endpoint !== app.ollama?.url)) {
    return { ready: false, detail: app.onboarding?.localModel?.modelId === plan.modelId ? app.onboarding.localModel.detail : "Check the downloaded writing model before using it." };
  }
  return { ready: true, detail: `${model.displayName ?? model.id} is available to your writing assistant.` };
}
