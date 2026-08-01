import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AppSettingsSchema,
  type AppSettings,
  type Capability,
  type ModelManifest,
  type RoutingFault,
} from "@arke-studio/contracts";

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
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.tmp-settings-${process.pid}`);
    await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
    await rename(tmp, this.path);
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
    await this.persist({ ...current, routing: { ...current.routing, [capability]: modelId } });
    return { ok: true };
  }

  async setSpend(thresholdMicroUsd: number, periodDays: number): Promise<AppSettings> {
    const current = await this.load();
    const next: AppSettings = { ...current, spend: { thresholdMicroUsd, periodDays } };
    await this.persist(next);
    return next;
  }
}

/** Defaults whose model has left the manifest — a Settings fault, named (§2.7). */
export function routingFaults(settings: AppSettings, manifest: ModelManifest): RoutingFault[] {
  const faults: RoutingFault[] = [];
  for (const [capability, modelId] of Object.entries(settings.routing) as Array<[Capability, string]>) {
    if (!manifest.models.some((m) => m.id === modelId)) {
      faults.push({
        capability,
        modelId,
        reason: `the routed model "${modelId}" is no longer in the manifest (v${manifest.manifestVersion}) — pick a new default`,
      });
    }
  }
  return faults;
}
