import { z } from "zod";
import { ArtifactIdSchema, TakeIdSchema, Sha256Schema, SlugSchema } from "./ids.js";
import { ReferenceKindSchema, type ReferenceKind } from "./reference-budget.js";

/**
 * A world-relative path, constrained where it enters rather than where it is used.
 *
 * A path arriving from a client is not permission to read the disk. This is the first of two
 * gates — the coordinator resolves against the world directory and re-checks besides — but the
 * schema is where the shape is settled, so a malformed path never reaches code that assumes it
 * is well formed. Forward slashes because a world moves across platforms (R-24).
 */
export { WorldFilePathSchema } from "./ids.js";
import { WorldFilePathSchema } from "./ids.js";

export const BenchReferenceSourceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("artifact"), artifactId: ArtifactIdSchema, hash: Sha256Schema }).strict(),
  z.object({ source: z.literal("take"), takeId: TakeIdSchema, hash: Sha256Schema }).strict(),
  /**
   * A picture that lives in the world but is not an artifact — everything under a character:
   * their accepted identity, their looks, the candidates still waiting on review, and every
   * take ever generated for them. The world holds far more pictures than the artifacts folder,
   * and until this variant existed none of them could be picked (reported 2026-08-18).
   *
   * The path is the identity, so the same file re-picked restores its old token. It is
   * world-relative and the coordinator confines it to the world directory — a path arriving
   * from a client is not permission to read the disk.
   */
  z.object({ source: z.literal("world-file"), path: WorldFilePathSchema, hash: Sha256Schema }).strict(),
]);
export type BenchReferenceSource = z.infer<typeof BenchReferenceSourceSchema>;

/** "Image 3" — the kind capitalised, then the 1-based number. The display form IS the identity. */
export const BENCH_TOKEN = /^(Image|Video|Audio) ([1-9][0-9]*)$/;

const TOKEN_PREFIX: Record<ReferenceKind, string> = { image: "Image", video: "Video", audio: "Audio" };

export function benchTokenFor(kind: ReferenceKind, n: number): string {
  return `${TOKEN_PREFIX[kind]} ${n}`;
}

/** The parsed identity of a token, or null for a string that is not one. */
export function parseBenchToken(token: string): { kind: ReferenceKind; n: number } | null {
  const m = BENCH_TOKEN.exec(token);
  if (!m) return null;
  const kind = (Object.entries(TOKEN_PREFIX).find(([, p]) => p === m[1])?.[0] ?? null) as ReferenceKind | null;
  return kind === null ? null : { kind, n: Number(m[2]) };
}

export const BenchReferenceTokenSchema = z
  .object({
    /** Display form, e.g. "Image 3" — stable for the session's life, never renumbered. */
    token: z.string().regex(BENCH_TOKEN),
    kind: ReferenceKindSchema,
    source: BenchReferenceSourceSchema,
    /** Subject-prefilled tiles name what they represent instead of only saying "Image 1". */
    label: z.string().min(1).max(200).optional(),
    detail: z.string().min(1).max(300).optional(),
    /** Frozen sheet provenance for a named subject reference. */
    sheetId: SlugSchema.optional(),
    sheetVersion: z.number().int().min(1).optional(),
    /** Measured length for subject audio/video that did not come through an artifact sidecar. */
    durationSec: z.number().positive().optional(),
    /** A subject audio tile remains visible when the chosen route cannot carry it. */
    ride: z.enum(["required", "when-supported"]).optional(),
    /** Production's attachment decision, used to bind the carried image in the provider prompt. */
    productionBinding: z
      .object({
        subject: z.string().min(1).max(200),
        rolePhrase: z.string().min(1).max(300),
        mode: z.enum(["designated", "main-photo", "scoped-look", "sketch-citation", "prop-state"]),
      })
      .strict()
      .optional(),
    /** Why a production prefill supplied this token; ordinary user references leave it absent. */
    subjectRole: z.enum(["reference", "audio", "board-frame"]).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const parsed = parseBenchToken(entry.token);
    if (parsed !== null && parsed.kind !== entry.kind) {
      ctx.addIssue({ code: "custom", message: `token "${entry.token}" does not spell its kind "${entry.kind}"` });
    }
  });
export type BenchReferenceToken = z.infer<typeof BenchReferenceTokenSchema>;

/** One stable identity per source, so the same artifact can never ride under two names. */
export function benchSourceKey(source: BenchReferenceSource): string {
  switch (source.source) {
    case "artifact":
      return `artifact:${source.artifactId}`;
    case "take":
      return `take:${source.takeId}`;
    case "world-file":
      return `file:${source.path}`;
  }
}

