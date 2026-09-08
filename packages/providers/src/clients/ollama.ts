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
    // Bounded: this probe is re-run on a timer (issue 462), and a loopback port that accepts a
    // connection and then never answers would hold the pass open indefinitely.
    const probe = await tryProbe(() =>
      jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) }),
    );
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
      body: JSON.stringify({ model: request.model, stream: false, keep_alive: "5m", ...request.params }),
      signal: request.signal,
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

  /** Query the runtime, including models loaded by the writing harness, before a GPU handover. */
  async unload(signal?: AbortSignal): Promise<void> {
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
    let response: Awaited<ReturnType<typeof jsonRequest>>;
    try {
      response = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/api/ps`, { signal: bounded });
    } catch (error) {
      // An absent local server holds no models. An unresponsive or malformed server is not absent.
      if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return;
      throw new Error("Ollama could not release its models. Check the Ollama engine and try again.", { cause: error });
    }
    const models = (response.body as { models?: Array<{ name?: string }> } | null)?.models;
    if (response.status >= 400 || !Array.isArray(models) || models.some((model) => typeof model.name !== "string")) {
      throw new Error("Ollama could not report its loaded models. Check the Ollama engine and try again.");
    }
    for (const model of models) {
      const result = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/api/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: bounded,
        body: JSON.stringify({ model: model.name, keep_alive: 0, stream: false }),
      });
      if (result.status >= 400) throw new Error("Ollama could not release its models. Check the Ollama engine and try again.");
    }
  }
}
