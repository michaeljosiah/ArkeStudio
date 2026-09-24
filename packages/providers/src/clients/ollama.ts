import type { CapabilityProbe, ClientDeclarations, LocalHarnessModel, ModelResidency } from "@arke-studio/contracts";
import { setTimeout as pause } from "node:timers/promises";
import { jsonRequest, tryProbe } from "./http.js";
import type { FetchedArtifact, FetchLike, PollResult, ProviderClient, SubmitRequest, SubmitResult } from "../types.js";

/** The whole listing pass, tags and shows together, against a runtime that may have stopped answering. */
const LISTING_DEADLINE_MS = 8_000;
/** Shows in flight at once. Ollama serves these from metadata, so a few at a time is plenty. */
const SHOW_CONCURRENCY = 4;

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
    private readonly residencyPause: (signal?: AbortSignal) => Promise<void> = async (signal) => { await pause(1_000, undefined, { signal }); },
    private readonly listingDeadlineMs = LISTING_DEADLINE_MS,
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

  /** Loaded weights, measured again when Ollama's first answer may lag behind a load. */
  async residency(signal?: AbortSignal): Promise<ModelResidency[]> {
    const read = async (): Promise<ModelResidency[]> => {
      const response = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/api/ps`, {
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(3_000)]),
      });
      if (response.status >= 400) throw new Error("Ollama residency could not be read.");
      const models = (response.body as { models?: Array<{ name?: unknown; size_vram?: unknown; size?: unknown }> } | null)?.models;
      if (!Array.isArray(models)) throw new Error("Ollama residency could not be read.");
      return models.flatMap((model): ModelResidency[] => {
        if (typeof model.name !== "string" || !model.name) return [];
        const vram = typeof model.size_vram === "number" && Number.isFinite(model.size_vram) && model.size_vram >= 0 ? model.size_vram : undefined;
        const state = vram === undefined ? "unknown" : vram === 0 ? "cpu" :
          typeof model.size === "number" && model.size > vram ? "mixed" : "gpu";
        return [{ provider: "ollama", model: model.name, state, ...(vram !== undefined ? { vramBytes: vram } : {}) }];
      });
    };
    const first = await read();
    if (first.length > 0 && first.every((model) => model.state === "gpu" || model.state === "mixed")) return first;
    await this.residencyPause(signal);
    return read();
  }

  /**
   * What is pulled, with what each model can do, for the writing harness's catalogue (issue 1247).
   *
   * `/api/tags` names the models; `/api/show` says per model whether it completes, calls tools
   * and reads images, and how long its context is. A model that does not complete (an embedding
   * model) is left out — the harness would list it and every turn on it would fail. A show that
   * fails still lists the model, with tools assumed: a wrong assumption is a refused call the
   * person can read, where an omitted model is one they cannot find. Ollama down is an empty
   * list, not an error — the caller publishes whatever the runtime holds, and that is nothing.
   *
   * One deadline covers the whole pass, and the shows run a few at a time under it: the caller
   * holds the local-runtime probe open while this answers, so twenty pulled models against a
   * runtime that has stopped answering must cost seconds, not minutes. A model the deadline
   * cuts off is listed without metadata, the same as one whose show failed.
   */
  async listModels(signal?: AbortSignal): Promise<LocalHarnessModel[]> {
    // A held timer rather than AbortSignal.timeout, whose timer does not keep the process
    // alive: a pass waiting only on that could see the loop drain under it.
    const cutoff = new AbortController();
    const timer = setTimeout(() => cutoff.abort(new Error("Ollama listing deadline")), this.listingDeadlineMs);
    try {
      return await this.listUnder(AbortSignal.any([...(signal ? [signal] : []), cutoff.signal]));
    } finally {
      clearTimeout(timer);
    }
  }

  private async listUnder(deadline: AbortSignal): Promise<LocalHarnessModel[]> {
    let tags: { status: number; body: unknown };
    try {
      tags = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/api/tags`, { signal: deadline });
    } catch {
      return [];
    }
    if (tags.status >= 400) return [];
    const names = ((tags.body as { models?: Array<{ name?: unknown }> } | null)?.models ?? [])
      .map((model) => model.name).filter((name): name is string => typeof name === "string" && name.length > 0);
    const shown = Array.from({ length: names.length }, (): { capabilities?: unknown; model_info?: Record<string, unknown> } | null => null);
    let next = 0;
    const worker = async () => {
      while (next < names.length && !deadline.aborted) {
        const index = next++;
        try {
          const response = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/api/show`, {
            method: "POST", headers: { "Content-Type": "application/json" }, signal: deadline,
            body: JSON.stringify({ model: names[index] }),
          });
          if (response.status < 400 && response.body && typeof response.body === "object") {
            shown[index] = response.body as { capabilities?: unknown; model_info?: Record<string, unknown> };
          }
        } catch { /* listed without metadata, as the comment above says */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, names.length) }, worker));
    const models: LocalHarnessModel[] = [];
    for (const [index, id] of names.entries()) {
      const details = shown[index];
      const capabilities = Array.isArray(details?.capabilities) ? details.capabilities.filter((c): c is string => typeof c === "string") : null;
      if (capabilities && !capabilities.includes("completion")) continue;
      // The key is architecture-prefixed — `gemma4.context_length` — and the architecture
      // itself is stated beside it, so one lookup names the other.
      const info = details?.model_info ?? {};
      const architecture = typeof info["general.architecture"] === "string" ? info["general.architecture"] : null;
      const context = architecture !== null ? info[`${architecture}.context_length`] : undefined;
      models.push({
        id,
        ...(typeof context === "number" && Number.isSafeInteger(context) && context > 0 ? { contextLength: context } : {}),
        tools: capabilities ? capabilities.includes("tools") : true,
        vision: capabilities ? capabilities.includes("vision") : false,
      });
    }
    return models;
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
