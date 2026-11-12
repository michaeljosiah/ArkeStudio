import { z } from "zod";

const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = (limit: number, required = true) => z.string().trim().min(required ? 1 : 0).max(limit).refine(value => ![...value].some(c => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)), "Use text without control characters");
export const CreatorPublishingFormSchema = z.object({
  title: text(200), creatorDisplayName: text(200),
  summary: text(2000, false), language: text(35),
  audience: z.enum(["general", "children", "adults"]), ageRating: text(120),
  attribution: text(2000), rightsBasis: text(1000),
  evidenceReference: text(512), distributionPermissionGranted: z.literal(true),
}).strict();
export type CreatorPublishingForm = z.infer<typeof CreatorPublishingFormSchema>;
export const CreatorPackagePreviewSchema = z.object({
  candidateId: uuid, exportId: z.string(), title: z.string(), creatorDisplayName: z.string(), summary: z.string(),
  worldId: z.string(), edition: z.string(), fileName: z.string(), bytes: z.number().int().positive(), sha256: sha,
  kind: z.enum(["world", "guide", "part", "production", "story", "comic"]),
  channelKey: z.string(), rightsDeclarationVersion: z.string(), permissionText: z.string(), artworkAssetId: z.string(),
  assets: z.array(z.object({ id: z.string(), path: z.string(), mediaType: z.string(), bytes: z.number().int().nonnegative() })).max(2048),
}).strict().refine(preview => preview.kind === "part" || preview.artworkAssetId.length > 0, { message: "A full edition needs its own artwork", path: ["artworkAssetId"] });
export type CreatorPackagePreview = z.infer<typeof CreatorPackagePreviewSchema>;
export const CreatorPublicationSchema = z.object({
  id: uuid, worldId: z.string(), productionId: z.string(), exportId: z.string(), title: z.string(), edition: z.string(),
  packageSha256: sha, packageBytes: z.number().int().positive(),
  receiptId: uuid.nullable(), revisionId: uuid.nullable(), revisionNumber: z.number().int().nullable(),
  status: z.string(), transfer: z.enum(["pending", "uploading", "paused", "complete", "cancelled", "superseded"]),
  receivedBytes: z.number().int().nonnegative(), updatedAt: z.string(), message: z.string().nullable(),
  decisions: z.array(z.object({ revisionId: uuid, decision: z.string(), message: z.string(), decidedAt: z.string() })).max(100),
}).strict();
export type CreatorPublication = z.infer<typeof CreatorPublicationSchema>;
export const CreatorPublishingStateSchema = z.object({
  configured: z.boolean(), scopeId: sha.nullable(), publications: z.array(CreatorPublicationSchema).max(1000),
  preview: CreatorPackagePreviewSchema.optional(), refusal: z.string().nullable(),
}).strict();
export type CreatorPublishingState = z.infer<typeof CreatorPublishingStateSchema>;
