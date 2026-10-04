import { z } from "zod";
import { IsoDateTimeSchema, Sha256Schema } from "./ids.js";

export const CHAT_IMAGES_SCHEMA_VERSION = 52;
export const ImageInspectionSettingsSchema = z.object({
  cloud: z.boolean().default(true),
  providers: z.record(z.boolean()).default({}),
}).strict();
export const ImageObservationSchema = z.object({
  id: z.string().min(1).max(500), label: z.string().min(1).max(500),
  sourceHash: Sha256Schema, renditionHash: Sha256Schema,
  width: z.number().int().min(1).max(1568), height: z.number().int().min(1).max(1568),
  posterOnly: z.boolean(),
}).strict();
export const ImageDisclosureSchema = z.object({
  provider: z.string().min(1).max(200), images: z.array(ImageObservationSchema).max(256),
  at: IsoDateTimeSchema,
}).strict();
export type ImageObservation = z.infer<typeof ImageObservationSchema>;
export type ImageDisclosure = z.infer<typeof ImageDisclosureSchema>;
