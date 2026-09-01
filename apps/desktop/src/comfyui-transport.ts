import { comfyUiUrlIsLoopback } from "@arke-studio/coordinator";
import type { FetchLike } from "@arke-studio/providers";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";

/** The only addresses a locally classified ComfyUI URL may reach. */
export function comfyUiLoopbackAddresses(hostname: string): LookupAddress[] {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "127.0.0.1") return [{ address: "127.0.0.1", family: 4 }];
  if (normalized === "::1") return [{ address: "::1", family: 6 }];
  if (normalized === "localhost") {
    return [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ];
  }
  return [];
}

const loopbackLookup: LookupFunction = (hostname, options, callback) => {
  const family = options.family ?? 0;
  const addresses = comfyUiLoopbackAddresses(hostname)
    .filter((candidate) => family === 0 || candidate.family === family);
  if (addresses.length === 0) {
    const error = Object.assign(new Error(`ComfyUI loopback transport refused ${hostname}`), {
      code: "ENOTFOUND",
    });
    queueMicrotask(() => callback(error, options.all ? [] : "", 0));
    return;
  }
  queueMicrotask(() => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

function loopbackAgent(): Agent {
  return new Agent({
    pipelining: 0,
    autoSelectFamily: true,
    connect: { lookup: loopbackLookup },
  });
}

/**
 * Do not retain loopback connections across replacement of the ComfyUI process on the same port.
 * Undici can otherwise reuse a socket accepted by the old process while a fresh curl reaches the
 * replacement immediately. `localhost` is pinned here rather than trusted through the hosts file:
 * locality also authorizes biometric voice bytes to remain on this machine. Remote engines keep
 * pooling because their connection setup is not free.
 */
export function createComfyUiFetch(
  fetchImpl: FetchLike,
  loopbackDispatcher: unknown = loopbackAgent(),
): FetchLike {
  return (url, init) => {
    if (!comfyUiUrlIsLoopback(url)) return fetchImpl(url, init);
    // `dispatcher` is Node fetch's documented extension to RequestInit. FetchLike stays on the
    // web type because every provider package is transport-neutral; the desktop host owns this.
    return fetchImpl(url, { ...init, dispatcher: loopbackDispatcher } as unknown as RequestInit);
  };
}
