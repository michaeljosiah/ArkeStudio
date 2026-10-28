import { ProviderArtifactLimitError } from "../types.js";
import { ARTIFACT_RESULT_LIMITS } from "@arke-studio/contracts";

/** Retains at most the admitted decoded extent, including chunked/encoded responses. An
 * abandoned read/cancel keeps its original stream lock until it settles; no late bytes
 * reach the consumer. This is a transport bound, not disk allocation or a resumable receipt. */
export async function readArtifactBody(response: Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid artifact transfer limit.");
  signal?.throwIfAborted();
  const encoded = response.headers.get("content-encoding");
  const rawLength = response.headers.get("content-length");
  let length: number | undefined;
  if (rawLength !== null && (!encoded || encoded.toLowerCase() === "identity")) {
    if (!/^[0-9]+$/.test(rawLength)) {
      void response.body?.cancel().catch(() => {}); throw new Error("Invalid artifact response length.");
    }
    length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length > maximum) {
      void response.body?.cancel().catch(() => {}); throw new ProviderArtifactLimitError();
    }
  }
  if (!response.body) {
    if (length) throw new Error("Artifact response ended before its declared length.");
    return new Uint8Array();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0, pending: ReturnType<typeof reader.read> | undefined, onAbort: (() => void) | undefined;
  const aborted = signal ? new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Artifact retrieval was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
  }) : undefined;
  try {
    for (let reads = 0; ; reads++) {
      if (reads >= ARTIFACT_RESULT_LIMITS.maxReadChunks) throw new ProviderArtifactLimitError();
      signal?.throwIfAborted(); pending = reader.read();
      const next = await (aborted ? Promise.race([pending, aborted]) : pending);
      signal?.throwIfAborted();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error("Invalid artifact response bytes.");
      if (next.value.byteLength > maximum - total) throw new ProviderArtifactLimitError();
      if (length !== undefined && next.value.byteLength > length - total) throw new Error("Artifact response length did not match its declaration.");
      total += next.value.byteLength; if (next.value.byteLength) chunks.push(next.value.slice());
    }
    if (length !== undefined && total !== length) throw new Error("Artifact response length did not match its declaration.");
    signal?.throwIfAborted();
    const result = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    if (onAbort) signal!.removeEventListener("abort", onAbort);
    // A slow/failed source cannot make cancellation start another read. Cleanup observes
    // only this original reader, with no callback or write capability after return.
    const cleanup = reader.cancel().catch(() => {});
    void Promise.allSettled([pending, cleanup]).then(() => { try { reader.releaseLock(); } catch { /* Still owned by the original stream. */ } });
  }
}
