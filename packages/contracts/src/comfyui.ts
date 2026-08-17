import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import { CapabilitySchema } from "./provider.js";

/**
 * The ComfyUI engine and its recipes (SPEC-021). Deliberately not `ProviderToolStatus`: that is
 * a sign-in contract — signed-out, signing-in, a mandatory sign-in command — and every one of
 * those states would be a lie for an engine that authenticates nothing. An engine's questions
 * are where it is, whether it answers, and whether what answers is compatible (§2.12).
 */

/** How the engine was resolved (§2.2): user direction always beats the managed copy (D5). */
export const ComfyUiEngineSourceSchema = z.enum(["user-path", "user-url", "managed", "absent"]);
export type ComfyUiEngineSource = z.infer<typeof ComfyUiEngineSourceSchema>;

/**
 * What the engine is doing. `incompatible` is deliberately not `unreachable`: an old engine
 * answers perfectly well, and reporting it as absent would send the user to check a cable
 * instead of a version (§2.6 D14).
 */
export const ComfyUiEngineStateSchema = z.enum([
  "ready",
  "starting",
  "unreachable",
  "incompatible",
  "failed",
  "absent",
]);
export type ComfyUiEngineState = z.infer<typeof ComfyUiEngineStateSchema>;

/** An install discovery found on this machine, offered in Settings — never installed over (D10). */
export const ComfyUiDetectedInstallSchema = z
  .object({
    /** As found: a directory the user can recognise, or a URL that answered. User-visible. */
    location: z.string().min(1),
    /** What `/system_stats` reported, when it was running to ask. */
    version: z.string().min(1).nullable(),
  })
  .strict();
export type ComfyUiDetectedInstall = z.infer<typeof ComfyUiDetectedInstallSchema>;

/**
 * The engine as Settings renders it (§2.2, §2.12). `location` is user-entered or loopback data
 * — a path the user typed, a URL they pasted, or `127.0.0.1:‹port›` for the managed child —
 * never a path the host resolved on its own (SPEC-001 R-9 stays intact because nothing here is
 * a discovery the renderer could not already see).
 */
export const ComfyUiEngineStatusSchema = z
  .object({
    source: ComfyUiEngineSourceSchema,
    state: ComfyUiEngineStateSchema,
    location: z.string().min(1).nullable(),
    /** `system.comfyui_version` as reported; null until an engine has answered. */
    version: z.string().min(1).nullable(),
    /**
     * Opaque digest of the resolved location — answers "same engine as before?" without saying
     * where (§2.11). Null when absent.
     */
    instanceId: z.string().min(1).nullable(),
    /** The reason, whenever the state is one that owes you one. */
    detail: z.string().min(1).nullable(),
    /** Installs detection found, for Settings to offer. Empty once one is chosen. */
    detected: z.array(ComfyUiDetectedInstallSchema),
  })
  .strict();
export type ComfyUiEngineStatus = z.infer<typeof ComfyUiEngineStatusSchema>;

// ---------------------------------------------------------------------------
// Identity frozen onto a job at enqueue (§2.11, R-15)
// ---------------------------------------------------------------------------

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Which recipe, exactly, this job was dispatched as. Frozen before enqueue and never looked up
 * again: a job that outlives an app update must execute and be recorded as what it was
 * dispatched as, and when the catalogue no longer carries this version, recovery refuses with
 * that stated rather than silently running a newer graph.
 */
export const RecipeIdentitySchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().min(1),
    /** Digest of the canonical graph template — two of these answer "same graph?" without either graph. */
    templateDigest: Sha256HexSchema,
    /** Digest over the pinned dependency set (checkpoint digests + node pins), order-independent. */
    dependencyDigest: Sha256HexSchema,
  })
  .strict();
export type RecipeIdentity = z.infer<typeof RecipeIdentitySchema>;

/**
 * Which engine this job was dispatched against. The instance id is the same opaque digest the
 * engine status carries — job rows reach the renderer, so an absolute path may not (§2.11).
 */
export const JobEngineIdentitySchema = z
  .object({
    source: z.enum(["user-path", "user-url", "managed"]),
    instanceId: z.string().min(1),
  })
  .strict();
export type JobEngineIdentity = z.infer<typeof JobEngineIdentitySchema>;

// ---------------------------------------------------------------------------
// Recipe readiness (§2.12, R-16) — one answer, consumed everywhere
// ---------------------------------------------------------------------------

/** `unknown` is a real state: the floor could not be checked, and dispatch is permitted (D15). */
export const RecipeReadinessStateSchema = z.enum(["ready", "disabled", "unknown"]);
export type RecipeReadinessState = z.infer<typeof RecipeReadinessStateSchema>;

export const RecipeReadinessSchema = z
  .object({
    recipeId: z.string().min(1),
    recipeVersion: z.number().int().min(1),
    displayName: z.string().min(1),
    capability: CapabilitySchema,
    state: RecipeReadinessStateSchema,
    /** The specific measured reason (R-10): never a generic "unavailable". */
    reason: z.string().min(1).optional(),
    /** The cloud alternative worth naming, when one exists. */
    cloudAlternative: z.string().min(1).optional(),
  })
  .strict();
export type RecipeReadiness = z.infer<typeof RecipeReadinessSchema>;

/** The one combined result Settings, the picker, routing and enqueue admission all read. */
export const ComfyUiStatusSchema = z
  .object({
    engine: ComfyUiEngineStatusSchema,
    recipes: z.array(RecipeReadinessSchema),
    checkedAt: IsoDateTimeSchema,
  })
  .strict();
export type ComfyUiStatus = z.infer<typeof ComfyUiStatusSchema>;

// ---------------------------------------------------------------------------
// Recovery (§2.11) — a policy per engine source, not a guess
// ---------------------------------------------------------------------------

export type ComfyUiRecoveryDecision =
  /** The engine died with Arke; the relaunched engine provably holds no old work. Free re-run. */
  | { action: "requeue" }
  /** The engine survived and it is the same instance: the recorded id still means something. */
  | { action: "resume" }
  /** The honest user decision (D12): the duplicate costs GPU time, and the copy must say so. */
  | { action: "hold" }
  /** An old id must never be polled against a different engine. */
  | { action: "fail"; reason: string };

/**
 * Pure decision over frozen identity (§2.11): data in, policy out, no provider names beyond the
 * job's own record. `currentInstanceId` is the resolved engine's instance digest right now, or
 * null when no engine is configured at all.
 */
export function comfyUiRecoveryDecision(input: {
  status: "running" | "submitting";
  engine: JobEngineIdentity | undefined;
  currentInstanceId: string | null;
}): ComfyUiRecoveryDecision {
  const { status, engine, currentInstanceId } = input;
  // A job with no frozen identity predates this contract. Nothing can be proven about which
  // engine it belonged to, so the honest decision is the user's.
  if (engine === undefined) return { action: "hold" };
  if (engine.source === "managed" || engine.source === "user-path") {
    // Spawned engines do not survive Arke; their queue and history were in-memory and are gone.
    return { action: "requeue" };
  }
  // A user-directed URL genuinely survives an Arke restart — but only as the same instance.
  if (currentInstanceId === null || currentInstanceId !== engine.instanceId) {
    return {
      action: "fail",
      reason:
        "the engine this job ran on is no longer configured — it was not resumed against the new one",
    };
  }
  return status === "running" ? { action: "resume" } : { action: "hold" };
}
