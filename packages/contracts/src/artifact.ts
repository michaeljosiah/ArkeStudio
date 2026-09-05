import { z } from "zod";
import { BenchParamsSchema, BenchReferenceTokenSchema } from "./bench.js";
import { MediaInfoSchema } from "./media.js";
import { ActualCostSourceSchema, ProvenanceSchema } from "./take.js";
import {
  ArtifactIdSchema,
  IsoDateTimeSchema,
  JobIdSchema,
  SessionIdSchema,
  Sha256Schema,
  SlugSchema,
  TakeIdSchema,
} from "./ids.js";

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
 *
 * The bench was the first surface to file what it made, so this shape was the bench's own for a
 * while (issue 475). It stays exactly as it was, under a `source` that defaults to "bench" —
 * every sidecar already on disk was written before the field existed, and an artifact whose
 * sidecar fails to parse is an artifact the world scan drops.
 */
export const ArtifactBenchGenerationSchema = z
  .object({
    source: z.literal("bench").default("bench"),
    sessionId: SessionIdSchema,
    takeId: TakeIdSchema,
    takeNumber: z.number().int().min(1),
    brief: z.string(),
    /** Token and source snapshot, with content hashes — what actually rode along. */
    references: z.array(BenchReferenceTokenSchema),
    /** The frames the shot passed through (issue 305 §3), same shape — defaulted so every
        sidecar written before the Keyframe lane existed still scans. */
    keyframes: z.array(BenchReferenceTokenSchema).default([]),
    provider: z.string().min(1),
    model: z.string().min(1),
    /** The recipe version, when the model is a local recipe (SPEC-021 R-13) — part of "how the bytes were made". */
    recipeVersion: z.number().int().min(1).optional(),
    params: BenchParamsSchema,
    requestedSeed: z.number().int().optional(),
    /** From the matching ledger entry; null when the ledger had no actual figure. */
    costMicroUsd: z.number().int().min(0).nullable(),
  })
  .strict();
export type ArtifactBenchGeneration = z.infer<typeof ArtifactBenchGenerationSchema>;

/**
 * Which character surface asked for the picture (issue 475) — the job target, verbatim, so the
 * workflow is a fact about the request rather than a guess made later from the file's name.
 *
 * `reference-tile` is the legacy kit path: it lands in the kit rather than in a take, and it is
 * listed here for as long as existing kits still hold tiles that came from it.
 */
export const CharacterReferenceWorkflowSchema = z.enum([
  "main-photo-candidate",
  "establish-candidate",
  "character-sheet",
  "character-voice-sample",
  "character-look",
  "reference-tile",
]);
export type CharacterReferenceWorkflow = z.infer<typeof CharacterReferenceWorkflowSchema>;

/** Job targets whose success files a character-reference artifact (issue 475). */
export const CHARACTER_REFERENCE_ARTIFACT_TARGETS: ReadonlySet<string> = new Set(
  CharacterReferenceWorkflowSchema.options,
);

/**
 * How a character-reference picture came to exist (issue 475).
 *
 * The same claim the bench shape makes — the exact request is part of the artifact's identity —
 * for the four character surfaces and the legacy kit tile. It is a separate shape rather than
 * the bench's with holes in it because a character generation has no session and no take
 * number, and inventing either would put a fiction in the one record that exists to be trusted.
 *
 * `jobId` is the identity filing deduplicates on: one succeeded job made these bytes once, and
 * finalization is replayable, so a replay has to find what the first pass filed rather than file
 * it again.
 *
 * The string fields are deliberately unconstrained beyond non-emptiness. This is a read path —
 * a sidecar that fails to parse is an artifact `scanWorld` drops from the world — so a path
 * shape tightened here would delete history from worlds already on disk.
 */
export const ArtifactReferenceGenerationSchema = z
  .object({
    source: z.literal("character-reference"),
    /** The succeeded job whose result this is — the filing's idempotency key. */
    jobId: JobIdSchema,
    /** The reference take the bytes were filed from; the legacy tile path records none. */
    takeId: TakeIdSchema.optional(),
    /** The character (or location) sheet the picture is of. Also the artifact's link. */
    sheetId: z.string().min(1),
    workflow: CharacterReferenceWorkflowSchema,
    /** World-relative path of the durable copy filed from — the take, or the kit's own tile. */
    sourceFile: z.string().min(1),
    prompt: z.string(),
    /** World-relative reference images the request carried, in dispatch order. */
    references: z.array(z.string()),
    provider: z.string().min(1),
    model: z.string().min(1),
    /** The dispatch parameters as sent, so the request can be read back whole. */
    params: z.record(z.string(), z.unknown()),
    /** Canon revision, sheet versions and art-direction version, frozen at dispatch (§2.4). */
    provenance: ProvenanceSchema,
    requestedSeed: z.number().int().optional(),
    estimatedMicroUsd: z.number().int().min(0),
    /** From the matching ledger entry; null when the ledger had no actual figure. */
    costMicroUsd: z.number().int().min(0).nullable(),
    costSource: ActualCostSourceSchema.optional(),
  })
  .strict();
export type ArtifactReferenceGeneration = z.infer<typeof ArtifactReferenceGenerationSchema>;

export const ArtifactGenerationSchema = z.union([
  ArtifactBenchGenerationSchema,
  ArtifactReferenceGenerationSchema,
]);
export type ArtifactGeneration = z.infer<typeof ArtifactGenerationSchema>;

/**
 * How a boundary still was cut from footage (issue 154). Like `generation` is for bench takes,
 * this is part of the asset's identity: the source take, the moment within its media, and the
 * method that decoded it. A frame that cannot say where it came from cannot be trusted to open
 * the next shot, and a stale one cannot be detected.
 */
export const BoundaryExtractionSchema = z
  .object({
    /** The accepted take whose footage the frame closes — a segment take for a pass boundary. */
    sourceTakeId: TakeIdSchema,
    /** The take whose media file was actually decoded (the pass, when the source is a segment). */
    mediaTakeId: TakeIdSchema,
    /** Seconds into that media; null means the final decoded frame of the clip. */
    atSec: z.number().min(0).nullable(),
    /** Extraction method and version, so a better cutter can supersede rather than overwrite. */
    method: z.string().min(1),
  })
  .strict();
export type BoundaryExtraction = z.infer<typeof BoundaryExtractionSchema>;

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
    /** Present exactly on boundary stills cut from accepted footage (issue 154). */
    boundaryExtraction: BoundaryExtractionSchema.optional(),
    created: IsoDateTimeSchema,
  })
  .strict()
  // A boundary frame is a picture by definition (issue 154): a video filed with extraction
  // provenance is a clip pretending to be a frame, which is exactly the confusion the durable
  // asset exists to end. Enforced at parse so no writer can smuggle one past the read path.
  .refine((sidecar) => sidecar.boundaryExtraction === undefined || sidecar.kind === "image", {
    message: "a boundary frame must be an image artifact",
  });
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

/**
 * Made by this application rather than brought into it — whatever made it (issue 475).
 *
 * The bench was once the only such surface and the shelf asked for it by name; a character's
 * generated pictures are as much "made here" as a bench take is, and a check spelled per
 * producer would have to be found and widened again by the next surface that files.
 */
export function isGeneratedArtifact(artifact: ArtifactSidecar): boolean {
  return artifact.origin.by === "system" && artifact.generation !== undefined;
}
