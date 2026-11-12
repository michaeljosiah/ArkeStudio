/** Qualified local readers. The upstream calls its 7.9B MoE model `tiny`. */
export const MING_MODELS = {
  "ming-3-0.5b": { variant: "dense", label: "Ming 3 · 0.5B", component: "ming-model-dense" },
  "ming-3-7.9b": { variant: "tiny", label: "Ming 3 · 7.9B (experimental)", component: "ming-model-tiny" },
} as const;
export type MingModel = keyof typeof MING_MODELS;
export function isMingModel(value: string): value is MingModel { return Object.hasOwn(MING_MODELS, value); }
export const MING_REQUEST_CHARS = 1200;
export const MING_CHUNK_CHARS = 240;
export const MING_REFERENCE_TEXT_CHARS = 4000;
export const MING_LANGUAGES: readonly string[] = ["en", "zh", "ja", "ko", "fr", "de", "es", "it", "pt", "ru"];
