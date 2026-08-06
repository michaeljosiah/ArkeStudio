import { z } from "zod";
import { CanonIdSchema } from "./ids.js";

/**
 * The grounded Q&A contract (SPEC-006). Answers are assembled from verified quotations —
 * every claim names its entry and quotes the span that supports it, and the span is checked
 * mechanically against the source before anything renders (D1, R-5, R-6).
 */

/** What the canon-qa model must return — JSON only, nothing else trusted (R-8). */
export const AskModelResponseSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("answer"),
      claims: z
        .array(
          z
            .object({
              /** The claim in the answer's own words. */
              text: z.string().min(1),
              /** The entry that supports it — must be in the retrieved candidate set. */
              entryId: CanonIdSchema,
              /** A verbatim span from that entry. Verified, not trusted. */
              excerpt: z.string().min(1),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("cannot_answer"),
      note: z.string().optional(),
    })
    .strict(),
]);
export type AskModelResponse = z.infer<typeof AskModelResponseSchema>;

export const AskCandidateSchema = z
  .object({
    entryId: CanonIdSchema,
    title: z.string(),
    score: z.number(),
  })
  .strict();
export type AskCandidate = z.infer<typeof AskCandidateSchema>;

/** What the client renders: an answer, a refusal, or honest unavailability. */
export const AskResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("answer"),
      claims: z
        .array(
          z.object({ text: z.string(), entryId: CanonIdSchema, excerpt: z.string() }).strict(),
        )
        .min(1),
      searched: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refusal"),
      /** Two causes, distinguishable (R-12): nothing near it vs described-but-undecided. */
      cause: z.enum(["nothing-retrieved", "unsupporting"]),
      searched: z.number().int().min(0),
      closest: z.array(AskCandidateSchema),
      detail: z.string().optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unavailable"),
      reason: z.string(),
      searched: z.number().int().min(0),
      closest: z.array(AskCandidateSchema),
    })
    .strict(),
]);
export type AskResult = z.infer<typeof AskResultSchema>;
