import { z } from "zod";
import { AudioTranscriptComparisonSchema } from "./audio.js";
import { ArtifactIdSchema, SlugSchema } from "./ids.js";

/** Local wording evidence for the current take; never a generation flag or acoustic timing. */
export const AudiobookWordsRowSchema = z.object({
  chapterId: SlugSchema,
  chapterTitle: z.string(),
  key: z.string().min(1),
  label: z.string(),
  artifactId: ArtifactIdSchema.optional(),
  text: z.string(),
  comparison: AudioTranscriptComparisonSchema.optional(),
  reason: z.string().optional(),
}).strict();
export type AudiobookWordsRow = z.infer<typeof AudiobookWordsRowSchema>;

export const AudiobookWordsStateSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  running: z.boolean(),
  runningRequestId: z.string().optional(),
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  chapters: z.array(SlugSchema),
  rows: z.array(AudiobookWordsRowSchema),
}).strict();
export type AudiobookWordsState = z.infer<typeof AudiobookWordsStateSchema>;

/** Presentation of saved-take text evidence only, never a take acceptance or timing verdict.
 * Keep numbers, symbols, contractions and possible initialisms conservative. */
export function audiobookWording(authored: string, observed: string): "match" | "formatting" | "review" {
  const plain = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const a = plain(authored), b = plain(observed);
  if (a === b) return "match";
  const capitals = (value: string) => (value.match(/(?<!\p{L})\p{Lu}{2,}(?!\p{L})/gu) ?? []).join(" ");
  if (capitals(a) !== capitals(b)) return "review";
  const wording = (value: string) => value.replace(/[‘’]/g, "'")
    .replace(/(?<=\p{L})[-‐‑](?=\p{L})/gu, " ")
    .replace(/[“”"()[\]{}·…]/g, " ")
    .replace(/[.,:;!?](?!\d)/g, " ")
    .replace(/(^|\s)'|'(?=\s|$)/g, "$1")
    .toLocaleLowerCase("en").trim().replace(/\s+/gu, " ");
  const words = wording(a);
  return words.length > 0 && words === wording(b) ? "formatting" : "review";
}

export function audiobookWordsCounts(rows: readonly AudiobookWordsRow[]) {
  return rows.reduce((counts, row) => {
    if (row.comparison?.status === "compared") {
      counts.compared++;
      if (audiobookWording(row.text, row.comparison.observedText) !== "review") counts.match++; else counts.differ++;
    } else if (row.reason !== undefined || row.comparison?.status === "unavailable") counts.unavailable++;
    else counts.unchecked++;
    return counts;
  }, { compared: 0, match: 0, differ: 0, unavailable: 0, unchecked: 0 });
}
