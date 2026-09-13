import type { ModelInfo } from "@arke-studio/contracts";

/** The fields shared by the v1 provider listing and v2 model catalog. */
export interface WireModel {
  id?: string;
  providerID?: string;
  name?: string;
  status?: string;
  disabled?: boolean;
  enabled?: boolean;
  limit?: { context?: number; input?: number };
  capabilities?: { input?: string[] | { text?: boolean; image?: boolean } };
}

export function modelEnabled(model: WireModel): boolean {
  return model.disabled !== true && model.enabled !== false && model.status !== "deprecated";
}

export function modelMetadata(model: WireModel): Pick<ModelInfo, "displayName" | "inputModalities" | "inputTokenLimit"> {
  const input = model.capabilities?.input;
  const inputModalities = Array.isArray(input)
    ? input.filter((value): value is "text" | "image" => value === "text" || value === "image")
    : input && typeof input.text === "boolean" && typeof input.image === "boolean"
      ? (["text", "image"] as const).filter((value) => input[value])
      : undefined;
  const limit = model.limit?.input ?? model.limit?.context;
  return {
    ...(model.name ? { displayName: model.name } : {}),
    ...(inputModalities !== undefined ? { inputModalities } : {}),
    ...(typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? { inputTokenLimit: limit } : {}),
  };
}
