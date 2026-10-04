import { z } from "zod";
import type { ModelInfo } from "./adapter.js";
import { providerModelId, type ManifestModel } from "./manifest.js";

export const HarnessModelStatusSchema = z.object({
  status: z.enum(["idle", "loading", "ready", "error"]),
  reason: z.string().optional(),
}).strict();
export type HarnessModelStatus = z.infer<typeof HarnessModelStatusSchema>;

/** Provider ids are owned by the harness and need not appear in the media manifest. */
export function harnessModelReference(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/** Writing needs text; Stage also needs images. Omitted metadata makes neither claim. */
export function harnessModelMissingInput(
  model: Pick<ModelInfo, "inputModalities">, needsImages = false,
): "text" | "image" | undefined {
  if (model.inputModalities === undefined) return undefined;
  if (!model.inputModalities.includes("text")) return "text";
  if (needsImages && !model.inputModalities.includes("image")) return "image";
  return undefined;
}

function names(model: ModelInfo): string[] {
  return [model.id, ...(model.aliases ?? [])];
}

export function harnessModelManifestEntry(
  model: ModelInfo, legacyModels: readonly ManifestModel[] = [],
): ManifestModel | undefined {
  return legacyModels.find((entry) => entry.capability === "llm" &&
    entry.provider === model.provider && names(model).includes(providerModelId(entry)));
}

/**
 * Read old manifest ids without making the manifest an admission gate. A provider-qualified
 * reference is exact; an unqualified alias is usable only when the live catalog is unambiguous.
 */
export function findHarnessModel(
  reference: string, models: readonly ModelInfo[], legacyModels: readonly ManifestModel[] = [],
): ModelInfo | undefined {
  const exact = models.filter((model) => harnessModelReference(model) === reference);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const direct = models.filter((model) =>
    names(model).some((name) => `${model.provider}/${name}` === reference));
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return undefined;
  const legacy = legacyModels.find((model) => model.id === reference);
  if (legacy) {
    if (legacy.capability !== "llm") return undefined;
    const matches = models.filter((model) => model.provider === legacy.provider &&
      names(model).includes(providerModelId(legacy)));
    return matches.length === 1 ? matches[0] : undefined;
  }
  // A missing qualified choice must not become another provider's slash-containing bare id.
  // Those ids remain selectable through their full provider/id reference.
  if (reference.includes("/")) return undefined;
  const matches = models.filter((model) => names(model).includes(reference));
  return matches.length === 1 ? matches[0] : undefined;
}

export function harnessModelDisabled(
  model: ModelInfo, disabledIds: readonly string[], legacyModels: readonly ManifestModel[] = [],
): boolean {
  const refs = names(model).map((name) => `${model.provider}/${name}`);
  // Bare ids in the existing disabled list belong to manifest entries, not arbitrary providers.
  const legacyIds = legacyModels.filter((entry) => entry.capability === "llm" &&
    entry.provider === model.provider && names(model).includes(providerModelId(entry))).map((entry) => entry.id);
  return disabledIds.some((id) => refs.includes(id) || legacyIds.includes(id));
}

/** The effort control's five plain words, lowest first (design turn 195). */
export const EFFORT_WORDS = ["Minimal", "Low", "Medium", "High", "Highest"] as const;

/** Each harness variant name, lowercased and unspaced, to the nearest plain word. */
const EFFORT_OF: Readonly<Record<string, (typeof EFFORT_WORDS)[number]>> = {
  none: "Minimal", minimal: "Minimal", low: "Low", medium: "Medium", default: "Medium",
  high: "High", xhigh: "Highest", max: "Highest", highest: "Highest",
};

/** `xhigh-plus` as it comes, for a variant Arke has no word for: `Xhigh Plus`. */
export function titleCaseVariant(name: string): string {
  return name.split(/[\s_-]+/).filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * The plain words for a model's variants, in the model's own order. Each name takes the nearest of
 * the five; two names that would take one word keep the order and the second is title-cased as it
 * came, so a menu never offers two rows with one name that mean different things; a name Arke does
 * not know is title-cased too.
 */
export function harnessEffortLabels(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const word = EFFORT_OF[name.toLowerCase().replace(/[\s_-]+/g, "")];
    if (word !== undefined && !taken.has(word)) {
      taken.add(word);
      return word;
    }
    return titleCaseVariant(name);
  });
}

/** One variant's plain word, in the context of its model's whole list. Undefined when the model lists no such variant. */
export function harnessEffortLabel(variants: NonNullable<ModelInfo["variants"]>, variant: string): string | undefined {
  const at = variants.names.indexOf(variant);
  return at === -1 ? undefined : harnessEffortLabels(variants.names)[at];
}
