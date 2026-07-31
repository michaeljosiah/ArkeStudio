import { z } from "zod";
import { ArtifactIdSchema, IsoDateTimeSchema, Sha256Schema } from "./ids.js";

/**
 * Artifacts (master spec §13): recordings, documents, boards, stems and images filed against
 * the world. Each artifact is a file plus a `<file>.json` sidecar; artifacts are immutable —
 * superseding files a new artifact and relinks (§2.4.1).
 */

export const ArtifactKindSchema = z.enum(["audio", "image", "video", "document", "board", "other"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/** User-filed or system-produced; system-produced records what produced it (R-ART-2). */
export const ArtifactOriginSchema = z.discriminatedUnion("by", [
  z.object({ by: z.literal("user") }).strict(),
  z.object({ by: z.literal("system"), producedBy: z.string().min(1) }).strict(),
]);
export type ArtifactOrigin = z.infer<typeof ArtifactOriginSchema>;

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
    created: IsoDateTimeSchema,
  })
  .strict();
export type ArtifactSidecar = z.infer<typeof ArtifactSidecarSchema>;
