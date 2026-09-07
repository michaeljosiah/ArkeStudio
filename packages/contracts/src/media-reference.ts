import { z } from "zod";

/** A reviewed media selection is durable; decoded or normalized bytes never are. */
export const ReferenceMediaBindingsSchema = z.array(z.object({
  kind: z.enum(["video", "audio"]), file: z.string().min(1),
  hash: z.string().regex(/^(sha256:)?[a-f0-9]{64}$/), durationSec: z.number().positive(),
}).strict()).max(6);
export type ReferenceMediaBindings = z.infer<typeof ReferenceMediaBindingsSchema>;
