import { createHash } from "node:crypto";

/** Recording, reference words and language all condition speech and its queued/cache identity. */
export function mingReferenceHash(reference: {data: Uint8Array; transcript?: string; language?: string}): string {
  const audio = createHash("sha256").update(reference.data).digest("hex");
  return `sha256:${createHash("sha256").update(JSON.stringify({audio, transcript: reference.transcript ?? "", language: reference.language ?? "en"})).digest("hex")}`;
}
