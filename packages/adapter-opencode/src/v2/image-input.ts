import type { SendMessageInput } from "@arke-studio/contracts";
import { modelEnabled, modelMetadata, type WireModel } from "../model-metadata.js";

export interface SessionImageInput { supported: boolean; provider: string; local: boolean }

/** Native 2.0.26 states the actual Ollama endpoint on its resolved model row. An Ollama
 * name alone does not establish locality: a user can configure a remote server. */
export function sessionImageInput(row: WireModel | null, provider: string): SessionImageInput {
  let local = false;
  if (row?.providerID === "ollama" && row.package === "@opencode/ai/providers/openai-compatible" && row.settings?.baseURL) {
    try {
      const url = new URL(row.settings.baseURL);
      local = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    } catch { /* An unknown endpoint follows cloud disclosure and policy. */ }
  }
  return { supported: row !== null && modelEnabled(row) && modelMetadata(row).inputModalities?.includes("image") === true,
    provider, local };
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
