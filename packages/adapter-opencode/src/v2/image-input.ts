import type { SendMessageInput } from "@arke-studio/contracts";
import { modelEnabled, modelMetadata, type WireModel } from "../model-metadata.js";

export interface SessionImageInput { supported: boolean; provider: string; local: boolean }

/** Capability is independent of locality. A loopback Ollama server can relay cloud models. */
export function sessionImageInput(row: WireModel | null, provider: string): SessionImageInput {
  return { supported: row !== null && modelEnabled(row) && modelMetadata(row).inputModalities?.includes("image") === true,
    provider, local: false };
}

/** Only the measured native Ollama route admits a read-only model metadata check. */
export function localOllamaModelEndpoint(row: WireModel): URL | null {
  if (row.providerID !== "ollama" || row.package !== "@opencode/ai/providers/openai-compatible" || !row.settings?.baseURL || !row.id) return null;
  try {
    const url = new URL(row.settings.baseURL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase()) || !/\/v1\/?$/.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/v1\/?$/, "/api/show");
    return url;
  } catch { return null; }
}

/** No inference or image bytes. Local model_info must be present and upstream routing absent;
 * cloud aliases can have ordinary names, so a suffix is never positive local evidence.
 * https://github.com/ollama/ollama/blob/main/api/types.go (ShowResponse). */
export async function qualifySessionImageInput(row: WireModel | null, provider: string, signal: AbortSignal): Promise<SessionImageInput> {
  const image = sessionImageInput(row, provider), endpoint = row ? localOllamaModelEndpoint(row) : null;
  if (!image.supported || !endpoint) return image;
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: row!.id, verbose: false }), redirect: "error", signal });
    if (!response.ok || !response.body) { await response.body?.cancel(); return image; }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) { await reader.cancel(); return image; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const model = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const architecture = model?.model_info?.["general.architecture"];
    const remote = (model?.remote_host !== undefined && model.remote_host !== "") ||
      (model?.remote_model !== undefined && model.remote_model !== "");
    return { ...image, local: !remote && typeof architecture === "string" && architecture.trim().length > 0 };
  } catch { return image; }
}

/** Coordinator-owned PNG renditions travel inline; no world path or temporary file crosses
 * the adapter. The native files grammar is distinct from the shared message-parts grammar. */
export function imagePrompt(parts: SendMessageInput["parts"]) {
  const text = parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  let index = 0;
  const files = parts.flatMap(part => part.type === "image"
    ? [{ uri: `data:${part.mimeType};base64,${part.data}`, name: `arke-image-${++index}.png` }] : []);
  return { text, ...(files.length ? { files } : {}) };
}
