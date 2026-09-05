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
    /** Actual data locality. A user URL is local only for an exact, transport-confined loopback host. */
    locality: z.enum(["local", "remote"]),
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
    /**
     * The engine version the job was priced against, frozen at enqueue (SPEC-021 R-19; issue
     * 592). The client refuses before `/prompt` when the engine no longer reports it, so a take
     * either ran on this version or never ran. Absent for jobs enqueued before it existed.
     */
    engineVersion: z.string().min(1).optional(),
  })
  .strict();
export type RecipeIdentity = z.infer<typeof RecipeIdentitySchema>;

/**
 * Which engine this job was dispatched against. The instance id is the same opaque location
 * digest the engine status carries — job rows reach the renderer, so an absolute path may not
 * (§2.11). Spawned engines additionally freeze the process epoch: a replacement at the same
 * filesystem location has a new in-memory queue and is therefore a different execution target.
 */
export const JobEngineIdentitySchema = z
  .object({
    source: z.enum(["user-path", "user-url", "managed"]),
    instanceId: z.string().min(1),
    /** Optional only for jobs written before destination locality was frozen. */
    locality: z.enum(["local", "remote"]).optional(),
    /** Opaque per-process identity; omitted for URL engines and legacy job rows. */
    processEpoch: z.string().min(1).optional(),
  })
  .strict();
export type JobEngineIdentity = z.infer<typeof JobEngineIdentitySchema>;

// ---------------------------------------------------------------------------
// The setup component a recipe's weights arrive as
// ---------------------------------------------------------------------------

/**
 * A recipe's weight files reach the machine as an ordinary setup component, and its id is the
 * only thing tying the three halves of that together: the host derives the entry from the
 * recipe, the coordinator re-verifies the recipe when a component with this prefix lands, and
 * Settings puts the component's Download on the recipe's own row. That was three spellings of
 * one string in three packages, so it is spelled here once (SPEC-028, R-10's rule for the Voxa
 * ids applied to these).
 */
export const COMFYUI_WEIGHTS_COMPONENT_PREFIX = "comfyui-weights-";

/** The setup component carrying this recipe's weights, whether or not one is in the catalogue. */
export function comfyUiWeightsComponentId(recipeId: string): string {
  return `${COMFYUI_WEIGHTS_COMPONENT_PREFIX}${recipeId}`;
}

/** Whether a setup component id names some recipe's weights. */
export function isComfyUiWeightsComponent(componentId: string): boolean {
  return componentId.startsWith(COMFYUI_WEIGHTS_COMPONENT_PREFIX);
}

/** The inverse: the recipe whose weights this component is, or null for any other component. */
export function comfyUiWeightsRecipeId(componentId: string): string | null {
  return isComfyUiWeightsComponent(componentId)
    ? componentId.slice(COMFYUI_WEIGHTS_COMPONENT_PREFIX.length)
    : null;
}

// ---------------------------------------------------------------------------
// Recipe readiness (§2.12, R-16) — one answer, consumed everywhere
// ---------------------------------------------------------------------------

/** `unknown` is a real state: the floor could not be checked, and dispatch is permitted (D15). */
export const RecipeReadinessStateSchema = z.enum(["ready", "disabled", "unknown"]);
export type RecipeReadinessState = z.infer<typeof RecipeReadinessStateSchema>;

/**
 * Which step of the readiness walk refused (SPEC-032 R-20, D3). The diagnostics joins need to
 * know *which* condition disabled a recipe — engine down, folder unmapped, files missing, digest
 * wrong — and the walk is the only thing that knows; classifying its prose after the fact would
 * couple a correlation to a sentence. Declared beside the reason, optional because the reason
 * predates it and a status without one still parses.
 */
export const RecipeReasonKindSchema = z.enum([
  /** A known-incomplete dependency closure declared in the catalogue itself. */
  "catalogue",
  /** The engine is absent, unreachable, incompatible, failed or starting. */
  "engine",
  /** A URL engine with no mapped models folder, where there are files to verify (D13). */
  "models-folder",
  /** A node class the engine does not have. */
  "node",
  /** Weight files missing from the models folder. */
  "files",
  /** A pinned file is present and its digest does not match — repair territory (§2.5). */
  "digest",
  /** Verification could not run or could not read what it needed. */
  "verification",
  /** The card is too small for the floor. */
  "vram",
  /** The card clears the floor and is too busy right now. */
  "vram-busy",
  /** System memory is under the recipe's measured floor — the resource offloading spends. */
  "memory",
]);
export type RecipeReasonKind = z.infer<typeof RecipeReasonKindSchema>;

export const RecipeReadinessSchema = z
  .object({
    recipeId: z.string().min(1),
    recipeVersion: z.number().int().min(1),
    displayName: z.string().min(1),
    capability: CapabilitySchema,
    state: RecipeReadinessStateSchema,
    /** The specific measured reason (R-10): never a generic "unavailable". */
    reason: z.string().min(1).optional(),
    /** Which walk step the reason came from, for joins that must not parse the sentence. */
    reasonKind: RecipeReasonKindSchema.optional(),
    /** The cloud alternative worth naming, when one exists. */
    cloudAlternative: z.string().min(1).optional(),
    /**
     * Set on a ready recipe whose engine is newer than the version it was exercised against
     * (SPEC-021 R-19; issue 592): stated, never a refusal, so an honest engine error stays diagnosable.
     */
    untested: z.string().min(1).optional(),
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
  /** The spawned process died; its replacement provably holds no old work. Free re-run. */
  | { action: "requeue"; engine?: JobEngineIdentity }
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
  currentEngine?: JobEngineIdentity | null;
}): ComfyUiRecoveryDecision {
  const { status, engine, currentInstanceId, currentEngine } = input;
  // A job with no frozen identity predates this contract. Nothing can be proven about which
  // engine it belonged to, so the honest decision is the user's.
  if (engine === undefined) return { action: "hold" };
  if (engine.source === "managed" || engine.source === "user-path") {
    if (engine.processEpoch !== undefined && currentEngine !== undefined && currentEngine !== null) {
      if (
        currentEngine.source !== engine.source ||
        currentEngine.instanceId !== engine.instanceId ||
        currentEngine.processEpoch === engine.processEpoch
      ) {
        return {
          action: "fail",
          reason:
            "the spawned engine lifecycle could not prove a replacement process; the job was not resumed or duplicated",
        };
      }
    }
    // Spawned engines do not survive Arke; their queue and history were in-memory and are gone.
    return {
      action: "requeue",
      ...(currentEngine !== undefined && currentEngine !== null ? { engine: currentEngine } : {}),
    };
  }
  // A user-directed URL genuinely survives an Arke restart — but only as the same instance.
  if (currentInstanceId === null || currentInstanceId !== engine.instanceId) {
    return {
      action: "fail",
      reason: "the engine this job ran on is no longer configured — it was not resumed against the new one",
    };
  }
  return status === "running" ? { action: "resume" } : { action: "hold" };
}

// ---------------------------------------------------------------------------
// Engine versions (SPEC-021 D14, D17; issue 592) — one floor, one comparison, shared
// ---------------------------------------------------------------------------

/**
 * The oldest engine whose API shape the client drives — `/prompt`, `/history`, `/system_stats`,
 * `/object_info`, `/upload`. A recipe's own requirement lives on the recipe (R-18); this is the
 * provider's, and it was declared twice before it was declared here.
 */
export const COMFYUI_VERSION_FLOOR = "0.3.45";

function parseComfyUiVersion(version: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** Numeric, field by field: "0.33.1" is newer than "0.3.45", which a string compare denies. Null when either side is not a version. */
export function compareComfyUiVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseComfyUiVersion(a);
  const right = parseComfyUiVersion(b);
  if (left === null || right === null) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i]! !== right[i]!) return left[i]! > right[i]! ? 1 : -1;
  }
  return 0;
}

export function meetsComfyUiVersion(version: string, floor: string): boolean | null {
  const order = compareComfyUiVersions(version, floor);
  return order === null ? null : order >= 0;
}
