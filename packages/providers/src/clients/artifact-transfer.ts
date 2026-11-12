import { artifactTransferLimits } from "@arke-studio/contracts";
import type { ArtifactFetchOptions } from "../types.js";

/** One admitted policy and deadline for the complete retrieval, not a fresh budget per file. */
export async function withArtifactTransfer<T>(options: ArtifactFetchOptions | undefined,
  retrieve: (signal: AbortSignal, limits: ReturnType<typeof artifactTransferLimits>) => Promise<T>): Promise<T> {
  const limits = artifactTransferLimits(options?.transferSettings), abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, ...(options?.signal ? [options.signal] : [])]);
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(() => abort.abort(new DOMException("Result download timed out.", "TimeoutError")), limits.timeoutMs);
  try {
    signal.throwIfAborted();
    // A CLI query may have its own finite lifetime. Stop observing now; its checked signal
    // still prevents a late query response from starting a download or publishing bytes.
    const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return retrieve(signal, limits); }), stopped]);
    signal.throwIfAborted();
    return result;
  } catch (error) { abort.abort(error); throw error; }
  finally { clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); }
}
