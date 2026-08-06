import type { ManifestModel, ModelManifest } from "./manifest.js";
import { PROVIDERS } from "./provider.js";
import type { LocalRuntimeModel, LocalRuntimeStatus, RuntimeProbes } from "./settings.js";

/**
 * Gate the manifest's local models against measured machine figures (SPEC-008 §2.8, R-22).
 * Pure: probing is the platform's business (@arke-studio/providers); the judgement is shared.
 * A failed probe means unknown, never unavailable (D12).
 */

const gb = (mb: number): string => `${Math.round(mb / 1024)} GB`;

/** The one cloud alternative worth naming, when the same capability has a cloud model. */
function cloudAlternative(manifest: ModelManifest, model: ManifestModel): string | undefined {
  const cloud = manifest.models.find((m) => m.capability === model.capability && !PROVIDERS[m.provider].local);
  if (!cloud) return undefined;
  return `Cloud ${model.capability} still works via ${PROVIDERS[cloud.provider].displayName}.`;
}

export function gateLocalRuntimes(
  manifest: ModelManifest,
  probes: RuntimeProbes,
  detectedAt: string,
): LocalRuntimeStatus {
  const models: LocalRuntimeModel[] = [];
  for (const model of manifest.models) {
    if (!PROVIDERS[model.provider].local) continue;
    const req = model.requires ?? {};
    const checks: Array<{ need: number | undefined; have: number | null; what: string }> = [
      { need: req.vramMb, have: probes.vramMb, what: "VRAM" },
      { need: req.memMb, have: probes.memMb, what: "memory" },
      { need: req.diskMb, have: probes.diskFreeMb, what: "free disk" },
    ];
    const alt = cloudAlternative(manifest, model);
    let state: LocalRuntimeModel["state"] = "ready";
    let reason: string | undefined;
    for (const c of checks) {
      if (c.need === undefined) continue;
      if (c.have === null) {
        // The probe failed → unknown beats a false "disabled" (D12), unless a later check disables.
        if (state === "ready") {
          state = "unknown";
          reason = `${c.what} could not be measured on this machine`;
        }
        continue;
      }
      if (c.have < c.need) {
        state = "disabled";
        reason = `Needs ${gb(c.need)} ${c.what}. This machine has ${gb(c.have)}.${alt ? ` ${alt}` : ""}`;
        break;
      }
    }
    models.push({
      modelId: model.id,
      provider: model.provider,
      displayName: model.displayName,
      capability: model.capability,
      state,
      ...(reason !== undefined ? { reason } : {}),
      ...(state === "disabled" && alt !== undefined ? { cloudAlternative: alt } : {}),
    });
  }
  return { probes, detectedAt, models };
}
