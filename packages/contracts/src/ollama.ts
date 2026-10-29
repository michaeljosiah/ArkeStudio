import { z } from "zod";

/** An existing local service is used only after an explicit Settings choice. */
export function normalizeOllamaUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) return null;
    return url.origin;
  } catch { return null; }
}

export const OllamaSettingsSchema = z.object({
  engineUrl: z.string().min(1).max(2000).refine(value => normalizeOllamaUrl(value) !== null).nullable().default(null),
  modelsDir: z.string().min(1).nullable().default(null),
}).strict();
export type OllamaSettings = z.infer<typeof OllamaSettingsSchema>;

export const OllamaRuntimeStatusSchema = z.object({
  source: z.enum(["managed", "user-url"]),
  state: z.enum(["absent", "starting", "ready", "failed", "stopped"]),
  url: z.string().nullable(),
  version: z.string().nullable(),
  detail: z.string().nullable(),
}).strict();
export type OllamaRuntimeStatus = z.infer<typeof OllamaRuntimeStatusSchema>;
