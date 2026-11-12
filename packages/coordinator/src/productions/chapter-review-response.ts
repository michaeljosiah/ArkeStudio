import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { ChapterReviewTargetSchema, ReviewAnswerSchema, type ChapterReview, type ReviewTask } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { atomicWriteFile } from "../world/atomic.js";
import { containedWorldFilePath } from "../world/contained-file.js";

// Separate from report events/journal payloads. At most two completed turns per task.
const RAW_LIMIT = 256 * 1024, FILE_LIMIT = 4 * 1024 * 1024;
const ResponseSchema = z.object({
  reviewId: z.string().uuid(), requestId: z.string(), taskId: z.string(), inputHash: z.string(),
  sessionId: z.string().optional(), model: z.string().optional(), provider: z.string().optional(),
  reusedFrom: z.string().uuid().optional(),
  responses: z.array(z.object({ text: z.string().max(RAW_LIMIT), truncated: z.boolean(), at: z.string() }).strict()).max(2),
  answer: ReviewAnswerSchema.optional(),
}).strict();
export type ChapterReviewResponse = z.infer<typeof ResponseSchema>;
const responsePath = (review: ChapterReview, task: ReviewTask) => {
  ChapterReviewTargetSchema.parse({ worldId: review.worldId, productionId: review.productionId, chapterId: review.chapterId });
  z.string().uuid().parse(review.id);
  if (!/^(script|prose|consolidation|visual-\d+|verify-\d+)$/.test(task.id)) throw new Error("Invalid review task identity.");
  return `productions/${review.productionId}/.reviews/chapters/${review.chapterId}/${review.id}.responses/${task.id}.json`;
};
export function newChapterReviewResponse(review: ChapterReview, task: ReviewTask): ChapterReviewResponse {
  return { reviewId: review.id, requestId: review.requestId, taskId: task.id, inputHash: task.inputHash!, responses: [],
    sessionId: task.sessionId, model: task.model, provider: task.provider, reusedFrom: task.reusedFrom };
}
export function retainCompletedResponse(record: ChapterReviewResponse, text: string) {
  record.responses.push({ text: text.slice(0, RAW_LIMIT), truncated: text.length > RAW_LIMIT, at: new Date().toISOString() });
}
export async function saveChapterReviewResponse(store: WorldStore, review: ChapterReview, task: ReviewTask, record: ChapterReviewResponse) {
  if (store.worldId !== review.worldId) throw new Error("Wrong review world.");
  const json = JSON.stringify(ResponseSchema.parse(record));
  if (Buffer.byteLength(json) > FILE_LIMIT) throw new Error("Review response exceeds the retained-response storage limit.");
  await store.ownedWrite(async () => atomicWriteFile(await containedWorldFilePath(store.dir, responsePath(review, task), true), json));
}
export async function readChapterReviewResponse(store: WorldStore, review: ChapterReview, task: ReviewTask) {
  if (store.worldId !== review.worldId) throw new Error("Wrong review world.");
  const path = await containedWorldFilePath(store.dir, responsePath(review, task));
  if ((await stat(path)).size > FILE_LIMIT) throw new Error("Saved review response is too large.");
  const result = ResponseSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (result.reviewId !== review.id || result.requestId !== review.requestId || result.taskId !== task.id || result.inputHash !== task.inputHash)
    throw new Error("Saved review response identity does not match.");
  if (!result.answer) throw new Error("Completed task has no reusable answer. Start a new review.");
  return result;
}
