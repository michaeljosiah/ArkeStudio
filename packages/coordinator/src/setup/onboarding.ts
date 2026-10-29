import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { onboardingComponents, onboardingLocalModels, type ClientState, type OnboardingPlan, type OnboardingStatus } from "@arke-studio/contracts";

/** A small real create/flush/remove check in both destinations; it neither moves nor opens a world. */
export async function checkOnboardingWorkspace(root: string): Promise<OnboardingStatus["workspace"]> {
  try {
    for (const directory of [root, join(root, "worlds")]) {
      await mkdir(directory, { recursive: true });
      const path = join(directory, `.arke-write-check-${randomUUID()}`);
      const file = await open(path, "wx");
      try { await file.writeFile("Arke workspace check\n"); await file.sync(); }
      finally { await file.close(); await unlink(path); }
    }
    return { path: root, ready: true, detail: null };
  } catch (error) {
    return { path: root, ready: false, detail: `Your Arke folder could not save a file: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Recheck the choices at acceptance; the renderer cannot invent a downloadable model. */
export function validateOnboardingPlan(plan: OnboardingPlan, app: ClientState["app"]): string | null {
  if (plan.persona === null) return "Choose how you want to set up Arke.";
  if (plan.writing === "local" && (plan.harness !== "opencode" || !onboardingLocalModels(app).some(m => m.modelId === plan.modelId))) {
    return "That local writing model has not been confirmed suitable for this computer. Check again or choose an online account.";
  }
  if (plan.media && app.comfyui?.engine.source !== "user-url" && app.comfyui?.engine.source !== "user-path" &&
    (app.runtime?.probes.platform !== "win32" || !app.runtime.probes.accelerators?.includes("cuda"))) {
    return "The managed picture and video tools need a supported Windows computer with an NVIDIA graphics card. Choose an existing service or leave them for later.";
  }
  if (plan.writing === "account" && (plan.harness !== "opencode" || plan.account === null)) return "Choose an account for your AI writing agent.";
  const selected = onboardingComponents(plan, app.setup?.components ?? []);
  if ((plan.media || plan.voice || plan.writing === "local") && !app.setup) return "Downloads are unavailable on this host.";
  if (plan.voice && selected.filter(c => c.engine === "voxa").length !== 2) return "Read aloud and dictation are unavailable in this installation.";
  return null;
}
