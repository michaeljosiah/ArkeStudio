import { z } from "zod";

export const CHAPTER_REVIEW_VERSION = 1;
export const ChapterReviewTargetSchema = z.object({
  worldId: z.string().min(1).max(100), productionId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  chapterId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
}).strict();
export type ChapterReviewTarget = z.infer<typeof ChapterReviewTargetSchema>;
export const ReviewCertaintySchema = z.enum(["contradiction", "possible-confusion", "cannot-assess"]);
export const ChapterReviewDecisionSchema = z.enum(["open", "intentional", "dismissed"]);
export const ReviewFindingDraftSchema = z.object({
  category: z.enum(["clarity", "continuity", "image", "narration"]),
  certainty: ReviewCertaintySchema,
  quote: z.string().min(1).max(1200),
  imageBlocks: z.array(z.string().max(100)).max(5),
  observation: z.string().min(1).max(1600), impact: z.string().min(1).max(1000),
  correction: z.string().min(1).max(1600),
}).strict();
export const ReviewFactSchema = z.object({ quote: z.string().min(1).max(1200),
  claim: z.string().min(1).max(800), kind: z.enum(["explicit", "inferred", "intentional-uncertainty"]) }).strict();
export const ReviewAnswerSchema = z.object({
  facts: z.array(ReviewFactSchema).max(40), findings: z.array(ReviewFindingDraftSchema).max(20),
}).strict();
export type ReviewAnswer = z.infer<typeof ReviewAnswerSchema>;
export const ReviewImageSchema = z.object({ block: z.string(), file: z.string(), hash: z.string(),
  textHash: z.string().optional(), error: z.string().optional() }).strict();
export const ReviewTaskSchema = z.object({ id: z.string(), specialist: z.enum(["script", "visual", "narration"]),
  state: z.enum(["pending", "running", "complete", "failed", "unavailable", "cancelled"]),
  images: z.array(z.string()), model: z.string().optional(), sessionId: z.string().optional(),
  provider: z.string().optional(), disclosure: z.string().optional(), detail: z.string().optional(),
  skill: z.string(), completedAt: z.string().optional(),
}).strict();
export const ChapterReviewSchema = ChapterReviewTargetSchema.extend({
  schemaVersion: z.literal(CHAPTER_REVIEW_VERSION), requestId: z.string().min(1).max(200), id: z.string().uuid(), title: z.string(),
  createdAt: z.string(), updatedAt: z.string(), status: z.enum(["running", "complete", "partial", "cancelled", "interrupted"]),
  sourceHash: z.string(), contextHash: z.string(), body: z.string().max(60000),
  images: z.array(ReviewImageSchema).max(60), tasks: z.array(ReviewTaskSchema).max(30),
  facts: z.array(ReviewFactSchema).max(40),
  findings: z.array(ReviewFindingDraftSchema.extend({ id: z.string().uuid(), taskId: z.string(), offset: z.number().int().nonnegative(),
    decision: ChapterReviewDecisionSchema, decisionNote: z.string().max(1000).optional() }).strict()).max(500),
  checks: z.array(z.string().max(1000)).max(150), rejectedFindings: z.number().int().nonnegative(),
  stale: z.boolean().default(false), staleReasons: z.array(z.string()).default([]),
  audioListened: z.literal(false),
}).strict();
export type ChapterReview = z.infer<typeof ChapterReviewSchema>;
export type ReviewTask = z.infer<typeof ReviewTaskSchema>;

/** A model cannot manufacture source citations or claim to have seen an unsupplied image. */
export function verifiedReviewAnswer(body: string, answer: ReviewAnswer, suppliedImages: readonly string[]) {
  // These model tasks receive neither audio nor compiled voice requests. Narration stays in
  // the deterministic record audit; a different category cannot evade visual citations.
  const findings = answer.findings.filter(f => body.includes(f.quote) && f.category !== "narration" &&
    f.imageBlocks.every(id => suppliedImages.includes(id)) &&
    ((suppliedImages.length === 0 && f.category !== "image") || f.imageBlocks.length > 0));
  const facts = answer.facts.filter(f => body.includes(f.quote));
  return { findings, facts, rejected: answer.findings.length - findings.length + answer.facts.length - facts.length };
}
export function chapterReviewKey(target: ChapterReviewTarget): string {
  return `${target.worldId}/${target.productionId}/${target.chapterId}`;
}

/** Keep chat receipts within their wire limit; the complete evidence remains in the review. */
export function chapterReviewSummary(review: Pick<ChapterReview, "status" | "findings" | "stale">): string {
  const head = `${review.status}${review.stale ? " (source check needed)" : ""}: ${review.findings.length} findings. `;
  const tail = " Open Chapter review for evidence and full coverage. Audio not listened to.";
  const observations = review.findings.slice(0, 5).map(f => f.observation).join(" ");
  const room = 2000 - head.length - tail.length;
  return head + (observations.length > room ? observations.slice(0, room - 1) + "…" : observations) + tail;
}
