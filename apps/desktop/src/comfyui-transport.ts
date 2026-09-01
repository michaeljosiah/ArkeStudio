import { comfyUiUrlIsLoopback } from "@arke-studio/coordinator";
import type { FetchLike } from "@arke-studio/providers";
import { Agent } from "undici";

/**
 * Do not retain loopback connections across replacement of the ComfyUI process on the same port.
 * Undici can otherwise reuse a socket accepted by the old process while a fresh curl reaches the
 * replacement immediately. Remote engines keep pooling because their connection setup is not free.
 */
export function createComfyUiFetch(
  fetchImpl: FetchLike,
  loopbackDispatcher: unknown = new Agent({ pipelining: 0 }),
): FetchLike {
  return (url, init) => {
    if (!comfyUiUrlIsLoopback(url)) return fetchImpl(url, init);
    // `dispatcher` is Node fetch's documented extension to RequestInit. FetchLike stays on the
    // web type because every provider package is transport-neutral; the desktop host owns this.
    return fetchImpl(url, { ...init, dispatcher: loopbackDispatcher } as unknown as RequestInit);
  };
}
