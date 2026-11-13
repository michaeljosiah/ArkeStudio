import { z } from "zod";
import { ArtifactIdSchema, TakeIdSchema } from "./ids.js";
import { MediaInfoSchema } from "./media.js";

export const MediaMeasurementSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("artifact"), artifactId: ArtifactIdSchema }).strict(),
  z.object({ kind: z.literal("take"), takeId: TakeIdSchema }).strict(),
]);
export type MediaMeasurementSource = z.infer<typeof MediaMeasurementSourceSchema>;
export const MediaMeasurementResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("measured"), info: MediaInfoSchema }).strict(),
  z.object({ status: z.literal("failed"), reason: z.enum(["not-configured", "probe-failed", "source-changed", "unavailable", "busy", "cancelled", "save-failed"]) }).strict(),
]);
export type MediaMeasurementResult = z.infer<typeof MediaMeasurementResultSchema>;
