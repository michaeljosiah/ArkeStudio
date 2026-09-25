import { z } from "zod";

// SPEC-021 / SPEC-033, issue 1248. Bytes, compatibility and permission are independent facts.
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export const AdapterSelectionSchema = z.object({
  releaseId: Id, sha256: Digest, strength: z.number().finite().min(0).max(2),
}).strict();
export const AdapterSelectionsSchema = z.array(AdapterSelectionSchema).max(4).superRefine((rows, ctx) => {
  if (new Set(rows.map(row => row.sha256)).size !== rows.length) ctx.addIssue({ code: "custom", message: "An adapter can be selected only once." });
});
export type AdapterSelection = z.infer<typeof AdapterSelectionSchema>;

/** The current adapter catalogue is adult-classified; persisted choices retain that label even after removal. */
export function hasAdultAdapter(params: unknown): boolean {
  return !!params && typeof params === "object" && "adapters" in params && Array.isArray(params.adapters) && params.adapters.length > 0;
}

export const AdapterReleaseSchema = z.object({
  id: Id, adapterId: Id, publisher: z.string().min(1), displayName: z.string().min(1),
  source: z.object({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), revision: z.string().regex(/^[a-f0-9]{40}$/),
    file: z.string().regex(/^[\w.-]+\.safetensors$/), bytes: z.number().int().positive().safe(), sha256: Digest }).strict(),
  license: z.object({ name: z.string().min(1), url: z.string().url() }).strict(),
  classification: z.enum(["general", "adult"]), baseFamily: z.literal("minimax-h3"),
  availability: z.enum(["current", "withdrawn"]).default("current"),
  supersedes: z.array(Id), assessedAt: z.string().datetime(),
  compatibility: z.array(z.object({
    recipeId: Id, state: z.enum(["unverified", "verified", "owner-approved", "incompatible"]), reason: z.string().min(1),
    ownerApproval: z.object({ approvedAt: z.string().datetime(), generation: z.enum(["completed", "memory-blocked", "not-run"]) }).strict().optional(),
    evidence: z.string().min(1).optional(), minStrength: z.number().min(0).max(2).optional(), maxStrength: z.number().min(0).max(2).optional(),
    minEngineVersion: z.string().optional(), exercisedThroughVersion: z.string().optional(),
    hardware: z.object({ minVramMb: z.number().int().positive(), minFreeVramMb: z.number().int().positive(),
      minMemMb: z.number().int().positive(), minFreeMemMb: z.number().int().positive() }).strict().optional(),
  }).strict()).superRefine((rows, ctx) => {
    for (const row of rows) if (row.state === "owner-approved" && (!row.ownerApproval || !row.evidence ||
      row.minStrength === undefined || row.maxStrength === undefined || row.minStrength > row.maxStrength)) {
      ctx.addIssue({ code: "custom", message: "Owner approval needs its date, actual generation outcome, evidence and bounded strength." });
    }
    for (const row of rows) if (row.state === "verified" && (!row.evidence || row.minStrength === undefined || row.maxStrength === undefined ||
      row.minStrength > row.maxStrength || !row.minEngineVersion || !row.exercisedThroughVersion || !row.hardware)) {
      ctx.addIssue({ code: "custom", message: "Verified compatibility needs evidence, engine versions, hardware floors and measured parameter bounds." });
    }
  }),
}).strict();
export type AdapterRelease = z.infer<typeof AdapterReleaseSchema>;

export const AdultAcknowledgementSchema = z.object({ adultAge: z.literal(true), explicitChoice: z.literal(true), rightsAndConsent: z.literal(true) }).strict();
export const AdultContentSchema = z.object({ enabled: z.boolean(), acknowledgedAt: z.string().datetime().nullable(), acknowledgementVersion: z.literal(1) }).strict();
export const ADULT_CONTENT_OFF = { enabled: false, acknowledgedAt: null, acknowledgementVersion: 1 } as const;

export const AdapterDecisionSchema = z.object({
  sha256: Digest, decision: z.enum(["allowed", "disabled", "removal-requested"]), reason: z.string().min(1).max(1000),
  policyRevision: z.string().min(1).max(200), assessedAt: z.string().datetime(), expiresAt: z.string().datetime().optional(),
}).strict().superRefine((row, ctx) => {
  if (row.expiresAt && row.expiresAt <= row.assessedAt) ctx.addIssue({ code: "custom", message: "Expiry must follow assessment." });
});
export type AdapterDecision = z.infer<typeof AdapterDecisionSchema>;

export const AdapterLibraryStateSchema = z.object({
  revision: z.number().int().nonnegative(), adultContent: AdultContentSchema, scannerAvailable: z.boolean(),
  entries: z.array(z.object({ release: AdapterReleaseSchema, decision: AdapterDecisionSchema.nullable(),
    removed: z.boolean(), installed: z.boolean(), owned: z.boolean(), reason: z.string().nullable(),
  }).strict()), error: z.string().nullable(),
}).strict();
export type AdapterLibraryState = z.infer<typeof AdapterLibraryStateSchema>;

export const AdapterActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh") }).strict(),
  z.object({ action: z.literal("enable"), acknowledgement: AdultAcknowledgementSchema }).strict(),
  z.object({ action: z.literal("disable-content") }).strict(),
  z.object({ action: z.literal("scan") }).strict(),
  z.object({ action: z.literal("install"), releaseIds: z.array(Id).min(1).max(100) }).strict(),
  z.object({ action: z.literal("disable"), releaseId: Id }).strict(),
  z.object({ action: z.literal("restore"), releaseId: Id }).strict(),
  z.object({ action: z.literal("remove"), releaseId: Id, deleteOwnedFile: z.boolean() }).strict(),
]);
export type AdapterAction = z.infer<typeof AdapterActionSchema>;

export function adapterPolicyProblem(release: AdapterRelease, content: z.infer<typeof AdultContentSchema>, decision: AdapterDecision | null,
  removed: boolean, now: string): string | null {
  if (removed) return "Removed from this studio.";
  if (release.availability === "withdrawn") return "This release is no longer in the reviewed publisher inventory.";
  if (release.classification === "adult" && (!content.enabled || !content.acknowledgedAt)) return "Adult content is off.";
  if (!decision) return "Awaiting compliance assessment.";
  if (decision.sha256 !== release.source.sha256) return "The assessment belongs to different bytes.";
  if (decision.assessedAt > now || (decision.expiresAt && decision.expiresAt <= now)) return "Compliance assessment needs renewal.";
  return decision.decision === "allowed" ? null : decision.reason;
}

export function adapterCompatibilityProblem(release: AdapterRelease, recipeId: string, strength: number): string | null {
  const row = release.compatibility.find(item => item.recipeId === recipeId);
  if (!row) return "This adapter does not support the selected recipe.";
  if (row.state !== "verified" && row.state !== "owner-approved") return row.reason;
  if (strength < row.minStrength! || strength > row.maxStrength!) return `Adapter strength must be between ${row.minStrength} and ${row.maxStrength}.`;
  return null;
}
