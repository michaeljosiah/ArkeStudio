import { z } from "zod";
import { IsoDateTimeSchema, JobIdSchema, ProviderCallIdSchema } from "./ids.js";
import { ProviderIdSchema } from "./provider.js";

export const ProviderCallStatusSchema = z.enum([
  "pending",
  "accepted",
  "succeeded",
  "rejected",
  "transport-failed",
]);
export type ProviderCallStatus = z.infer<typeof ProviderCallStatusSchema>;

const PayloadSchema = z.object({ headers: z.record(z.string()), body: z.unknown() }).strict();

/** One local, owner-visible physical HTTP call to a provider. */
export const ProviderCallRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: ProviderCallIdSchema,
    provider: ProviderIdSchema,
    operation: z.string().min(1).max(80),
    jobId: JobIdSchema.nullable(),
    attempt: z.number().int().min(0).nullable(),
    model: z.string().min(1).max(200).nullable(),
    method: z.string().min(1).max(16),
    endpoint: z.string().min(1).max(2000),
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
    elapsedMs: z.number().int().min(0).nullable(),
    status: ProviderCallStatusSchema,
    httpStatus: z.number().int().min(100).max(599).nullable(),
    request: PayloadSchema,
    response: PayloadSchema.nullable(),
    error: z
      .object({ name: z.string(), message: z.string(), code: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type ProviderCallRecord = z.infer<typeof ProviderCallRecordSchema>;
