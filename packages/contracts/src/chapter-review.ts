import { z } from "zod";
import { PictureShotSchema } from "./audiobook-illustrate.js";

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
  imageBlocks: z.array(z.string().max(100)).max(5).default([]),
  observation: z.string().min(1).max(1600), impact: z.string().min(1).max(1000),
  correction: z.string().min(1).max(1600),
}).strict();
export const ReviewFactSchema = z.object({ quote: z.string().min(1).max(1200),
  claim: z.string().min(1).max(800), kind: z.enum(["explicit", "inferred", "intentional-uncertainty"]) }).strict();
export const ReviewAssessmentSchema = z.object({
  findingId: z.string().uuid(), verdict: z.enum(["supported", "uncertain", "rejected"]),
  subject: z.string().min(1).max(300), rationale: z.string().min(1).max(1600),
}).strict();
export const ReviewGroupSchema = z.object({
  representativeId: z.string().uuid(), memberIds: z.array(z.string().uuid()).min(2).max(60),
  rationale: z.string().min(1).max(1000),
}).strict();
export const ReviewAnswerSchema = z.object({
  facts: z.array(ReviewFactSchema).max(40), findings: z.array(ReviewFindingDraftSchema).max(20),
  assessments: z.array(ReviewAssessmentSchema).max(20).optional(),
  groups: z.array(ReviewGroupSchema).max(200).optional(),
}).strict();
export type ReviewAnswer = z.infer<typeof ReviewAnswerSchema>;
export const ReviewImageSchema = z.object({ block: z.string(), file: z.string(), hash: z.string(),
  shot: PictureShotSchema.optional(), textHash: z.string().optional(), error: z.string().optional() }).strict();
export const ReviewCandidateSchema = ReviewFindingDraftSchema.extend({
  id: z.string().uuid(), taskId: z.string(), offset: z.number().int().nonnegative(),
}).strict();
export const ReviewTaskSchema = z.object({ id: z.string(), specialist: z.enum(["script", "visual", "verification", "consolidation", "narration"]),
  state: z.enum(["pending", "running", "complete", "failed", "unavailable", "cancelled"]),
  images: z.array(z.string()), model: z.string().optional(), sessionId: z.string().optional(),
  provider: z.string().optional(), disclosure: z.string().optional(), detail: z.string().optional(),
  skill: z.string(), completedAt: z.string().optional(),
}).strict();
export const ChapterReviewSchema = ChapterReviewTargetSchema.extend({
  schemaVersion: z.literal(CHAPTER_REVIEW_VERSION), requestId: z.string().min(1).max(200), id: z.string().uuid(), title: z.string(),
  createdAt: z.string(), updatedAt: z.string(), status: z.enum(["running", "complete", "partial", "cancelled", "interrupted"]),
  sourceHash: z.string(), contextHash: z.string(), body: z.string().max(60000),
  images: z.array(ReviewImageSchema).max(60), tasks: z.array(ReviewTaskSchema).max(64),
  facts: z.array(ReviewFactSchema).max(40),
  findings: z.array(ReviewFindingDraftSchema.extend({ id: z.string().uuid(), taskId: z.string(), offset: z.number().int().nonnegative(),
    decision: ChapterReviewDecisionSchema, decisionNote: z.string().max(1000).optional() }).strict()).max(500),
  candidates: z.array(ReviewCandidateSchema).max(500).optional(),
  assessments: z.array(ReviewAssessmentSchema.extend({ taskId: z.string() })).max(500).optional(),
  groups: z.array(ReviewGroupSchema).max(200).optional(),
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

/** Decisions and deduplication belong to the whole finding, including its recommended change. */
export function sameReviewFinding(a: z.infer<typeof ReviewFindingDraftSchema>, b: z.infer<typeof ReviewFindingDraftSchema>): boolean {
  return a.category === b.category && a.certainty === b.certainty && a.quote === b.quote &&
    a.observation === b.observation && a.impact === b.impact && a.correction === b.correction &&
    a.imageBlocks.length === b.imageBlocks.length && a.imageBlocks.every((id, index) => id === b.imageBlocks[index]);
}

/** Compare the pinned source versions, never a fresh read that may describe a different edit. */
export function sameChapterReviewSource(a: Pick<ChapterReview, "sourceHash" | "contextHash" | "images">,
  b: Pick<ChapterReview, "sourceHash" | "contextHash" | "images">): boolean {
  return a.sourceHash === b.sourceHash && a.contextHash === b.contextHash && JSON.stringify(a.images) === JSON.stringify(b.images);
}

/** An incomplete or invented audit must not silently drop a candidate. */
export function validateReviewAssessments(candidates: readonly z.infer<typeof ReviewCandidateSchema>[], answer: ReviewAnswer) {
  const assessments = answer.assessments;
  if (!assessments || assessments.length !== candidates.length || new Set(assessments.map(a => a.findingId)).size !== candidates.length ||
    assessments.some(a => !candidates.some(c => c.id === a.findingId))) throw new Error("Evidence check did not assess every candidate exactly once.");
  return assessments;
}

/** Models propose semantic groups; the coordinator preserves originals and refuses unsafe membership. */
export function validateReviewGroups(findings: ChapterReview["findings"], answer: ReviewAnswer) {
  if (!answer.groups) throw new Error("Consolidation did not return groups.");
  const used = new Set<string>();
  for (const group of answer.groups) {
    const representative = findings.find(f => f.id === group.representativeId);
    if (!representative || !group.memberIds.includes(group.representativeId)) throw new Error("Unknown group representative.");
    for (const id of group.memberIds) {
      const member = findings.find(f => f.id === id);
      // Never coalesce different images or certainty classes on a semantic guess. Distinct
      // defects in the same image still require the model's explicit same-correction judgment.
      if (!member || used.has(id) || member.category !== representative.category || member.certainty !== representative.certainty ||
        JSON.stringify([...member.imageBlocks].sort()) !== JSON.stringify([...representative.imageBlocks].sort()))
        throw new Error("Invalid, overlapping or incompatible duplicate group.");
      used.add(id);
    }
  }
  return answer.groups;
}
