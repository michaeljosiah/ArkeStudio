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

/**
 * One local, owner-visible physical call to a provider — an HTTP request, or a subprocess for
 * a provider we drive as a CLI (issue 137). The two are the same record because they answer the
 * same question: what did we actually send, and what came back. They differ in one field each,
 * and neither is made to impersonate the other — an exit code is not an HTTP status, and
 * mapping 0 to 200 would put a number in the history that no provider ever returned.
 */
export const ProviderCallRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: ProviderCallIdSchema,
    provider: ProviderIdSchema,
    operation: z.string().min(1).max(80),
    jobId: JobIdSchema.nullable(),
    attempt: z.number().int().min(0).nullable(),
    model: z.string().min(1).max(200).nullable(),
    /** An HTTP verb, or "EXEC" for a provider driven as a subprocess. */
    method: z.string().min(1).max(16),
    /** A URL, or the subcommand path a CLI was invoked with ("generate create <job_type>"). */
    endpoint: z.string().min(1).max(2000),
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
    elapsedMs: z.number().int().min(0).nullable(),
    status: ProviderCallStatusSchema,
    httpStatus: z.number().int().min(100).max(599).nullable(),
    /**
     * The process exit status, for an EXEC call. Null for HTTP, and null for a process that
     * never produced one — a spawn failure or a timeout, which is not the same as exiting
     * non-zero and must not be recorded as if it were. Defaulted so records written before
     * subprocess providers existed still parse.
     */
    exitCode: z.number().int().nullable().default(null),
    request: PayloadSchema,
    response: PayloadSchema.nullable(),
    error: z
      .object({ name: z.string(), message: z.string(), code: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type ProviderCallRecord = z.infer<typeof ProviderCallRecordSchema>;
