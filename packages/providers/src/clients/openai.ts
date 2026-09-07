import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import { jsonRequest, tryProbe } from "./http.js";
import {
  ProviderAuthError,
  ProviderRequestRejectedError,
  type FetchedArtifact,
  type FetchLike,
  type PollResult,
  type ProviderClient,
  type SubmitRequest,
  type SubmitResult,
} from "../types.js";

/**
 * What a 4xx actually said. The body names the cause, and one cause — a moderation refusal —
 * is common, distinct and recoverable by writing a different prompt, so it gets a sentence of
 * its own instead of hiding behind "HTTP 400": a founding build lost its key art to one and
 * the hub could only report the status code (issue 906). Anything else carries OpenAI's own
 * message, which is at least something a person can act on.
 */
function rejected(what: "image generation" | "completion", status: number, body: unknown): ProviderRequestRejectedError {
  const error = (body as { error?: unknown } | null)?.error;
  const detail =
    typeof error === "object" && error !== null
      ? (error as { message?: unknown; code?: unknown; moderation_details?: { moderation_stage?: unknown } })
      : undefined;
  if (detail?.code === "moderation_blocked") {
    const where = detail.moderation_details?.moderation_stage === "output" ? "the picture it made" : "the prompt";
    return new ProviderRequestRejectedError(
      `openai: the safety system refused ${where} (moderation blocked) — recompose the prompt away from what it flagged and try again`,
    );
  }
  const message = typeof detail?.message === "string" && detail.message.trim() !== "" ? `: ${detail.message.trim()}` : "";
  return new ProviderRequestRejectedError(`openai: ${what} failed (HTTP ${status})${message}`);
}

/**
 * OpenAI — direct provider for llm and image. Both APIs answer synchronously. Image artifacts
 * return directly from submit; LLM completions retain the small in-memory poll seam. Declarations: no
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
      const prompt = request.params["prompt"];
      if (typeof prompt !== "string" || prompt.trim().length === 0) throw new Error("openai: image prompt is required");
      const size =
        typeof output?.width === "number" && typeof output.height === "number"
          ? `${output.width}x${output.height}`
          : undefined;
      const references = request.imageReferences ?? [];
      const durableReferences = request.params["references"];
      if (
        Array.isArray(durableReferences) &&
        durableReferences.length > 0 &&
        durableReferences.length !== references.length
      ) {
        throw new Error("openai: not every image reference was prepared");
      }
      if (references.length > 16) throw new Error("openai: gpt-image-2 accepts at most 16 reference images");
      let status: number;
      let body: unknown;
      if (references.length > 0) {
        const form = new FormData();
        form.append("model", request.model);
        form.append("prompt", prompt);
        form.append("n", "1");
        form.append("quality", "medium");
        form.append("output_format", "png");
        form.append("background", "opaque");
        form.append("moderation", "auto");
        if (size) form.append("size", size);
        for (const reference of references) {
          form.append("image[]", new Blob([reference.data], { type: reference.contentType }), reference.name);
        }
        const response = await this.fetchImpl(`${this.baseUrl}/v1/images/edits`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
        status = response.status;
        if (status === 401 || status === 403) {
          throw new ProviderAuthError("openai", `openai: the credential was rejected (HTTP ${status})`);
        }
        const text = await response.text();
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
      } else {
        const response = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/images/generations`, {
          method: "POST",
          headers: this.headers(key),
          body: JSON.stringify({
            model: request.model,
            prompt,
            n: 1,
            quality: "medium",
            output_format: "png",
            background: "opaque",
            moderation: "auto",
            ...(size ? { size } : {}),
          }),
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
        status = response.status;
        body = response.body;
      }
      if (status >= 500) throw new Error(`openai: image generation failed (HTTP ${status})`);
      if (status >= 400) throw rejected("image generation", status, body);
      const response = body as { data?: Array<{ b64_json?: string }>; output_format?: string } | null;
      const images = response?.data ?? [];
      if (images.length === 0 || images.some((image) => typeof image.b64_json !== "string")) {
        throw new Error("openai: image response contained no usable image data");
      }
      const format = response?.output_format === "jpeg" ? "jpeg" : response?.output_format === "webp" ? "webp" : "png";
      const extension = format === "jpeg" ? "jpg" : format;
      const artifacts: FetchedArtifact[] = images.map((img, i) => ({
          name: `image-${i + 1}.${extension}`,
          contentType: `image/${format}`,
          data: Uint8Array.from(Buffer.from(img.b64_json!, "base64")),
        }));
      return { remoteId, acceptedAt: new Date().toISOString(), artifacts };
    }
    const { status, body } = await jsonRequest(this.fetchImpl, this.id, `${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(key),
      body: JSON.stringify({ model: request.model, ...request.params }),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (status >= 500) throw new Error(`openai: completion failed (HTTP ${status})`);
    if (status >= 400) throw rejected("completion", status, body);
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
