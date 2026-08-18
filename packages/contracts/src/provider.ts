import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import type { ReferenceKind } from "./reference-budget.js";

/**
 * Providers, capabilities and their availability (SPEC-008 §2.1, §2.2). Three layers: a
 * provider is a credential and an endpoint, a capability is a kind of work, a model is a
 * concrete dispatch target. Routing stores models; providers are how they are displayed.
 */

/**
 * `music` is generated audio the studio owns as its own track — a score bed, or the song a music
 * video is cut against. It is deliberately not a kind of `voice-tts`: speech is generated per line
 * against a character's assigned voice, and music is generated once per production and placed on a
 * timeline. They share a file format and nothing else.
 *
 * It is also the opposite of `AudioPolicy.music` (art-direction.ts), which is a *negative* — it
 * tells a video model not to score a clip, because a video model returns one mixed track that can
 * never be separated afterwards. A track generated here is separable by construction, which is
 * what makes it something the cut can place, duck and replace.
 */
export const CapabilitySchema = z.enum([
  "image",
  "video",
  "music",
  "llm",
  "voice-tts",
  "voice-clone",
  "voice-stt",
]);
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
  "comfyui",
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/**
 * Where a provider's credential lives. This is separate from `local` because the two came
 * apart: Higgsfield authenticates through its own CLI, so nothing of ours is stored for it,
 * yet its work is billed like any other gateway's. Reading "takes no key" off `local` would
 * have recorded every Higgsfield job at zero (R-18 is about local runtimes, not about us
 * not holding the secret).
 */
export type CredentialKind =
  /** Ours to store, validate and replace — `credentials.dat` (R-5). */
  | "in-app"
  /** Held by a tool we drive, never copied here; presence is a probe, not a file read. */
  | "external"
  /** A runtime that authenticates nothing. */
  | "none";

export interface ProviderInfo {
  displayName: string;
  capabilities: Capability[];
  /** Runs on this machine: unmetered (R-18), and the only kind a runtime gate withholds (R-22). */
  local: boolean;
  credential: CredentialKind;
  /** How the key is entered — a hint for the Settings form, not a behaviour switch. */
  keyHint?: string;
  /**
   * Which reference kinds this provider's transport actually carries to the wire (issue 305
   * §5.2). A kind a model's limits admit but the transport does not map is refused BEFORE
   * enqueue — declaring an audio allowance without a mapped payload path would accept a file
   * and then silently not send it, which is the failure the whole budget exists to prevent.
   * Absent means images only, which is what every existing client transport implements.
   */
  mapsReferenceKinds?: ReferenceKind[];
}

/** The provider table (§2.2). Gateways and direct providers differ only in the manifest. */
export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  fal: {
    displayName: "FAL",
    capabilities: ["image", "video", "music"],
    local: false,
    credential: "in-app",
    keyHint: "key id:secret",
  },
  higgsfield: { displayName: "Higgsfield", capabilities: ["image", "video"], local: false, credential: "external" },
  openai: {
    displayName: "OpenAI",
    capabilities: ["llm", "image"],
    local: false,
    credential: "in-app",
    keyHint: "sk-…",
  },
  anthropic: {
    displayName: "Anthropic",
    capabilities: ["llm"],
    local: false,
    credential: "in-app",
    keyHint: "sk-ant-…",
  },
  elevenlabs: {
    displayName: "ElevenLabs",
    capabilities: ["voice-tts", "voice-clone"],
    local: false,
    credential: "in-app",
  },
  ollama: { displayName: "Ollama", capabilities: ["llm"], local: true, credential: "none" },
  kokoro: { displayName: "Kokoro", capabilities: ["voice-tts"], local: true, credential: "none" },
  whispercpp: { displayName: "whisper.cpp", capabilities: ["voice-stt"], local: true, credential: "none" },
  /**
   * The engine behind the local recipe catalogue (SPEC-021). Never exposed as an interface —
   * the dispatchable unit is an Arke-authored recipe, and this row is what puts those recipes
   * in the same picker, queue and ledger as every cloud model.
   */
  comfyui: { displayName: "ComfyUI", capabilities: ["image", "video"], local: true, credential: "none" },
};

/**
 * Where this provider's credential lives, tolerating the bare string a journalled job carries.
 * An unknown provider is assumed to want a key of ours: that withholds dispatch until somebody
 * looks, where assuming "none" would quietly send work to a provider nobody authenticated.
 */
export function credentialKindOf(provider: string): CredentialKind {
  return (PROVIDERS as Record<string, ProviderInfo | undefined>)[provider]?.credential ?? "in-app";
}

/**
 * The reference kinds a provider's transport maps, for the gate before enqueue. An unknown
 * provider maps nothing: refusing a reference nobody can carry beats accepting one nobody sends.
 */
export function mappedReferenceKinds(provider: string): readonly ReferenceKind[] {
  const info = (PROVIDERS as Record<string, ProviderInfo | undefined>)[provider];
  if (!info) return [];
  return info.mapsReferenceKinds ?? ["image"];
}

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
// Providers whose credential lives in a tool we drive (issue #137)
// ---------------------------------------------------------------------------

/**
 * Four states, because they need four different answers. Absent is "install it"; signed-out is
 * "sign in"; ready is "nothing to do"; and signing-in is a browser window the user is standing
 * in front of, which is neither of the first two and must not read as either.
 */
export const ProviderToolStateSchema = z.enum(["absent", "signed-out", "signing-in", "ready"]);
export type ProviderToolState = z.infer<typeof ProviderToolStateSchema>;

/**
 * An account the provider can bill against. One credential can reach several, and which one
 * pays is a choice the tool holds — so it is read, shown and set, never assumed.
 *
 * `credits` is the provider's own denomination, not money. It is deliberately not converted:
 * we do not know what a credit costs on a given plan, and a figure in dollars that we invented
 * would be worse than one in the units the provider actually bills in (R-14 is about our own
 * arithmetic, not about restating someone else's).
 */
export const ProviderWorkspaceSchema = z
  .object({
    id: z.string().min(1),
    /** Null for a personal account context — a real answer, not a missing name. */
    name: z.string().min(1).nullable(),
    plan: z.string().min(1).nullable(),
    credits: z.number().nullable(),
    role: z.string().min(1).nullable(),
    selected: z.boolean(),
  })
  .strict();
export type ProviderWorkspace = z.infer<typeof ProviderWorkspaceSchema>;

/**
 * One external tool as Settings renders it. `configured` on ProviderStatus answers *whether*
 * this provider can work; this answers *why not, and what to do about it* — which for a
 * credential we do not hold is the only question the app can actually help with.
 */
export const ProviderToolStatusSchema = z
  .object({
    provider: ProviderIdSchema,
    state: ProviderToolStateSchema,
    /**
     * Every account this sign-in can bill. Empty until signed in, and often exactly one — the
     * picker only matters when it is not, but the selected one is worth showing either way,
     * because "which account paid for that" should never need asking after the fact.
     */
    workspaces: z.array(ProviderWorkspaceSchema).default([]),
    /** A basename only. Absolute executable paths never cross into renderer state (R-6). */
    executableName: z.string().min(1).nullable(),
    source: z.enum(["configured", "path", "bundled"]).nullable(),
    version: z.string().min(1).nullable(),
    /** Who the tool says it is signed in as, when it says. Never a token (R-6). */
    account: z.string().min(1).nullable(),
    /** The reason, whenever the state is one that owes you one — in the tool's own words. */
    detail: z.string().min(1).nullable(),
    /**
     * What to type if the in-app sign-in cannot serve you. The command as documented, never a
     * path we resolved: this is copied into a terminal, where PATH is the user's own.
     */
    signInCommand: z.string().min(1),
  })
  .strict();
export type ProviderToolStatus = z.infer<typeof ProviderToolStatusSchema>;

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
