import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import { jsonRequest, tryProbe } from "./http.js";
import type { FetchedArtifact, FetchLike, PollResult, ProviderClient, SubmitRequest, SubmitResult } from "../types.js";

/**
 * Anthropic — direct llm provider. Synchronous messages API, cached like OpenAI's. Usage
 * comes back in tokens, never dollars → actuals are manifest-derived (T-9, R-17).
 */
export class AnthropicClient implements ProviderClient {
  readonly id = "anthropic" as const;
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
    private readonly baseUrl = "https://api.anthropic.com",
  ) {}

  private headers(key: string): Record<string, string> {
    return { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
  }

  async validateKey(key: string): Promise<CapabilityProbe[]> {
    const probe = await tryProbe(() =>
      jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/models`, { headers: this.headers(key) }),
    );
    if (!probe.ok) {
      const reason = probe.auth ? "Anthropic rejected this key" : `Anthropic could not be reached: ${probe.message}`;
      return [{ capability: "llm", available: false, reason }];
    }
    if (probe.value.status === 429) {
      return [{ capability: "llm", available: false, reason: "the key authenticates but the account is out of credit" }];
    }
    return [{ capability: "llm", available: true }];
  }

  async submit(key: string, request: SubmitRequest): Promise<SubmitResult> {
    const remoteId = `anthropic-${++this.counter}-${Date.now()}`;
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify({ model: request.model, max_tokens: 4096, ...request.params }),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (status >= 400) throw new Error(`anthropic: message failed (HTTP ${status})`);
    const blocks = (body as { content?: Array<{ type?: string; text?: string }> } | null)?.content ?? [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    this.completed.set(remoteId, {
      artifacts: [{ name: "completion.txt", contentType: "text/plain", data: new TextEncoder().encode(text) }],
    });
    return { remoteId, acceptedAt: new Date().toISOString() };
  }

  async poll(_key: string, remoteId: string): Promise<PollResult> {
    return this.completed.has(remoteId)
      ? { state: "succeeded" }
      : { state: "failed", error: "anthropic: unknown request id (synchronous API)" };
  }

  async fetchArtifacts(_key: string, remoteId: string): Promise<FetchedArtifact[]> {
    const hit = this.completed.get(remoteId);
    if (!hit) throw new Error("anthropic: no cached result for this id");
    return hit.artifacts;
  }

  async cancel(): Promise<void> {
    /* synchronous API */
  }
}
