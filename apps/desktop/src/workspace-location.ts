import { readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { AppSettingsSchema, NEW_ONBOARDING, type OnboardingPlan } from "@arke-studio/contracts";
import { atomicWriteFile } from "@arke-studio/coordinator";

/** Desktop boot preference only. World files and application settings stay in their workspace. */
export function workspaceRoot(preferenceFile: string, fallback: string, override?: string): string {
  if (override) return resolve(override);
  try {
    const value = JSON.parse(readFileSync(preferenceFile, "utf8")) as { path?: unknown };
    if (typeof value.path !== "string" || !isAbsolute(value.path)) throw new Error("The saved Arke folder is invalid.");
    return value.path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

/** Never move an existing library or overwrite another workspace's settings. */
export async function prepareWorkspace(path: string, plan: OnboardingPlan): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Choose an absolute folder path.");
  await mkdir(path, { recursive: true });
  const entries = await readdir(path);
  if (entries.includes("world.json")) throw new Error("This is a world folder. Choose a folder for your whole Arke library instead.");
  const settingsFile = join(path, "settings.json");
  try {
    AppSettingsSchema.parse(JSON.parse(await readFile(settingsFile, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (entries.length) throw new Error("Choose an empty folder or an existing Arke library with settings.json.");
    const file = await open(settingsFile, "wx");
    try {
      // Account connections and engine paths are specific to the original workspace.
      const next = AppSettingsSchema.parse({ onboarding: { ...NEW_ONBOARDING, persona: plan.persona, step: plan.persona === "lightweight" ? "lightweight" : "check" } });
      await file.writeFile(JSON.stringify(next, null, 2) + "\n"); await file.sync();
    } finally { await file.close(); }
  }
  await mkdir(join(path, "worlds"), { recursive: true });
}

export async function rememberWorkspace(preferenceFile: string, path: string): Promise<void> {
  await atomicWriteFile(preferenceFile, JSON.stringify({ path }, null, 2) + "\n");
}
