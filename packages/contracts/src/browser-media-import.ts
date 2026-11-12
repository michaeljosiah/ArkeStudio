import { z } from "zod";

/** Leaves headroom below the authenticated WebSocket's 100 MiB frame ceiling. */
export const BROWSER_MEDIA_IMPORT_MAX_BYTES = 48 * 1024 * 1024;
export const BROWSER_MEDIA_IMPORT_MAX_FILES = 16;
export const BROWSER_MEDIA_IMPORT_LIMIT_MESSAGE = "Import up to 16 files totalling 48 MB in the browser. Use the desktop app for larger files.";

/** A leaf filename on every host, including Windows; it never selects a host path. */
export const BrowserMediaNameSchema = z.string().min(1).max(180).refine(name =>
  !/[<>:"/\\|?*]/.test(name) && !Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !/[. ]$/.test(name) &&
  name !== "." && name !== ".." && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name),
"Choose a file with a shorter name containing no path or reserved characters.");

export function browserMediaDecodedSize(data: string): number {
  return data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

export const BrowserMediaFileSchema = z.object({
  name: BrowserMediaNameSchema,
  data: z.string().min(4).max(4 * Math.ceil(BROWSER_MEDIA_IMPORT_MAX_BYTES / 3))
    .regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(data => data.length % 4 === 0),
}).strict();

export const BrowserMediaFilesSchema = z.array(BrowserMediaFileSchema).max(BROWSER_MEDIA_IMPORT_MAX_FILES)
  .refine(files => files.reduce((sum, file) => sum + browserMediaDecodedSize(file.data), 0) <= BROWSER_MEDIA_IMPORT_MAX_BYTES,
    BROWSER_MEDIA_IMPORT_LIMIT_MESSAGE);
export type BrowserMediaFile = z.infer<typeof BrowserMediaFileSchema>;

export function browserMediaSelectionProblem(files: readonly { name: string; size: number }[]): string | null {
  if (files.length > BROWSER_MEDIA_IMPORT_MAX_FILES || files.reduce((sum, file) => sum + file.size, 0) > BROWSER_MEDIA_IMPORT_MAX_BYTES)
    return BROWSER_MEDIA_IMPORT_LIMIT_MESSAGE;
  for (const file of files) {
    if (!BrowserMediaNameSchema.safeParse(file.name).success) return `${file.name}: choose a shorter filename with no path or reserved characters.`;
    if (!Number.isSafeInteger(file.size) || file.size <= 0) return `${file.name}: choose a non-empty file.`;
  }
  return null;
}
