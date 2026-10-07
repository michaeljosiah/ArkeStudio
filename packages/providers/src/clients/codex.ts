import { usesCodexImagePlan, type CapabilityProbe, type ClientDeclarations } from "@arke-studio/contracts";
import {
  ProviderAuthError,
  ProviderPlanLimitError,
  ProviderRequestRejectedError,
  type FetchedArtifact,
  type PollResult,
  type PreparedImageReference,
  type ProviderClient,
  type SubmitRequest,
  type SubmitResult,
} from "../types.js";
import { SHIPPED_MANIFEST } from "../manifest-data.js";

/** The shipped row's verified reference count, so the client and the dispatch surface agree. */
const MAX_REFERENCES = SHIPPED_MANIFEST.models.find((model) => model.id === "codex-image")?.accepts.referenceImages ?? 1;

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
  /** Stops whatever the host started for this runner. No call may follow it. */
  dispose?(): Promise<void> | void;
}

const EXTENSION = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

/**
 * Images made by the user's own Codex sign-in. There is no credential of ours — the `key` every
 * method takes is empty and unused — and sign-in state is a probe, as for Higgsfield. The call is
 * synchronous like OpenAI's: the picture comes back from `submit` and is not kept here — the
 * dispatcher persists inline artifacts and never polls — so nothing survives a restart, and an
 * interrupted submission is the user's to ask about because there is no key to look up.
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
    if (!usesCodexImagePlan({ provider: this.id, model: request.model })) throw new ProviderRequestRejectedError("codex: unknown image model");
    const prompt = request.params["prompt"];
    if (typeof prompt !== "string" || prompt.trim().length === 0) throw new Error("codex: image prompt is required");
    const references = request.imageReferences ?? [];
    if (references.length > MAX_REFERENCES) throw new ProviderRequestRejectedError(`codex: at most ${MAX_REFERENCES} reference images are supported`);
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
        const reset = typeof resetsAt === "number" ? new Date(resetsAt * 1000) : null;
        const validReset = reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : undefined;
        const when = validReset ? ` It resets ${validReset}. Try again after it resets.` : " Try again after it resets; use Test connection in Providers to check again.";
        throw new ProviderPlanLimitError(`codex: the Codex allowance has been reached.${when}`, validReset);
      }
      // The queue classifies by message, and only a message it recognises pauses the lane for a
      // sign-in instead of failing the job: this phrase is the one its credential path reads.
      if (err instanceof Error && /not signed in|not available for this login/i.test(err.message)) {
        throw new ProviderAuthError(this.id, "codex: the credential was rejected — Codex is no longer signed in with ChatGPT");
      }
      throw err;
    }
    const remoteId = `codex-${++this.counter}-${Date.now()}`;
    const artifacts: FetchedArtifact[] = [{ name: `image-1.${EXTENSION[image.mimeType]}`, contentType: image.mimeType, data: image.bytes }];
    return { remoteId, acceptedAt: new Date().toISOString(), artifacts };
  }

  async poll(): Promise<PollResult> {
    return { state: "failed", error: "codex: unknown request id (synchronous; results are returned by submit and do not survive a restart)" };
  }

  async fetchArtifacts(): Promise<FetchedArtifact[]> {
    throw new Error("codex: results are returned by submit and are not kept");
  }

  async dispose(): Promise<void> {
    await this.runner.dispose?.();
  }

  async cancel(): Promise<void> {
    // Synchronous: nothing is in flight once submit has returned, and an abort signal covers the rest.
  }
}
