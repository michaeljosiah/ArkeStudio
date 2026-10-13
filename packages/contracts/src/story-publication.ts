import { z } from "zod";
import { isManuscriptLanguage } from "./manuscript.js";
import { paragraphSpans } from "./prose.js";
import { SlugSchema, UlidSchema } from "./ids.js";

/** Turn 224, SPEC-048: author-approved source changes and private, frozen editions. */
const Text = z.string().max(512);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const StoryPublicationSettingsSchema = z.object({
  title: Text.refine(value => value.trim().length > 0, "Enter a title."),
  author: Text, language: z.string().refine(isManuscriptLanguage),
  description: z.string().max(4000), label: Text,
  cover: z.string().max(512).nullable(),
  chapterIds: z.array(SlugSchema).min(1).max(200).refine(ids => new Set(ids).size === ids.length),
  outputs: z.array(z.enum(["epub", "m4b"])).min(1).max(2).refine(values => new Set(values).size === values.length),
  avoidEmDashes: z.boolean(),
}).strict();
export type StoryPublicationSettings = z.infer<typeof StoryPublicationSettingsSchema>;

export const StoryStyleFindingSchema = z.object({
  id: Hash, chapterId: SlugSchema, chapterTitle: Text, chapterFile: SlugSchema,
  baseHash: z.string(), paragraph: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
  before: z.string().max(1_000_000), suggestion: z.string().max(1_000_000),
  reason: z.string(), narration: z.array(z.string()), kept: z.boolean(),
}).strict();
export type StoryStyleFinding = z.infer<typeof StoryStyleFindingSchema>;
export const StoryPublicationReviewSchema = z.object({
  fingerprint: Hash, settings: StoryPublicationSettingsSchema,
  chapters: z.array(z.object({ id: SlugSchema, title: Text, words: z.number(), audioProblems: z.array(z.string()) }).strict()),
  findings: z.array(StoryStyleFindingSchema),
  blockers: z.array(z.string()), warnings: z.array(z.string()),
}).strict();
export type StoryPublicationReview = z.infer<typeof StoryPublicationReviewSchema>;
export const StoryEditionSchema = z.object({
  id: z.string().uuid(), worldId: UlidSchema, productionId: SlugSchema,
  createdAt: z.string(), settings: StoryPublicationSettingsSchema, fingerprint: Hash,
  status: z.enum(["preview", "creating", "ready", "failed", "cancelled"]),
  phase: z.string(), error: z.string().optional(),
  files: z.array(z.object({ format: z.enum(["epub", "m4b"]), name: z.string(), bytes: z.number().int().nonnegative(), sha256: Hash }).strict()),
}).strict();
export type StoryEdition = z.infer<typeof StoryEditionSchema>;
export const StoryPublishActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), settings: StoryPublicationSettingsSchema }).strict(),
  z.object({ action: z.literal("decide"), settings: StoryPublicationSettingsSchema, finding: StoryStyleFindingSchema, decision: z.enum(["apply", "keep"]), replacement: z.string().min(1).max(1_000_000) }).strict(),
  z.object({ action: z.literal("preview"), settings: StoryPublicationSettingsSchema, fingerprint: Hash }).strict(),
  z.object({ action: z.literal("create"), editionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("preview-page"), editionId: z.string().uuid(), chapter: z.number().int().min(0).max(199) }).strict(),
  z.object({ action: z.literal("retry"), editionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("cancel"), editionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("list") }).strict(),
]);
export type StoryPublishAction = z.infer<typeof StoryPublishActionSchema>;
export const StoryPublishResultSchema = z.object({
  preview: z.object({ html: z.string().max(4_000_000), chapter: z.number().int(), count: z.number().int().positive() }).strict().optional(),
  review: StoryPublicationReviewSchema.optional(),
  edition: StoryEditionSchema.optional(),
  editions: z.array(StoryEditionSchema).optional(),
  settings: StoryPublicationSettingsSchema.optional(),
  error: z.string().optional(),
}).strict();
export type StoryPublishResult = z.infer<typeof StoryPublishResultSchema>;

/** Off by default. An em dash is valid book text; this is an optional editorial preference. */
export function emDashSuggestions(body: string): Array<{ paragraph: number; start: number; end: number; before: string; suggestion: string; reason: string }> {
  const findings: ReturnType<typeof emDashSuggestions> = [];
  let paragraph = 0;
  for (const span of paragraphSpans(body)) {
    const before = body.slice(span.start, span.end), start = span.start;
    if (before.includes("—")) {
      // Keep interrupted speech unchanged. The author can enter and review a replacement.
      const interrupted = /—[”"'’]?\s*$/.test(before);
      const paired = (before.match(/—/g) ?? []).length === 2;
      const suggestion = interrupted ? before : paired
        ? before.replace(/\s*—\s*/, " (").replace(/\s*—\s*/, ") ")
        : before.replace(/\s*—\s*/, ", ");
      findings.push({ paragraph, start, end: start + before.length, before, suggestion,
        reason: interrupted ? "This may be interrupted speech. Keep it or write a replacement." : paired ? "Consider parentheses around this aside. Review the meaning before applying." : "Consider a comma or a new sentence. Review the meaning before applying." });
    }
    paragraph++;
  }
  return findings;
}

/** XML forbids these code points. Refuse lossy text instead of silently dropping it at publish. */
export function publicationTextProblems(text: string): string[] {
  const problems: string[] = [];
  if ([...text].some(char => { const code = char.codePointAt(0)!; return (code < 32 && ![9, 10, 13].includes(code)) || code === 0xfffe || code === 0xffff || (code >= 0xd800 && code <= 0xdfff); })) problems.push("Text contains characters that cannot be represented in EPUB.");
  if (/^(?:#{1,6}\s|>\s|\s*[-+]\s|\s*\*\s+(?!\*)|\s*\d+[.)]\s|\s*```)/m.test(text) || /!?\[[^\]]*\]\([^)]+\)/.test(text)) problems.push("Headings, lists, quotations, links or code inside prose need review in the manuscript; this book format preserves paragraphs, emphasis and scene breaks.");
  return problems;
}
