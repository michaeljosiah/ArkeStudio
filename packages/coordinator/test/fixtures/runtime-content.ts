import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { OLLAMA_VERSION } from "../../src/setup/catalogue.js";
import type { RuntimeContentPin } from "../../src/local-ai/runtime-content.js";

let pin: Promise<RuntimeContentPin> | undefined;
/** Explicit synthetic-provider pin, never the production Ollama archive's provenance. */
export function nodeRuntimeContentPin(): Promise<RuntimeContentPin> {
  return pin ??= (async () => {
    const hash = createHash("sha256"); for await (const chunk of createReadStream(process.execPath)) hash.update(chunk);
    return { version: OLLAMA_VERSION, arch: process.arch, archiveSha256: "0".repeat(64),
      files: [{ path: "ollama.exe", bytes: (await stat(process.execPath)).size, sha256: hash.digest("hex") }] };
  })();
}
