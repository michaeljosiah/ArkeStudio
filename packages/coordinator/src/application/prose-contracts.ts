import { z } from "zod";
import { SlugSchema } from "@arke-studio/contracts";

// IDs name records, never host paths. The local adapter maps canonical IDs to scanned filenames.
export const proseId = SlugSchema;
const title = z.string().min(1).max(200).refine(value => value.trim().length > 0);
const mutation = { operationId: z.string().min(1).max(500).refine(value => value.trim().length > 0),
  expectedRevision: z.string().min(1).optional() };
export const proseProductionInput = z.object({ ...mutation, title, logline: z.string().max(2000).optional() }).strict();
export const proseChapterInput = z.object({ ...mutation, title, order: z.number().int().min(1).max(1000000) }).strict();
export const proseSaveInput = z.object({ ...mutation, body: z.string().max(2000000),
  baseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
export const proseProductionResult = z.object({ productionId: proseId }).strict();
export const proseChapterResult = z.object({ productionId: proseId, chapterId: proseId }).strict();
export const proseSaveResult = proseChapterResult.extend({ version: z.number().int().min(1),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
export const proseChapterRead = proseSaveResult.extend({ title: z.string(), order: z.number(), body: z.string(),
  versions: z.array(z.number().int().min(1)) }).strict();
export const proseManuscript = z.object({ productionId: proseId, title: z.string(),
  contentType: z.literal("text/markdown; charset=utf-8"), markdown: z.string(),
  chapters: z.array(proseSaveResult).min(1) }).strict();
export type ProseManuscript = z.infer<typeof proseManuscript>;

export type ProseProductionInput = z.infer<typeof proseProductionInput>;
export type ProseChapterInput = z.infer<typeof proseChapterInput>;
export type ProseSaveInput = z.infer<typeof proseSaveInput>;
export type ProseProductionResult = z.infer<typeof proseProductionResult>;
export type ProseChapterResult = z.infer<typeof proseChapterResult>;
export type ProseSaveResult = z.infer<typeof proseSaveResult>;
export type ProseChapterRead = z.infer<typeof proseChapterRead>;

/** Direct authoring only (SPEC-012 R-5); generated drafts must use proposal acceptance. */
export interface EngineProseSession {
  createProduction(input: ProseProductionInput, operationKey: string): Promise<ProseProductionResult>;
  createChapter(productionId: string, input: ProseChapterInput, operationKey: string): Promise<ProseChapterResult>;
  readChapter(productionId: string, chapterId: string): Promise<ProseChapterRead>;
  saveChapter(productionId: string, chapterId: string, input: ProseSaveInput, operationKey: string): Promise<ProseSaveResult>;
  manuscript?(productionId: string): Promise<ProseManuscript>;
}
