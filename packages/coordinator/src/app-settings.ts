import { readFile } from "node:fs/promises";
import {
  AppSettingsSchema,
  newId,
  type AppSettings,
  type BackgroundNotificationPreference,
  type BenchRecipe,
  type Capability,
  type ComfyUiSettings,
  type ModelManifest,
  type RoutingFault,
  type ThemePreference,
  type NarratorSettings,
  type VoxaSettings,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "./world/atomic.js";

/**
 * App-level settings at `%APP_ROOT%\settings.json` (SPEC-008 §2.7): routing defaults that
 * resolve to concrete models (R-20, D1) and the spend threshold (R-19). Defaults resolve on
 * change, not on read — a routing write is validated against the manifest then; a model that
 * later leaves the manifest surfaces as a fault in Settings, not a failure at dispatch.
 */
export class AppSettingsFile {
  private cache: AppSettings | null = null;

  constructor(private readonly path: string) {}

  async load(): Promise<AppSettings> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf8");
      this.cache = AppSettingsSchema.parse(JSON.parse(raw));
    } catch {
      this.cache = AppSettingsSchema.parse({});
    }
    return this.cache;
  }

  private async persist(settings: AppSettings): Promise<void> {
    await atomicWriteFile(this.path, JSON.stringify(settings, null, 2) + "\n");
    this.cache = settings;
  }

  /** Set a routing default (R-20): refused unless the model exists and matches the capability. */
  async setRoutingDefault(
    capability: Capability,
    modelId: string,
    manifest: ModelManifest,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const model = manifest.models.find((m) => m.id === modelId);
    if (!model) return { ok: false, reason: `"${modelId}" is not in the model manifest` };
    if (model.capability !== capability) {
      return { ok: false, reason: `${model.displayName} is a ${model.capability} model, not ${capability}` };
    }
    const current = await this.load();
    if (current.models.disabled.includes(modelId)) {
      return { ok: false, reason: `${model.displayName} is switched off in Providers` };
    }
    await this.persist({ ...current, routing: { ...current.routing, [capability]: modelId } });
    return { ok: true };
  }

  /**
   * Offer a model, or stop offering it. Switching one off never edits routing: a default left
   * pointing at it becomes a named fault instead, because choosing the replacement is a decision
   * and re-routing on someone's behalf makes it silently.
   */
  async setModelEnabled(modelId: string, enabled: boolean): Promise<AppSettings> {
    const current = await this.load();
    const disabled = new Set(current.models.disabled);
    if (enabled) disabled.delete(modelId);
    else disabled.add(modelId);
    const next: AppSettings = { ...current, models: { disabled: [...disabled].sort() } };
    await this.persist(next);
    return next;
  }

  /**
   * Set or clear one agent's overrides. A null clears that half back to the shipped default;
   * an agent left with nothing is dropped from settings entirely, so "as shipped" is the
   * absence of a record rather than a record that happens to be empty.
   */
  async setAgent(
    agent: string,
    patch: { model?: string | null; brief?: string | null },
  ): Promise<AppSettings> {
    const current = await this.load();
    const existing = current.agents[agent] ?? {};
    const next: { model?: string; brief?: string } = { ...existing };
    if (patch.model !== undefined) {
      if (patch.model === null) delete next.model;
      else next.model = patch.model;
    }
    if (patch.brief !== undefined) {
      if (patch.brief === null) delete next.brief;
      else next.brief = patch.brief;
    }
    const agents = { ...current.agents };
    if (next.model === undefined && next.brief === undefined) delete agents[agent];
    else agents[agent] = next;
    const settings: AppSettings = { ...current, agents };
    await this.persist(settings);
    return settings;
  }

  async setSpend(thresholdMicroUsd: number, periodDays: number): Promise<AppSettings> {
    const current = await this.load();
    const next: AppSettings = { ...current, spend: { thresholdMicroUsd, periodDays } };
    await this.persist(next);
    return next;
  }

  async setBackgroundNotifications(preference: BackgroundNotificationPreference): Promise<AppSettings> {
    const current = await this.load();
    const next: AppSettings = { ...current, backgroundNotifications: preference };
    await this.persist(next);
    return next;
  }

  async setAppearanceTheme(theme: ThemePreference): Promise<AppSettings> {
    const current = await this.load();
    const next: AppSettings = { ...current, appearance: { theme } };
    await this.persist(next);
    return next;
  }

  /** Who reads the app's prose aloud; null returns to the shipped local voice. */
  async setNarrator(voice: NarratorSettings): Promise<AppSettings> {
    const current = await this.load();
    const next: AppSettings = { ...current, narrator: voice };
    await this.persist(next);
    return next;
  }

  async setVoxa(patch: Partial<VoxaSettings>): Promise<AppSettings> {
    const current = await this.load();
    const next: AppSettings = { ...current, voxa: { ...current.voxa, ...patch } };
    await this.persist(next);
    return next;
  }

  /** Where the ComfyUI engine is (SPEC-021 §2.2), patched the same way voxa's block is. */
  async setComfyUi(patch: Partial<ComfyUiSettings>): Promise<AppSettings> {
    const current = await this.load();
    const next: AppSettings = { ...current, comfyui: { ...current.comfyui, ...patch } };
    await this.persist(next);
    return next;
  }

  /**
   * Save a bench setup (issue 305 §3): validated against the manifest the way a routing
   * default is — the model must exist and match the mode. Saving under an existing name
   * replaces that recipe: "update" and "save as" are one gesture with one spelling. App-level
   * on purpose: what makes a good setup is the model's, not any one world's.
   */
  async saveRecipe(
    input: Omit<BenchRecipe, "id" | "createdAt">,
    manifest: ModelManifest,
    now: string,
  ): Promise<{ ok: true; settings: AppSettings; recipe: BenchRecipe } | { ok: false; reason: string }> {
    const model = manifest.models.find((m) => m.id === input.model && m.provider === input.provider);
    if (!model) return { ok: false, reason: `"${input.model}" is not in the model manifest` };
    if (model.capability !== input.mode) {
      return { ok: false, reason: `${model.displayName} is a ${model.capability} model, not ${input.mode}` };
    }
    if (input.params.kind !== input.mode) {
      return { ok: false, reason: "the recipe's controls do not match its mode" };
    }
    const current = await this.load();
    const existing = current.recipes.find((r) => r.name === input.name);
    const recipe: BenchRecipe = {
      id: (existing?.id ?? newId("rcp")) as BenchRecipe["id"],
      createdAt: existing?.createdAt ?? now,
      ...input,
    };
    const recipes = existing
      ? current.recipes.map((r) => (r.id === existing.id ? recipe : r))
      : [...current.recipes, recipe];
    const settings: AppSettings = { ...current, recipes };
    await this.persist(settings);
    return { ok: true, settings, recipe };
  }

  async deleteRecipe(recipeId: string): Promise<AppSettings> {
    const current = await this.load();
    const settings: AppSettings = { ...current, recipes: current.recipes.filter((r) => r.id !== recipeId) };
    await this.persist(settings);
    return settings;
  }
}

/**
 * Defaults that cannot run — the model left the manifest, or it is switched off in Providers.
 * Both are stated rather than repaired: a default that cannot run is shown as a fault, never
 * swapped for something else on the user's behalf (§2.7).
 */
export function routingFaults(settings: AppSettings, manifest: ModelManifest): RoutingFault[] {
  const faults: RoutingFault[] = [];
  const disabled = new Set(settings.models.disabled);
  for (const [capability, modelId] of Object.entries(settings.routing) as Array<[Capability, string]>) {
    const model = manifest.models.find((m) => m.id === modelId);
    if (!model) {
      faults.push({
        capability,
        modelId,
        reason: `the routed model "${modelId}" is no longer in the manifest (v${manifest.manifestVersion}) — pick a new default`,
      });
    } else if (disabled.has(modelId)) {
      faults.push({
        capability,
        modelId,
        reason: `${model.displayName} is routed here but switched off in Providers — pick another model, or turn it back on`,
      });
    }
  }
  return faults;
}

/** The models this studio currently offers: everything in the manifest bar the switched-off. */
export function availableModels(settings: AppSettings, manifest: ModelManifest): ModelManifest["models"] {
  const disabled = new Set(settings.models.disabled);
  return manifest.models.filter((model) => !disabled.has(model.id));
}
