import { z } from "zod";

/**
 * Provider layer skeleton (master spec §14). Implementations arrive with SPEC-008 (registry,
 * keys, manifest, ledger) and SPEC-009 (dispatch); the vocabulary and the capability
 * declaration shape are settled here so every earlier spec can reference them.
 */

export const ProviderIdSchema = z.enum(["fal", "higgsfield", "elevenlabs", "openai", "anthropic", "ollama"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/**
 * How a provider lets a `submitting` job of unknown remote state be reconciled after a crash
 * (master spec §10.1). "none" → the job parks as needs-reconciliation and the user decides.
 */
export const ReconciliationSupportSchema = z.enum(["by-idempotency-key", "list-recent", "none"]);
export type ReconciliationSupport = z.infer<typeof ReconciliationSupportSchema>;

export const ProviderCapabilitiesSchema = z
  .object({
    id: ProviderIdSchema,
    /** What the provider can produce. */
    produces: z.array(z.enum(["image", "video", "voice", "text"])),
    /** Whether requests honour a caller idempotency key. */
    idempotencyKeys: z.boolean(),
    reconciliation: ReconciliationSupportSchema,
    /** Whether completed jobs report an actual charge (§14.4). */
    reportsActualCost: z.boolean(),
    /** Local runtimes are unmetered and recorded at zero (R-PROV-6). */
    local: z.boolean(),
  })
  .strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

/** Placeholder for the SPEC-008 provider client surface; deliberately empty of behaviour. */
export interface ProviderClient {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
}
