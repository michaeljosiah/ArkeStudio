import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import { jsonRequest, tryProbe } from "./http.js";
// Generated beside the manifest rows, from the same fetch, so a model can never be offered
// with no route behind it — the failure that used to read "no endpoint mapping" at dispatch,
// long after the estimate had been shown and accepted.
import { FAL_ENDPOINTS as ENDPOINTS } from "../fal-catalogue.generated.js";
import type { FetchedArtifact, FetchLike, PollResult, ProviderClient, SubmitRequest, SubmitResult } from "../types.js";

/**
 * FAL — gateway: many models, one key (R-1). Queue API: submit to a model endpoint, poll the
 * request id under that endpoint, fetch the completed payload.
 *
 * Declarations (T-9, established from the queue API surface): no idempotency keys, no lookup
 * by key, no listing of recent requests → an interrupted submission reconciles by asking the
 * user (§2.9). No cost figure in any response → ledger actuals are manifest-derived (R-17).
 */

export class FalClient implements ProviderClient {
  readonly id = "fal" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: false,
    reportsCost: false,
  };

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl = "https://queue.fal.run",
  ) {}

  private headers(key: string): Record<string, string> {
    return { Authorization: `Key ${key}`, "Content-Type": "application/json" };
  }

  /**
   * One free probe covers the gateway: a status read of a nonexistent request authenticates
   * without generating. One key unlocks image and video together (R-1).
   */
  async validateKey(key: string): Promise<CapabilityProbe[]> {
    const url = `${this.baseUrl}/fal-ai/flux-pro/requests/00000000-0000-0000-0000-000000000000/status`;
    const probe = await tryProbe(() => jsonRequest(this.fetchImpl, this.id, url, { headers: this.headers(key) }));
    if (!probe.ok) {
      const reason = probe.auth ? "FAL rejected this key" : `FAL could not be reached: ${probe.message}`;
      return [
        { capability: "image", available: false, reason },
        { capability: "video", available: false, reason },
      ];
    }
    // Any non-auth status (404 for the bogus id) means the key authenticated the gateway.
    return [
      { capability: "image", available: true },
      { capability: "video", available: true },
    ];
  }

  private endpointFor(model: string): string {
    const endpoint = ENDPOINTS[model];
    if (!endpoint) throw new Error(`fal: no endpoint mapping for model "${model}"`);
    return endpoint;
  }

  async submit(key: string, request: SubmitRequest): Promise<SubmitResult> {
    const endpoint = this.endpointFor(request.model);
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/${endpoint}`, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify(request.params),
    });
    const requestId = (body as { request_id?: string } | null)?.request_id;
    if (status >= 400 || !requestId) throw new Error(`fal: submit failed (HTTP ${status})`);
    // The remote id carries its endpoint — polling is endpoint-scoped on FAL.
    return { remoteId: `${endpoint}::${requestId}`, acceptedAt: new Date().toISOString() };
  }

  private split(remoteId: string): { endpoint: string; requestId: string } {
    const i = remoteId.lastIndexOf("::");
    return { endpoint: remoteId.slice(0, i), requestId: remoteId.slice(i + 2) };
  }

  async poll(key: string, remoteId: string): Promise<PollResult> {
    const { endpoint, requestId } = this.split(remoteId);
    const { status, body } = await jsonRequest(
      this.fetchImpl,
      this.id,
      `${this.baseUrl}/${endpoint}/requests/${requestId}/status`,
      { headers: this.headers(key) },
    );
    if (status >= 400) return { state: "failed", error: `fal: status read failed (HTTP ${status})` };
    const remote = (body as { status?: string } | null)?.status ?? "UNKNOWN";
    if (remote === "COMPLETED") return { state: "succeeded" };
    if (remote === "IN_PROGRESS") return { state: "running" };
    if (remote === "IN_QUEUE") return { state: "queued" };
    return { state: "failed", error: `fal: unexpected status "${remote}"` };
  }

  async fetchArtifacts(key: string, remoteId: string): Promise<FetchedArtifact[]> {
    const { endpoint, requestId } = this.split(remoteId);
    const { status, body } = await jsonRequest(
      this.fetchImpl,
      this.id,
      `${this.baseUrl}/${endpoint}/requests/${requestId}`,
      { headers: this.headers(key) },
    );
    if (status >= 400) throw new Error(`fal: result fetch failed (HTTP ${status})`);
    const out: FetchedArtifact[] = [];
    const payload = body as { images?: Array<{ url?: string; content_type?: string }>; video?: { url?: string } } | null;
    const urls: Array<{ url: string; contentType: string }> = [];
    for (const img of payload?.images ?? []) {
      if (img.url) urls.push({ url: img.url, contentType: img.content_type ?? "image/png" });
    }
    if (payload?.video?.url) urls.push({ url: payload.video.url, contentType: "video/mp4" });
    for (const [i, item] of urls.entries()) {
      const res = await this.fetchImpl(item.url);
      const data = new Uint8Array(await res.arrayBuffer());
      const ext = item.contentType.startsWith("video") ? "mp4" : "png";
      out.push({ name: `output-${i + 1}.${ext}`, contentType: item.contentType, data });
    }
    return out;
  }

  async cancel(key: string, remoteId: string): Promise<void> {
    const { endpoint, requestId } = this.split(remoteId);
    await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/${endpoint}/requests/${requestId}/cancel`, {
      method: "PUT",
      headers: this.headers(key),
    });
  }
}
