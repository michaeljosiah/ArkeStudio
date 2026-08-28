import { readFile } from "node:fs/promises";
import {
  AppSettingsSchema,
  newId,
  type AppSettings,
  type BackgroundNotificationPreference,
  type BenchPreset,
  type Capability,
  type ComfyUiSettings,
  type HarnessEngine,
  type ModelManifest,
  type RoutingFault,
  type ThemePreference,
  type NarratorSettings,
  type VoxaSettings,
} from "@arke-studio/contracts";
import { atomicWriteFile, serializeFileMutation } from "./world/atomic.js";

interface SettingsMutation<T> {
  settings?: AppSettings;
  value: T;
}

/**
 * App-level settings at `%APP_ROOT%\settings.json` (SPEC-008 §2.7): routing defaults that
 * resolve to concrete models (R-20, D1) and the spend threshold (R-19). Defaults resolve on
 * change, not on read — a routing write is validated against the manifest then; a model that
 * later leaves the manifest surfaces as a fault in Settings, not a failure at dispatch.
 */
/**
 * Put back what SPEC-033 R-66 parked, and delete what nothing can replace (SPEC-034 R-18).
 *
 * R-66 moved local capability defaults out of `routing` because Cloud AI was cloud-only and
 * could neither show nor change them — the worst of the three outcomes being a setting still in
 * force and invisible. R-15 makes them reachable on the screen that sets them, so the condition
 * is discharged and the move is undone. The record kept the concrete model id precisely so it
 * could be read back, which is what this does: each entry returns as the default the person
 * originally chose, and an entry already in `routing` wins, being the later decision.
 *
 * Every `llm` entry goes instead, parked or active. R-17 removes its picker, so restoring one
 * would put back a setting nothing reads and nothing can replace — and `routingFaults` iterates
 * every persisted entry, so it could then raise a fault General offers no control to answer. The
 * active one is the likelier of the two: `setRoutingDefault` accepted `llm` before this, so an
 * ordinary installation holds `routing.llm` without ever having had a local default parked.
 */
function migrateClearedLocalRouting(settings: AppSettings): AppSettings {
  const routing: Record<string, string> = { ...settings.clearedLocalRouting, ...settings.routing };
  delete routing["llm"];
  const unchanged =
    Object.keys(settings.clearedLocalRouting).length === 0 &&
    Object.keys(routing).length === Object.keys(settings.routing).length;
  if (unchanged) return settings;
  return { ...settings, routing: routing as AppSettings["routing"], clearedLocalRouting: {} };
}

export class AppSettingsFile {
  constructor(private readonly path: string) {}

  async load(): Promise<AppSettings> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return AppSettingsSchema.parse({});
      throw err;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      throw new Error(`settings file "${this.path}" contains malformed JSON`, { cause: err });
    }
    const parsed = AppSettingsSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `settings file "${this.path}" does not match the current schema: ${parsed.error.message}`,
        {
          cause: parsed.error,
        },
      );
    }
    return migrateClearedLocalRouting(parsed.data);
  }

  private async persist(settings: AppSettings): Promise<void> {
    await atomicWriteFile(this.path, JSON.stringify(settings, null, 2) + "\n");
  }

  private async mutate<T>(change: (current: AppSettings) => SettingsMutation<T>): Promise<T> {
    return serializeFileMutation(this.path, async () => {
      const current = await this.load();
      const result = change(current);
      if (result.settings) await this.persist(result.settings);
      return result.value;
    });
  }

  /**
   * Set a routing default (SPEC-008 R-20): refused unless the model exists, matches the
   * capability, and can actually run.
   *
   * A default is a concrete model, local or cloud — SPEC-034 R-15 removes the cloud-only filter
   * SPEC-033 R-61 imposed. What replaces it is R-15a: **eligibility, supplied**. The filter was
   * adequate while every option was a cloud model whose only failure mode was a missing key; a
   * local one can fail on a runtime that never started, which this function cannot see and
   * `routingFaults` cannot see either. So the caller hands in SPEC-028 R-35's answer rather than
   * either of us guessing at it, and a picker that merely disables the option stays a courtesy
   * rather than the guarantee.
   */
  async setRoutingDefault(
    capability: Capability,
    modelId: string,
    manifest: ModelManifest,
    /** Whether the model can run right now. Absent means nobody asked, which is a refusal. */
    eligible: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const model = manifest.models.find((m) => m.id === modelId);
    if (!model) return { ok: false, reason: `"${modelId}" is not in the model manifest` };
    if (model.capability !== capability) {
      return { ok: false, reason: `${model.displayName} is a ${model.capability} model, not ${capability}` };
    }
    if (!eligible) {
      return { ok: false, reason: `${model.displayName} cannot run right now — it cannot be the default` };
    }
    return this.mutate<{ ok: true } | { ok: false; reason: string }>((current) => {
      if (current.models.disabled.includes(modelId)) {
        return { value: { ok: false, reason: `${model.displayName} is switched off in Providers` } };
      }
      return {
        settings: { ...current, routing: { ...current.routing, [capability]: modelId } },
        value: { ok: true },
      };
    });
  }



  /**
   * Offer a model, or stop offering it. Switching one off never edits routing: a default left
   * pointing at it becomes a named fault instead, because choosing the replacement is a decision
   * and re-routing on someone's behalf makes it silently.
   */
  /** Whether a conversation may read a page online. Off until the author says otherwise. */
  async setResearchWeb(enabled: boolean): Promise<AppSettings> {
    return this.mutate((current) => {
      const settings: AppSettings = { ...current, research: { web: enabled } };
      return { settings, value: settings };
    });
  }

  async setModelEnabled(modelId: string, enabled: boolean): Promise<AppSettings> {
    return this.mutate((current) => {
      const disabled = new Set(current.models.disabled);
      if (enabled) disabled.delete(modelId);
      else disabled.add(modelId);
      const settings: AppSettings = { ...current, models: { disabled: [...disabled].sort() } };
      return { settings, value: settings };
    });
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
    return this.mutate((current) => {
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
      return { settings, value: settings };
    });
  }

  async setSpend(thresholdMicroUsd: number, periodDays: number): Promise<AppSettings> {
    return this.mutate((current) => {
      const settings: AppSettings = { ...current, spend: { thresholdMicroUsd, periodDays } };
      return { settings, value: settings };
    });
  }

  async setBackgroundNotifications(preference: BackgroundNotificationPreference): Promise<AppSettings> {
    return this.mutate((current) => {
      const settings: AppSettings = { ...current, backgroundNotifications: preference };
      return { settings, value: settings };
    });
  }

  /**
   * Which engine runs authoring work. The caller checks availability first — this only records
   * the choice, and a harness that vanishes later is caught at launch rather than here.
   */
  async setHarnessEngine(engine: HarnessEngine): Promise<AppSettings> {
    return this.mutate((current) => {
      const settings: AppSettings = { ...current, harness: { ...current.harness, engine } };
      return { settings, value: settings };
    });
  }

  /** The chosen Claude Code executable, or null to go back to whatever PATH offers. */
  async setClaudePath(claudePath: string | null): Promise<AppSettings> {
    return this.mutate((current) => {
      const settings: AppSettings = { ...current, harness: { ...current.harness, claudePath } };
      return { settings, value: settings };
    });
  }

  async setAppearanceTheme(theme: ThemePreference): Promise<AppSettings> {
    return this.mutate((current) => {
      const settings: AppSettings = { ...current, appearance: { theme } };
      return { settings, value: settings };
    });
  }

  /** Who reads the app's prose aloud; null returns to the shipped local voice. */
  async setNarrator(voice: NarratorSettings): Promise<AppSettings> {
    return this.mutate((current) => {
      const settings: AppSettings = { ...current, narrator: voice };
      return { settings, value: settings };
    });
  }

  async setVoxa(patch: Partial<VoxaSettings>): Promise<AppSettings> {
    return this.mutate((current) => {
      const settings: AppSettings = { ...current, voxa: { ...current.voxa, ...patch } };
      return { settings, value: settings };
    });
  }

  /** Where the ComfyUI engine is (SPEC-021 §2.2), patched the same way voxa's block is. */
  async setComfyUi(patch: Partial<ComfyUiSettings>): Promise<AppSettings> {
    return this.mutate((current) => {
      const settings: AppSettings = { ...current, comfyui: { ...current.comfyui, ...patch } };
      return { settings, value: settings };
    });
  }

  /**
   * Save a bench setup (issue 305 §3): validated against the manifest the way a routing
   * default is — the model must exist and match the mode. Saving under an existing name
   * replaces that preset: "update" and "save as" are one gesture with one spelling. App-level
   * on purpose: what makes a good setup is the model's, not any one world's.
   */
  async savePreset(
    input: Omit<BenchPreset, "id" | "createdAt">,
    manifest: ModelManifest,
    now: string,
  ): Promise<{ ok: true; settings: AppSettings; preset: BenchPreset } | { ok: false; reason: string }> {
    const model = manifest.models.find((m) => m.id === input.model && m.provider === input.provider);
    if (!model) return { ok: false, reason: `"${input.model}" is not in the model manifest` };
    if (model.capability !== input.mode) {
      return { ok: false, reason: `${model.displayName} is a ${model.capability} model, not ${input.mode}` };
    }
    if (input.params.kind !== input.mode) {
      return { ok: false, reason: "the preset's controls do not match its mode" };
    }
    return this.mutate((current) => {
      const existing = current.presets.find((p) => p.name === input.name);
      const preset: BenchPreset = {
        // The stored id prefix stays "rcp" — it is on disk in every settings file already.
        id: (existing?.id ?? newId("rcp")) as BenchPreset["id"],
        createdAt: existing?.createdAt ?? now,
        ...input,
      };
      const presets = existing
        ? current.presets.map((p) => (p.id === existing.id ? preset : p))
        : [...current.presets, preset];
      const settings: AppSettings = { ...current, presets };
      return { settings, value: { ok: true as const, settings, preset } };
    });
  }

  async deletePreset(presetId: string): Promise<AppSettings> {
    return this.mutate((current) => {
      const settings: AppSettings = { ...current, presets: current.presets.filter((p) => p.id !== presetId) };
      return { settings, value: settings };
    });
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
  // A local model in `routing` used to be a fault in itself: SPEC-033 R-61 kept them off the
  // screen, so one surviving here meant R-66's move had failed and the setting was in force,
  // invisible and unchangeable. SPEC-034 R-15 makes it an ordinary default — General lists both
  // halves — so the loop that flagged it went, and with it a warning that would otherwise have
  // fired on this feature's own success path, above the row that had just accepted the choice.
  //
  // What a local default can still be is *stranded*, and that is the same two faults above: its
  // model left the manifest, or somebody switched it off. A runtime that never started is
  // neither, and is not visible from here — which is why R-15a puts the eligibility guard on the
  // write rather than expecting this function to grow one.
  return faults;
}

/** The models this studio currently offers: everything in the manifest bar the switched-off. */
export function availableModels(settings: AppSettings, manifest: ModelManifest): ModelManifest["models"] {
  const disabled = new Set(settings.models.disabled);
  return manifest.models.filter((model) => !disabled.has(model.id));
}
