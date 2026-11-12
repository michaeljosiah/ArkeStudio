import { VerifiedLoopbackHttpTransport, type VerifiedHttpOptions, type VerifiedHttpPolicy } from "./verified-loopback-http.js";

/** Closed provider protocol; native status/error bodies cannot escape to OpenCode. */
export class ManagedOllamaTransport extends VerifiedLoopbackHttpTransport {
  private sealed = false;
  constructor(options: VerifiedHttpOptions) { super(options, 180_000); }
  /** Stop cannot turn pending process proof into a new provider dispatch. Existing reads drain. */
  seal(): void { this.sealed = true; }
  prepareMetadata(): Promise<void> { return this.prepareMetadataSockets(); }
  protected policy(url: URL, method: string): VerifiedHttpPolicy {
    const metadata = method === "GET" && url.pathname === "/api/tags" || method === "POST" && url.pathname === "/api/show";
    const locality = method === "GET" && url.pathname === "/api/status";
    const generate = method === "POST" && url.pathname === "/v1/chat/completions";
    if (this.sealed || url.search || !metadata && !generate && !locality) throw new Error("The private provider path is unavailable.");
    return { requestBytes: generate ? 1024 ** 2 : 4096, responseBytes: locality ? 16 * 1024 : 1024 ** 2, responseType: generate ? "text/event-stream" : "application/json", preparedSocket: metadata, beforeWrite: () => !this.sealed };
  }
}
