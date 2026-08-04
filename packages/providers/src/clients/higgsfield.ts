import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import { jsonRequest, tryProbe } from "./http.js";
import type { FetchedArtifact, FetchLike, PollResult, ProviderClient, SubmitRequest, SubmitResult } from "../types.js";

function extensionFor(contentType: string): string {
  const type = contentType.toLowerCase().split(";", 1)[0];
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/png") return "png";
  if (type === "video/mp4") return "mp4";
  return "bin";
}

/**
 * Higgsfield — gateway for image and video. Queue-shaped API. Declarations (T-9): nothing to
 * reconcile from — no idempotency keys, no lookup, no listing — so an interrupted submission
 * is the ask-the-user case, and no cost figure is reported (R-17).
 */
export class HiggsfieldClient implements ProviderClient {
  readonly id = "higgsfield" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: false,
    reportsCost: false,
  };

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl = "https://platform.higgsfield.ai",
  ) {}

  private headers(key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  }

  /** One gateway probe; a key unlocks image and video together (R-1). */
  async validateKey(key: string): Promise<CapabilityProbe[]> {
    const probe = await tryProbe(() =>
      jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/models`, { headers: this.headers(key) }),
    );
    if (!probe.ok) {
      const reason = probe.auth ? "Higgsfield rejected this key" : `Higgsfield could not be reached: ${probe.message}`;
      return [
        { capability: "image", available: false, reason },
        { capability: "video", available: false, reason },
      ];
    }
    return [
      { capability: "image", available: true },
      { capability: "video", available: true },
    ];
  }

  async submit(key: string, request: SubmitRequest): Promise<SubmitResult> {
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/generate`, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify({ model: request.model, ...request.params }),
    });
    const jobId = (body as { id?: string } | null)?.id;
    if (status >= 400 || !jobId) throw new Error(`higgsfield: submit failed (HTTP ${status})`);
    return { remoteId: jobId, acceptedAt: new Date().toISOString() };
  }

  async poll(key: string, remoteId: string): Promise<PollResult> {
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/jobs/${remoteId}`, {
      headers: this.headers(key),
    });
    if (status >= 400) return { state: "failed", error: `higgsfield: status read failed (HTTP ${status})` };
    const remote = (body as { status?: string } | null)?.status ?? "unknown";
    if (remote === "completed") return { state: "succeeded" };
    if (remote === "processing") return { state: "running" };
    if (remote === "queued") return { state: "queued" };
    if (remote === "cancelled") return { state: "cancelled" };
    return { state: "failed", error: `higgsfield: status "${remote}"` };
  }

  async fetchArtifacts(key: string, remoteId: string): Promise<FetchedArtifact[]> {
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/jobs/${remoteId}`, {
      headers: this.headers(key),
    });
    if (status >= 400) throw new Error(`higgsfield: result fetch failed (HTTP ${status})`);
    const urls = ((body as { outputs?: Array<{ url?: string; content_type?: string }> } | null)?.outputs ?? []).filter(
      (o): o is { url: string; content_type?: string } => typeof o.url === "string",
    );
    const out: FetchedArtifact[] = [];
    for (const [i, o] of urls.entries()) {
      const res = await this.fetchImpl(o.url);
      const contentType = o.content_type ?? "application/octet-stream";
      const ext = extensionFor(contentType);
      out.push({ name: `output-${i + 1}.${ext}`, contentType, data: new Uint8Array(await res.arrayBuffer()) });
    }
    return out;
  }

  async cancel(key: string, remoteId: string): Promise<void> {
    await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/jobs/${remoteId}/cancel`, {
      method: "POST",
      headers: this.headers(key),
    });
  }
}
