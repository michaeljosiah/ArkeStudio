import type { ChapterReview } from "@arke-studio/contracts";

/** Different runs are ordered by coordinator publication, not the clocks of portable worlds. */
export function acceptChapterReviewUpdate(previous: ChapterReview | null, next: ChapterReview | null): ChapterReview | null {
  if (!next) return previous;
  return previous && next.id === previous.id && next.updatedAt < previous.updatedAt ? previous : next;
}

/** Display the verified bytes themselves, never a mutable URL after checking its hash. */
export async function readChapterReviewImage(url: string, expectedHash: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Blob> {
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedHash)) throw new Error("The recorded image identity is unavailable. Review again.");
  signal.throwIfAborted();
  const response = await fetcher(url, { signal, cache: "no-store" });
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error("The reviewed image is unavailable."); }
  const limit = 50 * 1024 * 1024 - 1;
  if (Number(response.headers.get("content-length")) > limit) { await response.body.cancel().catch(() => {}); throw new Error("The image exceeds the evidence size limit."); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error("The image exceeds the evidence size limit.");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  signal.throwIfAborted();
  const actual = "sha256:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== expectedHash) throw new Error("Image changed since review. Refresh or review again; changed pixels are not shown as evidence.");
  const type = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
  return new Blob([bytes], { type });
}
