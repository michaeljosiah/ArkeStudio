import {
  ModelInfoSchema, findHarnessModel, harnessModelDisabled, harnessModelManifestEntry,
  harnessModelMissingInput, harnessModelReference, modelEligible, ollamaLlmAvailable, PROVIDERS,
  type ClientState, type HarnessAdapter, type HarnessModelStatus, type ModelInfo,
} from "@arke-studio/contracts";

class CatalogError extends Error {}

/**
 * A catalog belongs to the running adapter. One bounded request serves simultaneous pickers
 * and dispatches; a failed refresh never presents the last good response as freshly verified.
 */
export class HarnessModelCatalog {
  private models: ModelInfo[] = [];
  private checkedAt = 0;
  private pending: Promise<ModelInfo[]> | undefined;
  private generation = 0;
  private lifecycleRevision: number | undefined;
  private lastPublication = "";

  constructor(
    private readonly adapter: HarnessAdapter | null,
    private readonly publish: (models: ModelInfo[], status: HarnessModelStatus) => void,
    private readonly options: { timeoutMs?: number; ttlMs?: number; now?: () => number } = {},
  ) {}

  private publishChanged(models: ModelInfo[], status: HarnessModelStatus): void {
    const fingerprint = JSON.stringify([models, status]);
    if (fingerprint === this.lastPublication) return;
    this.lastPublication = fingerprint;
    this.publish(models, status);
  }

  invalidate(): void {
    this.generation++;
    this.checkedAt = 0;
    this.pending = undefined;
    this.publishChanged(this.models, { status: "idle" });
  }

  private synchronizeLifecycle(): void {
    const revision = this.adapter?.lifecycleRevision?.();
    if (revision === this.lifecycleRevision) return;
    this.lifecycleRevision = revision;
    this.invalidate();
  }

  async get(refresh = false, options: { background?: boolean } = {}): Promise<ModelInfo[]> {
    // A process can restart between health polls while both observed readiness values are true.
    this.synchronizeLifecycle();
    if (this.pending) {
      if (refresh && !options.background) this.publishChanged(this.models, { status: "loading" });
      return this.pending;
    }
    const now = this.options.now ?? Date.now;
    if (!refresh && this.adapter?.readiness().ready && this.checkedAt && now() - this.checkedAt < (this.options.ttlMs ?? 60_000)) return this.models;
    const generation = this.generation;
    if (!options.background) this.publishChanged(this.models, { status: "loading" });
    let settled = false;
    const work = async (): Promise<ModelInfo[]> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const adapter = this.adapter;
        if (!adapter?.readiness().ready) throw new CatalogError("The harness is not running. Check Harness settings.");
        if (!adapter.listModels || !adapter.capabilities().has("models")) {
          throw new CatalogError("This harness does not provide a model catalog.");
        }
        const received = await Promise.race([
          adapter.listModels(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new CatalogError("Model discovery timed out. Retry models.")), this.options.timeoutMs ?? 15_000);
          }),
        ]);
        const parsed = ModelInfoSchema.array().safeParse(received);
        if (!parsed.success) throw new CatalogError("The harness returned an invalid model catalog. Retry models.");
        const references = new Set(parsed.data.map(harnessModelReference));
        if (references.size !== parsed.data.length) {
          throw new CatalogError("The harness returned duplicate model identities. Retry models.");
        }
        this.synchronizeLifecycle();
        if (generation !== this.generation) throw new CatalogError("The harness changed during model discovery. Retry models.");
        this.models = parsed.data;
        this.checkedAt = now();
        this.publishChanged(this.models, { status: "ready" });
        return this.models;
      } catch (error) {
        // SDK and provider failures can quote raw config, credentials or invalid payloads.
        const safeError = error instanceof CatalogError ? error : new CatalogError("Model discovery failed. Check the running harness and retry models.");
        if (generation === this.generation) {
          this.checkedAt = 0;
          this.publishChanged(this.models, { status: "error", reason: safeError.message });
        }
        throw safeError;
      } finally {
        settled = true;
        if (timer) clearTimeout(timer);
        if (generation === this.generation) this.pending = undefined;
      }
    };
    const pending = work();
    // An immediate refusal already published its error; a second caller must not join it
    // and replace that terminal state with loading while awaiting microtask cleanup.
    this.pending = settled ? undefined : pending;
    return pending;
  }
}

export interface LanguageModelSelection {
  modelId?: string;
  sessionModel?: string;
  /** The effort the session runs at: one the model declares, in the harness's own name. */
  variant?: string;
  inputTokenLimit?: number;
  reason?: string;
}

/** Evaluate local readiness and deliberate disablement without consulting media API keys. */
export function selectHarnessModel(
  reference: string, models: readonly ModelInfo[], app: ClientState["app"], needsImages = false, needsTools = false,
  /** Effort asked for, kept only when the model declares it: a model that does not has nothing to run it at. */
  variant?: string,
): LanguageModelSelection {
  const model = findHarnessModel(reference, models, app.manifest?.models);
  if (!model) return { modelId: reference, reason: `${reference} is unavailable through the running harness. Choose an available model or clear the saved choice.` };
  if (model.provider === "ollama" && !ollamaLlmAvailable(app.providers)) {
    return { modelId: reference, reason: "Ollama is unavailable. Start Ollama and retry, or choose another Writing model." };
  }
  const entry = harnessModelManifestEntry(model, app.manifest?.models);
  if (harnessModelDisabled(model, app.models.disabled, app.manifest?.models) ||
    (entry && PROVIDERS[entry.provider].local && !modelEligible(entry, {
      providers: app.providers, disabled: app.models.disabled, recipes: app.comfyui?.recipes ?? [],
      comfyUiLocality: app.comfyui?.engine.locality, gated: app.runtime?.models ?? [],
    }))) {
    return { modelId: reference, reason: `${model.displayName ?? model.id} is unavailable. Check AI models or choose another model.` };
  }
  const missingInput = harnessModelMissingInput(model, needsImages);
  if (needsTools && model.tools === false) return { modelId: reference, reason: `${model.displayName ?? model.id} cannot use tools. Choose another Writing model above the conversation.` };
  if (missingInput === "text") {
    return { modelId: reference, reason: `${model.displayName ?? model.id} cannot read text. Choose a text-reading model in Settings → Harness → Advanced or the production's Develop conversation.` };
  }
  if (missingInput === "image") {
    return { modelId: reference, reason: `${model.displayName ?? model.id} cannot read images. Choose Stage designer under Settings → Harness → Advanced, or an image-reading model in the production's Develop conversation.` };
  }
  return {
    modelId: harnessModelReference(model), sessionModel: harnessModelReference(model),
    ...(variant !== undefined && model.variants?.names.includes(variant) ? { variant } : {}),
    ...(model.inputTokenLimit ?? entry?.limits.maxContextTokens
      ? { inputTokenLimit: model.inputTokenLimit ?? entry?.limits.maxContextTokens } : {}),
  };
}
