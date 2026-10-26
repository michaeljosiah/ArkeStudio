import { createHash } from "node:crypto";

/** Reference words affect conditioning, so changing them invalidates queued/cache identity. */
export function mingReferenceHash(reference: {data: Uint8Array; transcript?: string}): string {
  return `sha256:${createHash("sha256").update(reference.data).update("\0").update(reference.transcript ?? "").digest("hex")}`;
}
