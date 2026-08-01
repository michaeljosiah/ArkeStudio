import { z } from "zod";
import { CapabilitySchema, ProviderIdSchema } from "./provider.js";

/**
 * App-level settings (SPEC-008 §2.7, §2.10): routing defaults that resolve to concrete models
 * (R-20, D1), and the spend threshold that alerts but never blocks (R-19, D10).
 */

/** capability → concrete model id. Displayed by provider name; stored as the model (D1). */
export const RoutingDefaultsSchema = z.record(CapabilitySchema, z.string().min(1));
export type RoutingDefaults = z.infer<typeof RoutingDefaultsSchema>;

/** A default whose model has left the manifest — a Settings fault, not a dispatch failure (§2.7). */
export const RoutingFaultSchema = z
  .object({
    capability: CapabilitySchema,
    modelId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type RoutingFault = z.infer<typeof RoutingFaultSchema>;

export const SpendSettingsSchema = z
  .object({
    /** 0 disables the alert. */
    thresholdMicroUsd: z.number().int().min(0),
    /** The rolling window the threshold is evaluated over, across all worlds (R-19). */
    periodDays: z.number().int().min(1).max(365),
  })
  .strict();
export type SpendSettings = z.infer<typeof SpendSettingsSchema>;

export const AppSettingsSchema = z
  .object({
    routing: RoutingDefaultsSchema.default({}),
    spend: SpendSettingsSchema.default({ thresholdMicroUsd: 0, periodDays: 7 }),
  })
  .strict();
export type AppSettings = z.infer<typeof AppSettingsSchema>;

/** Rolling spend as evaluated on the last ledger append (R-19). */
export const SpendStatusSchema = z
  .object({
    settings: SpendSettingsSchema,
    /** Spend inside the rolling window, all worlds, actual-where-reported. */
    rollingMicroUsd: z.number().int().min(0),
    /** True while the rolling spend sits at or over a non-zero threshold. */
    alerted: z.boolean(),
  })
  .strict();
export type SpendStatus = z.infer<typeof SpendStatusSchema>;

/** Repeated estimate/actual divergence for one model — the manifest went stale (R-13, §2.11). */
export const ManifestDriftSchema = z
  .object({
    modelId: z.string().min(1),
    provider: ProviderIdSchema,
    /** Provider-reported samples the judgement is based on. */
    samples: z.number().int().min(1),
    /** Median divergence as parts-per-thousand of the estimate, integer (R-14 discipline). */
    medianDivergencePerMille: z.number().int().min(0),
  })
  .strict();
export type ManifestDrift = z.infer<typeof ManifestDriftSchema>;

// ---------------------------------------------------------------------------
// Local runtimes (R-22, D11, D12)
// ---------------------------------------------------------------------------

/** Measured machine figures; null means the probe failed → unknown, never unavailable (D12). */
export const RuntimeProbesSchema = z
  .object({
    vramMb: z.number().int().min(0).nullable(),
    memMb: z.number().int().min(0).nullable(),
    diskFreeMb: z.number().int().min(0).nullable(),
  })
  .strict();
export type RuntimeProbes = z.infer<typeof RuntimeProbesSchema>;

export const LocalRuntimeModelSchema = z
  .object({
    modelId: z.string().min(1),
    provider: ProviderIdSchema,
    displayName: z.string().min(1),
    capability: CapabilitySchema,
    state: z.enum(["ready", "disabled", "unknown"]),
    /** The measured reason, both figures: "Needs 24 GB VRAM. This machine has 12 GB." (R-22). */
    reason: z.string().optional(),
    /** The cloud alternative worth noting, when one exists. */
    cloudAlternative: z.string().optional(),
  })
  .strict();
export type LocalRuntimeModel = z.infer<typeof LocalRuntimeModelSchema>;

export const LocalRuntimeStatusSchema = z
  .object({
    probes: RuntimeProbesSchema,
    detectedAt: z.string().min(1),
    models: z.array(LocalRuntimeModelSchema),
  })
  .strict();
export type LocalRuntimeStatus = z.infer<typeof LocalRuntimeStatusSchema>;
