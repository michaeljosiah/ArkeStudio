import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import { jsonRequest, tryProbe } from "./http.js";
import type { FetchedArtifact, FetchLike, PollResult, ProviderClient, SubmitRequest, SubmitResult } from "../types.js";

/**
 * Ollama — local llm runtime, no key, unmetered (R-18): every run is a ledger local-zero.
 * The "key" parameter is ignored throughout; validate probes reachability, which is the only
 * thing that can be wrong with a local runtime.
 */
export class OllamaClient implements ProviderClient {
  readonly id = "ollama" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: false,
    reportsCost: false,
  };

  private readonly completed = new Map<string, { artifacts: FetchedArtifact[] }>();
  private counter = 0;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl = "http://127.0.0.1:11434",
  ) {}

  async validateKey(): Promise<CapabilityProbe[]> {
    const probe = await tryProbe(() => jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/api/tags`, {}));
    if (!probe.ok) {
      return [{ capability: "llm", available: false, reason: "Ollama is not running on this machine" }];
    }
    const models = ((probe.value.body as { models?: Array<{ name?: string }> } | null)?.models ?? []).length;
    return models > 0
      ? [{ capability: "llm", available: true }]
      : [{ capability: "llm", available: false, reason: "Ollama is running but has no models pulled" }];
  }

  async submit(_key: string, request: SubmitRequest): Promise<SubmitResult> {
    const remoteId = `ollama-${++this.counter}-${Date.now()}`;
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: request.model, stream: false, ...request.params }),
    });
    if (status >= 400) throw new Error(`ollama: generate failed (HTTP ${status})`);
    const text = (body as { response?: string } | null)?.response ?? "";
    this.completed.set(remoteId, {
      artifacts: [{ name: "completion.txt", contentType: "text/plain", data: new TextEncoder().encode(text) }],
    });
    return { remoteId, acceptedAt: new Date().toISOString() };
  }

  async poll(_key: string, remoteId: string): Promise<PollResult> {
    return this.completed.has(remoteId)
      ? { state: "succeeded" }
      : { state: "failed", error: "ollama: unknown request id (synchronous API)" };
  }

  async fetchArtifacts(_key: string, remoteId: string): Promise<FetchedArtifact[]> {
    const hit = this.completed.get(remoteId);
    if (!hit) throw new Error("ollama: no cached result for this id");
    return hit.artifacts;
  }

  async cancel(): Promise<void> {
    /* synchronous API */
  }
}
