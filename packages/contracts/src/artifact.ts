import { z } from "zod";
import { ArtifactIdSchema, IsoDateTimeSchema, Sha256Schema } from "./ids.js";

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
     * Replacement files a NEW artifact recording what it supersedes (SPEC-015 R-5, D10):
     * existing links keep pointing at the old one; pickers derive exclusion from this field.
     */
    supersedes: ArtifactIdSchema.optional(),
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
    created: IsoDateTimeSchema,
  })
  .strict();
export type ArtifactSidecar = z.infer<typeof ArtifactSidecarSchema>;
