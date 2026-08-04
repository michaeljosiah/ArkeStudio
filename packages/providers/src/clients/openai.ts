import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import { jsonRequest, tryProbe } from "./http.js";
import type { FetchedArtifact, FetchLike, PollResult, ProviderClient, SubmitRequest, SubmitResult } from "../types.js";

/**
 * OpenAI — direct provider for llm and image. Both APIs answer synchronously, so submit runs
 * the request and caches the result; poll/fetch read the cache. Declarations (T-9): no
 * idempotency keys on completions or images, no job listing; token usage comes back but never
 * a dollar figure → actuals are manifest-derived (R-17).
 */
export class OpenAiClient implements ProviderClient {
  readonly id = "openai" as const;
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
    private readonly baseUrl = "https://api.openai.com",
  ) {}

  private headers(key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  }

  /**
   * The models list is free and names what the key actually unlocks (R-3, D5): a key without
   * an image model reports llm available and image unavailable, not blanket success.
   */
  async validateKey(key: string): Promise<CapabilityProbe[]> {
    const probe = await tryProbe(() =>
      jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/models`, { headers: this.headers(key) }),
    );
    if (!probe.ok) {
      const reason = probe.auth ? "OpenAI rejected this key" : `OpenAI could not be reached: ${probe.message}`;
      return [
        { capability: "llm", available: false, reason },
        { capability: "image", available: false, reason },
      ];
    }
    const { status, body } = probe.value;
    if (status === 429) {
      const reason = "the key authenticates but the account is out of credit";
      return [
        { capability: "llm", available: false, reason },
        { capability: "image", available: false, reason },
      ];
    }
    const models = ((body as { data?: Array<{ id?: string }> } | null)?.data ?? [])
      .map((m) => m.id ?? "")
      .filter((id) => id.length > 0);
    const hasImage = models.some((id) => id.includes("image") || id.startsWith("dall-e"));
    return [
      { capability: "llm", available: true },
      hasImage
        ? { capability: "image", available: true }
        : { capability: "image", available: false, reason: "no image model is enabled for this account" },
    ];
  }

  async submit(key: string, request: SubmitRequest): Promise<SubmitResult> {
    const remoteId = `openai-${++this.counter}-${Date.now()}`;
    if (request.capability === "image") {
      const output = request.params["output"] as { width?: unknown; height?: unknown } | undefined;
      // Only what this endpoint accepts. Our job params are provider-neutral and carry things
      // OpenAI has never heard of — `references` is a FAL concept — and it answers an unknown
      // field with a flat 400, which reads to the user as "the image failed" rather than "we
      // sent a word it does not know". Reference conditioning is not wired for OpenAI at all;
      // dropping the field is honest about that, where sending it just breaks the request.
      const accepted = new Set([
        "prompt",
        "n",
        "size",
        "quality",
        "style",
        "background",
        "output_format",
        "response_format",
        "moderation",
      ]);
      const params = Object.fromEntries(Object.entries(request.params).filter(([k]) => accepted.has(k)));
      if (typeof output?.width === "number" && typeof output.height === "number") {
        params["size"] = `${output.width}x${output.height}`;
      }
      const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify({ model: request.model, ...params }),
      });
      if (status >= 400) throw new Error(`openai: image generation failed (HTTP ${status})`);
      const images = (body as { data?: Array<{ b64_json?: string }> } | null)?.data ?? [];
      const artifacts: FetchedArtifact[] = images
        .filter((img) => typeof img.b64_json === "string")
        .map((img, i) => ({
          name: `image-${i + 1}.png`,
          contentType: "image/png",
          data: Uint8Array.from(Buffer.from(img.b64_json!, "base64")),
        }));
      this.completed.set(remoteId, { artifacts });
      return { remoteId, acceptedAt: new Date().toISOString() };
    }
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify({ model: request.model, ...request.params }),
    });
    if (status >= 400) throw new Error(`openai: completion failed (HTTP ${status})`);
    const text = (body as { choices?: Array<{ message?: { content?: string } }> } | null)?.choices?.[0]?.message?.content ?? "";
    this.completed.set(remoteId, {
      artifacts: [{ name: "completion.txt", contentType: "text/plain", data: new TextEncoder().encode(text) }],
    });
    return { remoteId, acceptedAt: new Date().toISOString() };
  }

  async poll(_key: string, remoteId: string): Promise<PollResult> {
    return this.completed.has(remoteId)
      ? { state: "succeeded" }
      : { state: "failed", error: "openai: unknown request id (synchronous API; results do not survive a restart)" };
  }

  async fetchArtifacts(_key: string, remoteId: string): Promise<FetchedArtifact[]> {
    const hit = this.completed.get(remoteId);
    if (!hit) throw new Error("openai: no cached result for this id");
    return hit.artifacts;
  }

  async cancel(): Promise<void> {
    // Synchronous API — nothing in flight to cancel once submit returned.
  }
}
