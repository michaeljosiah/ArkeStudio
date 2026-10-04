import type { ModelInfo } from "@arke-studio/contracts";

/** What a million tokens cost, with whatever else the row carries (the cache's price, a long-context tier). */
type WireCost = { input?: number; output?: number; [other: string]: unknown };

/** The fields shared by the v1 provider listing and v2 model catalog. */
export interface WireModel {
  id?: string;
  providerID?: string;
  name?: string;
  status?: string;
  disabled?: boolean;
  enabled?: boolean;
  limit?: { context?: number; input?: number };
  capabilities?: { tools?: boolean; reasoning?: boolean; input?: string[] | Record<string, boolean | undefined> };
  /** v1 states reasoning on the model itself as well as under `capabilities`. */
  reasoning?: boolean;
  /**
   * The efforts the model offers. v1 keys them by name, in the order its provider lists them
   * (`{ low: {…}, high: {…} }`, measured against 1.18.34); a catalogue that lists them instead
   * gives names or rows carrying one.
   */
  variants?: Record<string, unknown> | Array<string | { id?: string; name?: string }>;
  /** USD per million tokens. A row of tiers is read by its first. */
  cost?: WireCost | WireCost[];
  /** The provider's own name, where the row carries one. */
  providerName?: string;
  provider?: { name?: string };
}

export function modelEnabled(model: WireModel): boolean {
  return model.disabled !== true && model.enabled !== false && model.status !== "deprecated";
}

/**
 * The variant names a model offers, in its order. A variant a configuration switched off
 * (`disabled: true`) is not offered, and a duplicate name is offered once.
 */
export function modelVariants(model: WireModel): ModelInfo["variants"] {
  const raw = model.variants;
  const names: string[] = [];
  if (Array.isArray(raw)) {
    for (const row of raw) {
      const name = typeof row === "string" ? row : row?.id ?? row?.name;
      if (typeof name === "string" && name !== "") names.push(name);
    }
  } else if (raw !== null && typeof raw === "object") {
    for (const [name, row] of Object.entries(raw)) {
      if (name === "" || (row !== null && typeof row === "object" && (row as { disabled?: unknown }).disabled === true)) continue;
      names.push(name);
    }
  }
  const unique = [...new Set(names)];
  return unique.length > 0 ? { names: unique } : undefined;
}

function modelCost(model: WireModel): ModelInfo["cost"] {
  const row = Array.isArray(model.cost) ? model.cost[0] : model.cost;
  const input = row?.input;
  const output = row?.output;
  return typeof input === "number" && Number.isFinite(input) && input >= 0 && typeof output === "number" && Number.isFinite(output) && output >= 0
    ? { inputPerMTok: input, outputPerMTok: output } : undefined;
}

/** The provider's name as the harness states it, for the picker's group headings. */
export function providerNameOf(model: WireModel): string | undefined {
  const name = model.providerName ?? model.provider?.name;
  return typeof name === "string" && name !== "" ? name : undefined;
}

export function modelMetadata(model: WireModel): Pick<ModelInfo, "displayName" | "inputModalities" | "inputTokenLimit" | "tools" | "reasoning" | "variants" | "cost"> {
  const input = model.capabilities?.input;
  const inputModalities = Array.isArray(input)
    ? input.filter((value): value is "text" | "image" => value === "text" || value === "image")
    // Sparse compatible catalogs still supply evidence. Preserve their explicit true
    // values; false-only evidence must not become an unknown, unrestricted model.
    : input && Object.values(input).some(value => typeof value === "boolean")
      ? (["text", "image"] as const).filter((value) => input[value] === true)
      : undefined;
  const limit = model.limit?.input ?? model.limit?.context;
  const reasoning = typeof model.reasoning === "boolean" ? model.reasoning : model.capabilities?.reasoning;
  const variants = modelVariants(model);
  const cost = modelCost(model);
  return {
    ...(model.name ? { displayName: model.name } : {}),
    ...(inputModalities !== undefined ? { inputModalities } : {}),
    // Stated either way or not at all: the local profile writes `tools: false` for a model the
    // runtime says cannot call them, and a default chosen without a reader must not land there.
    ...(typeof model.capabilities?.tools === "boolean" ? { tools: model.capabilities.tools } : {}),
    ...(typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? { inputTokenLimit: limit } : {}),
    // Stated or absent, like tools: a model the harness says nothing of reasoning for is not one that cannot.
    ...(typeof reasoning === "boolean" ? { reasoning } : {}),
    ...(variants !== undefined ? { variants } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}
