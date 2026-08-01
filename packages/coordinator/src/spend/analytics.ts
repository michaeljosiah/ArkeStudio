import {
  sumMicroUsd,
  type LedgerEntry,
  type ManifestDrift,
  type ModelManifest,
  type SpendSettings,
  type SpendStatus,
} from "@arke-studio/contracts";

/**
 * Spend analytics over the ledger (SPEC-008 R-19, R-13): the rolling threshold evaluated on
 * every append, across all worlds, and manifest drift measured from estimate-versus-actual
 * divergence. Pure functions — the ledger is the input, never a database handle.
 */

/** Spend inside the rolling window: actual where recorded, estimate otherwise. */
export function rollingSpend(entries: LedgerEntry[], settings: SpendSettings, now: Date): number {
  const cutoff = now.getTime() - settings.periodDays * 24 * 60 * 60 * 1000;
  return sumMicroUsd(
    entries
      .filter((e) => Date.parse(e.ts) >= cutoff)
      .map((e) => e.actualMicroUsd ?? e.estimatedMicroUsd),
  );
}

/** The status the client renders; alerts and never blocks (R-19, D10). */
export function evaluateSpend(entries: LedgerEntry[], settings: SpendSettings, now: Date): SpendStatus {
  const rollingMicroUsd = rollingSpend(entries, settings, now);
  return {
    settings,
    rollingMicroUsd,
    alerted: settings.thresholdMicroUsd > 0 && rollingMicroUsd >= settings.thresholdMicroUsd,
  };
}

/** Divergence beyond this per-mille of the estimate, over this many samples, is drift (§2.11). */
export const DRIFT_PER_MILLE = 150;
export const DRIFT_MIN_SAMPLES = 3;

/**
 * Manifest drift (R-13): only provider-reported actuals count — a manifest-derived actual
 * diverging from a manifest-derived estimate would only measure our own arithmetic.
 */
export function detectDrift(entries: LedgerEntry[], manifest: ModelManifest): ManifestDrift[] {
  const byModel = new Map<string, number[]>();
  for (const e of entries) {
    if (e.actualSource !== "provider-reported" || e.actualMicroUsd === null) continue;
    if (e.estimatedMicroUsd <= 0) continue;
    const perMille = Math.round((Math.abs(e.actualMicroUsd - e.estimatedMicroUsd) * 1000) / e.estimatedMicroUsd);
    const list = byModel.get(e.model) ?? [];
    list.push(perMille);
    byModel.set(e.model, list);
  }
  const reports: ManifestDrift[] = [];
  for (const [modelId, divergences] of byModel) {
    if (divergences.length < DRIFT_MIN_SAMPLES) continue;
    const sorted = [...divergences].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    if (median <= DRIFT_PER_MILLE) continue;
    const model = manifest.models.find((m) => m.id === modelId);
    if (!model) continue; // a retired model is a routing fault, not drift
    reports.push({
      modelId,
      provider: model.provider,
      samples: divergences.length,
      medianDivergencePerMille: median,
    });
  }
  return reports.sort((a, b) => b.medianDivergencePerMille - a.medianDivergencePerMille);
}
