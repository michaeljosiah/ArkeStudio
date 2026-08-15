import { z } from "zod";
import { BenchParamsSchema, BenchReferenceTokenSchema } from "./bench.js";
import { MediaInfoSchema } from "./media.js";
import { ArtifactIdSchema, IsoDateTimeSchema, SessionIdSchema, Sha256Schema, SlugSchema, TakeIdSchema } from "./ids.js";

/**
 * Artifacts (master spec §13): recordings, documents, boards, stems and images filed against
 * the world. Each artifact is a file plus a `<file>.json` sidecar; artifacts are immutable —
 * superseding files a new artifact and relinks (§2.4.1).
 */

export const ArtifactKindSchema = z.enum(["audio", "image", "video", "document", "board", "other"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/** User-filed or system-produced; system-produced records what produced it (R-ART-2, R-3). */
export const ArtifactOriginSchema = z.discriminatedUnion("by", [
  z
    .object({
      by: z.literal("user"),
      /** Where an import brought it from, e.g. "notes/2019" (SPEC-015 §2.2). */
      importedFrom: z.string().optional(),
    })
    .strict(),
  z.object({ by: z.literal("system"), producedBy: z.string().min(1) }).strict(),
]);
export type ArtifactOrigin = z.infer<typeof ArtifactOriginSchema>;

/** One extraction candidate: a single fact quoting the span that evidences it (SPEC-015 R-12..R-14). */
export const ExtractionCandidateSchema = z
  .object({
    /** Stable identity for decided-tracking: hash of kind+name+quote. */
    hash: z.string().min(1),
    kind: z.enum(["canon", "character", "location", "faction"]),
    /** Canon: the title. Sheets: the name. */
    name: z.string().min(1),
    /** Canon: the statement. Sheets: the one evidenced section's prose. */
    body: z.string().min(1),
    /** Sheets only: which section the body lands in (unevidenced fields stay empty, R-14). */
    section: z.string().optional(),
    /** The verbatim span of the source that evidences this — mechanically verified (R-13). */
    quote: z.string().min(1),
    /** Line number within the extracted text, for the review surface. */
    line: z.number().int().min(1).optional(),
  })
  .strict();
export type ExtractionCandidate = z.infer<typeof ExtractionCandidateSchema>;

/**
 * How a generated artifact came to exist (issue 305 §7): the exact request, so "why and how the
 * bytes were made" is part of the artifact's identity. Two generated occurrences with the same
 * bytes but different provenance stay two artifacts, and a generated take never collapses into
 * an earlier user upload — which is why generated filing bypasses content-hash dedup.
 */
export const ArtifactGenerationSchema = z
  .object({
    sessionId: SessionIdSchema,
    takeId: TakeIdSchema,
    takeNumber: z.number().int().min(1),
    brief: z.string(),
    /** Token and source snapshot, with content hashes — what actually rode along. */
    references: z.array(BenchReferenceTokenSchema),
    provider: z.string().min(1),
    model: z.string().min(1),
    params: BenchParamsSchema,
    requestedSeed: z.number().int().optional(),
    /** From the matching ledger entry; null when the ledger had no actual figure. */
    costMicroUsd: z.number().int().min(0).nullable(),
  })
  .strict();
export type ArtifactGeneration = z.infer<typeof ArtifactGenerationSchema>;

export const ArtifactSidecarSchema = z
  .object({
    id: ArtifactIdSchema,
    kind: ArtifactKindSchema,
    /** Filename within artifacts/ — never an absolute path (R-WORLD-3). */
    file: z.string().min(1),
    hash: Sha256Schema,
    origin: ArtifactOriginSchema,
    /** Sheet slugs, canon ids, production slugs, shot ids — anything may link an artifact. */
    links: z.array(z.string()),
    /**
     * The production that owns this artifact (SPEC-020 R-11). Absent means the world owns it.
     *
     * Ownership is not linkage. `links` says what this artifact is *about* and may name three
     * productions; `production` says who it *belongs to* and names at most one. Conflating them
     * would make an artifact linked to a production disappear from the world's shelf, which is
     * the opposite of what linking it meant.
     *
     * The one mechanism this changes is extraction: a scoped artifact offers sheet candidates
     * into its own production and offers no canon at all (R-12).
     */
    production: SlugSchema.optional(),
    /**
     * Replacement files a NEW artifact recording what it supersedes (SPEC-015 R-5, D10):
     * existing links keep pointing at the old one; pickers derive exclusion from this field.
     */
    supersedes: ArtifactIdSchema.optional(),
    /**
     * What the file measurably is (#253). A sidecar is already replaceable while its media bytes
     * stay immutable, so a measurement can land here without touching what was filed. Absent
     * means nobody has measured it — which is why assigning a master track probes first.
     */
    mediaInfo: MediaInfoSchema.optional(),
    /**
     * Extraction state (SPEC-015 R-15..R-17): verified candidates awaiting the batch review,
     * and the hashes already decided so a re-run never re-offers them (D12).
     */
    extraction: z
      .object({
        pending: z.array(ExtractionCandidateSchema),
        decided: z.array(z.string()),
        /** Fabrications dropped by quote verification, counted rather than hidden (D3). */
        droppedCount: z.number().int().min(0),
      })
      .strict()
      .optional(),
    /** Present exactly on artifacts a bench take filed. `made here` derives from this + origin. */
    generation: ArtifactGenerationSchema.optional(),
    created: IsoDateTimeSchema,
  })
  .strict();
export type ArtifactSidecar = z.infer<typeof ArtifactSidecarSchema>;

/**
 * Pickers exclude superseded artifacts — derived from `supersedes`, never a flag on the old one
 * (SPEC-015 R-5, D10). Here rather than in the coordinator because the reference picker renders
 * in the client, and importing coordinator code into React is the wrong direction (issue 305 §4).
 */
export function pickableArtifacts(artifacts: readonly ArtifactSidecar[]): ArtifactSidecar[] {
  const superseded = new Set(artifacts.map((a) => a.supersedes).filter((s): s is string => s !== undefined));
  return artifacts.filter((a) => !superseded.has(a.id));
}
