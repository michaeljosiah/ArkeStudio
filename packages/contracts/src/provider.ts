import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";

/**
 * Providers, capabilities and their availability (SPEC-008 §2.1, §2.2). Three layers: a
 * provider is a credential and an endpoint, a capability is a kind of work, a model is a
 * concrete dispatch target. Routing stores models; providers are how they are displayed.
 */

export const CapabilitySchema = z.enum(["image", "video", "llm", "voice-tts", "voice-clone", "voice-stt"]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ProviderIdSchema = z.enum([
  "fal",
  "higgsfield",
  "openai",
  "anthropic",
  "elevenlabs",
  "ollama",
  "kokoro",
  "whispercpp",
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export interface ProviderInfo {
  displayName: string;
  capabilities: Capability[];
  /** Local runtimes take no key and are unmetered (R-18). */
  local: boolean;
  /** How the key is entered — a hint for the Settings form, not a behaviour switch. */
  keyHint?: string;
}

/** The provider table (§2.2). Gateways and direct providers differ only in the manifest. */
export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  fal: { displayName: "FAL", capabilities: ["image", "video"], local: false, keyHint: "key id:secret" },
  higgsfield: { displayName: "Higgsfield", capabilities: ["image", "video"], local: false },
  openai: { displayName: "OpenAI", capabilities: ["llm", "image"], local: false, keyHint: "sk-…" },
  anthropic: { displayName: "Anthropic", capabilities: ["llm"], local: false, keyHint: "sk-ant-…" },
  elevenlabs: { displayName: "ElevenLabs", capabilities: ["voice-tts", "voice-clone"], local: false },
  ollama: { displayName: "Ollama", capabilities: ["llm"], local: true },
  kokoro: { displayName: "Kokoro", capabilities: ["voice-tts"], local: true },
  whispercpp: { displayName: "whisper.cpp", capabilities: ["voice-stt"], local: true },
};

/**
 * What a validation probe found for one capability (R-3): not whether the key authenticates,
 * but whether it actually unlocks this work.
 */
export const CapabilityProbeSchema = z
  .object({
    capability: CapabilitySchema,
    available: z.boolean(),
    /** Why not, in provider terms: "no video access on this plan", "out of credit" … */
    reason: z.string().optional(),
  })
  .strict();
export type CapabilityProbe = z.infer<typeof CapabilityProbeSchema>;

export const ProviderValidationSchema = z.enum(["untested", "testing", "valid", "invalid"]);

/** One provider as Settings renders it. Never carries key material (R-6). */
export const ProviderStatusSchema = z
  .object({
    id: ProviderIdSchema,
    /** A credential is stored (or the runtime is local and needs none). */
    configured: z.boolean(),
    validation: ProviderValidationSchema,
    /** Per-capability probe results from the last validation (R-3). */
    probes: z.array(CapabilityProbeSchema),
    lastValidated: IsoDateTimeSchema.optional(),
    /** A mid-session credential failure — a provider fault, never a work failure (R-4). */
    fault: z.string().nullable(),
  })
  .strict();
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

/**
 * Capability availability, derived from configured and validated providers (R-2). A capability
 * with no provider is present with its reason, never silently absent.
 */
export const CapabilityAvailabilitySchema = z
  .object({
    capability: CapabilitySchema,
    available: z.boolean(),
    /** Providers that currently unlock it. */
    via: z.array(ProviderIdSchema),
    reason: z.string().optional(),
  })
  .strict();
export type CapabilityAvailability = z.infer<typeof CapabilityAvailabilitySchema>;

// ---------------------------------------------------------------------------
// The provider client declarations (R-23, D8)
// ---------------------------------------------------------------------------

/**
 * What a provider can tell us about an interrupted submission, and whether it reports cost.
 * SPEC-009 selects its reconciliation strategy from these — data, never a per-provider branch.
 */
export const ClientDeclarationsSchema = z
  .object({
    supportsIdempotencyKey: z.boolean(),
    supportsLookupByKey: z.boolean(),
    supportsListRecent: z.boolean(),
    /** Whether a completed job reports a real charge; otherwise the ledger actual is derived (R-17). */
    reportsCost: z.boolean(),
  })
  .strict();
export type ClientDeclarations = z.infer<typeof ClientDeclarationsSchema>;

export type ReconcileStrategy = "by-idempotency-key" | "list-recent" | "ask-user";

/**
 * Derive capability availability from provider statuses (R-2): a capability nobody unlocks is
 * reported with its reason — no provider configured, or configured but the probes said no.
 */
export function deriveCapabilityAvailability(statuses: ProviderStatus[]): CapabilityAvailability[] {
  return CapabilitySchema.options.map((capability) => {
    const via: ProviderId[] = [];
    let configuredSomewhere = false;
    for (const status of statuses) {
      if (!PROVIDERS[status.id].capabilities.includes(capability)) continue;
      if (status.configured) configuredSomewhere = true;
      const probe = status.probes.find((p) => p.capability === capability);
      const unlocked =
        status.configured &&
        status.fault === null &&
        (status.validation === "valid" ? (probe?.available ?? false) : status.validation === "untested");
      if (unlocked) via.push(status.id);
    }
    if (via.length > 0) return { capability, available: true, via };
    return {
      capability,
      available: false,
      via,
      reason: configuredSomewhere
        ? `no configured provider's key unlocks ${capability}`
        : `no provider is configured for ${capability}`,
    };
  });
}

/**
 * The strategy selection SPEC-009 depends on (R-23): pure data → decision, no provider names.
 * A provider declaring nothing leaves the honest option — ask the user, stating the cost of a
 * possible duplicate.
 */
export function reconcileStrategy(decl: ClientDeclarations): ReconcileStrategy {
  if (decl.supportsIdempotencyKey && decl.supportsLookupByKey) return "by-idempotency-key";
  if (decl.supportsListRecent) return "list-recent";
  return "ask-user";
}
