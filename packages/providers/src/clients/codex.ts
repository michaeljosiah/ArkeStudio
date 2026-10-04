import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import {
  ProviderAuthError,
  ProviderRequestRejectedError,
  type FetchedArtifact,
  type PollResult,
  type PreparedImageReference,
  type ProviderClient,
  type SubmitRequest,
  type SubmitResult,
} from "../types.js";

/**
 * What the host's Codex app-server can do for images. Structural on purpose: this package never
 * imports the Codex adapter, the way the Kokoro client never imports the voice sidecar. The host
 * binds these to a private app-server and omits the dependency where Codex cannot run, so the
 * client is then absent rather than present and always failing.
 */
export interface CodexImageRunner {
  status(signal?: AbortSignal): Promise<{ authMode: "chatgpt" | "apiKey" | "other" | "none"; imageGeneration: boolean }>;
  generate(input: {
    prompt: string;
    references: readonly PreparedImageReference[];
    signal?: AbortSignal;
  }): Promise<{ bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/webp" }>;
}

const EXTENSION = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

/**
 * Images made by the user's own Codex sign-in. There is no credential of ours — the `key` every
 * method takes is empty and unused — and sign-in state is a probe, as for Higgsfield. The call is
 * synchronous like OpenAI's: the picture comes back from `submit`, nothing survives a restart,
 * and an interrupted submission is the user's to ask about because there is no key to look up.
 * Nothing is reported as a cost: the plan pays, and a figure invented here would be recorded.
 */
export class CodexClient implements ProviderClient {
  readonly id = "codex" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: false,
    reportsCost: false,
  };
  private counter = 0;
  private readonly completed = new Map<string, FetchedArtifact[]>();

  constructor(private readonly runner: CodexImageRunner) {}

  async validateKey(_key: string): Promise<CapabilityProbe[]> {
    const unavailable = (reason: string): CapabilityProbe[] => [{ capability: "image", available: false, reason }];
    try {
      const status = await this.runner.status();
      if (status.authMode === "none") return unavailable("Codex is not signed in — run `codex login`");
      if (status.authMode !== "chatgpt") return unavailable("Codex is signed in with an API key — image generation needs a ChatGPT sign-in");
      if (!status.imageGeneration) return unavailable("this Codex sign-in does not offer image generation");
      return [{ capability: "image", available: true }];
    } catch (err) {
      return unavailable(err instanceof Error ? err.message : String(err));
    }
  }

  async submit(_key: string, request: SubmitRequest): Promise<SubmitResult> {
    if (request.capability !== "image") throw new Error("codex: only image generation is offered");
    const prompt = request.params["prompt"];
    if (typeof prompt !== "string" || prompt.trim().length === 0) throw new Error("codex: image prompt is required");
    const references = request.imageReferences ?? [];
    const durable = request.params["references"];
    if (Array.isArray(durable) && durable.length > 0 && durable.length !== references.length) {
      throw new Error("codex: not every image reference was prepared");
    }
    let image: Awaited<ReturnType<CodexImageRunner["generate"]>>;
    try {
      image = await this.runner.generate({ prompt, references, ...(request.signal !== undefined ? { signal: request.signal } : {}) });
    } catch (err) {
      // Duck-typed: the adapter's typed limit error crosses a package boundary this file may not import.
      if (err instanceof Error && err.name === "CodexImageLimitError") {
        const resetsAt = (err as { resetsAt?: unknown }).resetsAt;
        const when = typeof resetsAt === "number" ? ` It resets ${new Date(resetsAt * 1000).toISOString()}.` : "";
        throw new ProviderRequestRejectedError(`codex: the plan's image limit has been reached.${when}`);
      }
      if (err instanceof Error && /not signed in|not available for this login/i.test(err.message)) throw new ProviderAuthError(this.id, `codex: ${err.message}`);
      throw err;
    }
    const remoteId = `codex-${++this.counter}-${Date.now()}`;
    const artifacts: FetchedArtifact[] = [{ name: `image-1.${EXTENSION[image.mimeType]}`, contentType: image.mimeType, data: image.bytes }];
    this.completed.set(remoteId, artifacts);
    return { remoteId, acceptedAt: new Date().toISOString(), artifacts };
  }

  async poll(_key: string, remoteId: string): Promise<PollResult> {
    return this.completed.has(remoteId)
      ? { state: "succeeded" }
      : { state: "failed", error: "codex: unknown request id (synchronous; results do not survive a restart)" };
  }

  async fetchArtifacts(_key: string, remoteId: string): Promise<FetchedArtifact[]> {
    const hit = this.completed.get(remoteId);
    if (!hit) throw new Error("codex: no cached result for this id");
    return hit;
  }

  async cancel(): Promise<void> {
    // Synchronous: nothing is in flight once submit has returned, and an abort signal covers the rest.
  }
}
