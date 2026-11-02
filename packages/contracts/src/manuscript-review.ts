import { z } from "zod";
import { UlidSchema, SlugSchema } from "./ids.js";

export const ManuscriptReviewTargetSchema = z.object({ worldId: UlidSchema, productionId: SlugSchema }).strict();
export type ManuscriptReviewTarget = z.infer<typeof ManuscriptReviewTargetSchema>;
export const ManuscriptReviewDecisionSchema = z.enum(["open", "intentional", "dismissed", "resolved"]);
const citation = z.object({ chapterId: z.string().min(1).max(200), quote: z.string().min(1).max(1200) }).strict();
export const ManuscriptFindingDraftSchema = z.object({
  title: z.string().min(1).max(200), priority: z.number().int().min(1).max(3),
  kind: z.enum(["contradiction", "interpretation", "author-decision"]),
  observation: z.string().min(1).max(1600), recommendation: z.string().min(1).max(1600),
  preserve: z.string().max(1000), dependencies: z.string().max(1000),
  citations: z.array(citation).min(1).max(6),
}).strict();
export const ManuscriptReadingSchema = z.object({
  synopsis: z.string().min(1).max(6000), strengths: z.string().max(3000),
  editorial: z.string().max(6000), continuity: z.string().max(6000),
  findings: z.array(ManuscriptFindingDraftSchema).max(6),
}).strip().refine(value => JSON.stringify(value).length <= 16000, "Reading exceeds the 16,000-character stage budget.");
export const ManuscriptSynthesisSchema = z.object({
  verdict: z.string().min(1).max(3000), synopsis: z.string().min(1).max(16000),
  strengths: z.string().max(6000), editorial: z.string().min(1).max(16000),
  continuity: z.string().max(8000), limitations: z.string().max(4000),
  findings: z.array(ManuscriptFindingDraftSchema).max(60),
}).strip();
export const ManuscriptFindingSchema = ManuscriptFindingDraftSchema.extend({
  id: z.string(), decision: ManuscriptReviewDecisionSchema, carried: z.boolean(),
  citations: z.array(citation.extend({ hash: z.string(), offset: z.number().int().nonnegative() })).min(1).max(6),
  stale: z.boolean().default(false),
}).strict();
export const ManuscriptReviewTaskSchema = z.object({
  id: z.string(), kind: z.enum(["reading", "merge", "synthesis"]), chapterId: z.string().optional(),
  inputs: z.array(z.string()).max(1000).optional(),
  start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional(),
  state: z.enum(["pending", "running", "complete", "failed", "interrupted"]),
  model: z.string().optional(), provider: z.string().optional(), sessionId: z.string().optional(), disclosure: z.string().optional(),
  error: z.string().optional(), reading: ManuscriptReadingSchema.optional(),
}).strict();
export const ManuscriptReviewSchema = ManuscriptReviewTargetSchema.extend({
  version: z.literal(1), id: UlidSchema, title: z.string(), createdAt: z.string(), updatedAt: z.string(),
  brief: z.string().max(6000), context: z.string().max(64000), contextHash: z.string(), snapshotHash: z.string(),
  status: z.enum(["running", "complete", "partial", "cancelled", "interrupted"]),
  sources: z.array(z.object({ id: z.string(), title: z.string(), file: z.string(), hash: z.string(), words: z.number().int().nonnegative() }).strict()).max(1000),
  tasks: z.array(ManuscriptReviewTaskSchema).max(2001),
  synthesis: ManuscriptSynthesisSchema.optional(),
  findings: z.array(ManuscriptFindingSchema).max(60),
  previousId: UlidSchema.optional(), notRaisedAgain: z.number().int().nonnegative().default(0),
  stale: z.boolean().default(false), staleReasons: z.array(z.string()).default([]), rejectedCitations: z.number().int().nonnegative().default(0),
}).strict();
export type ManuscriptReview = z.infer<typeof ManuscriptReviewSchema>;
export type ManuscriptReviewTask = z.infer<typeof ManuscriptReviewTaskSchema>;
export const ManuscriptReviewHistorySchema = z.array(ManuscriptReviewSchema.pick({ id: true, title: true, createdAt: true, status: true })).max(1000);
export type ManuscriptReviewHistory = z.infer<typeof ManuscriptReviewHistorySchema>;

export function manuscriptReviewCoverage(review: ManuscriptReview) {
  const readings = review.tasks.filter(task => task.kind === "reading");
  const complete = readings.filter(task => task.state === "complete");
  return { stages: complete.length, totalStages: readings.length,
    chapters: review.sources.filter(source => { const parts = readings.filter(task => task.chapterId === source.id); return parts.length > 0 && parts.every(task => task.state === "complete"); }).length,
    totalChapters: review.sources.length, words: review.sources.reduce((sum, source) => sum + source.words, 0) };
}
