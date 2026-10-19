import {
  findHarnessModel,
  harnessModelDisabled,
  harnessModelManifestEntry,
  harnessModelMissingInput,
  harnessModelReference,
  modelEligible,
  PROVIDERS,
  type ClientState,
  type ModelInfo,
} from "@arke-studio/contracts";
import { listHarnessModels } from "../lib/store.js";
import { eligibilityInputs } from "./dispatch-bar.js";

/** The catalog is supplied by the running harness, even while a restart is pending. */
export function harnessModelLabel(state: ClientState | null, model: ModelInfo): string {
  return model.displayName && model.displayName !== model.id ? model.displayName :
    harnessModelManifestEntry(model, state?.app.manifest?.models)?.displayName ?? model.displayName ?? model.id;
}

export function runningHarnessLabel(state: ClientState | null): string {
  const generation = state?.app.harnessInfo?.generation;
  return generation === "claude" ? "Claude Code" : generation === "codex" ? "Codex"
    : generation === "v1" || generation === "v2" ? "OpenCode" : "the running harness";
}

export function harnessModelUnavailableReason(
  state: ClientState | null,
  model: ModelInfo,
  needsImages = false,
  needsTools = false,
): string | undefined {
  const manifest = state?.app.manifest?.models;
  if (harnessModelDisabled(model, state?.app.models.disabled ?? [], manifest)) {
    return "turned off in AI models";
  }
  const entry = harnessModelManifestEntry(model, manifest);
  // A harness's own login is independent of the provider keys used for media generation.
  if (entry && PROVIDERS[entry.provider].local && !modelEligible(entry, eligibilityInputs(state))) {
    return "unavailable on this machine";
  }
  const missingInput = harnessModelMissingInput(model, needsImages);
  if (needsTools && model.tools === false) return "cannot use tools";
  if (missingInput === "text") return "cannot read text";
  if (missingInput === "image") {
    return "text only · Stage needs images";
  }
  return undefined;
}

/**
 * Why a production language choice cannot run, without choosing another model in its place. The
 * Stage asks it of the Stage designer's model with `needsImages`, as the coordinator does, so a
 * saved choice the harness stopped listing is said before Build rather than refused after it.
 */
export function languageChoiceReason(
  state: ClientState | null,
  modelId: string | undefined,
  needsTools = false,
  needsImages = false,
): string | undefined {
  if (modelId === undefined) return undefined;
  if (state?.app.harnessModelStatus?.status === "loading") return "Checking language models…";
  if (state?.app.harnessModelStatus?.status === "error") return state.app.harnessModelStatus.reason ?? "Model discovery failed. Retry models to check this choice.";
  if (state?.app.harnessModelStatus?.status !== "ready") return "Language models need to be refreshed.";
  const model = findHarnessModel(modelId, state?.app.harnessModels ?? [], state?.app.manifest?.models);
  if (!model) return `${modelId} is no longer available through the running harness. Choose another model or clear the saved choice.`;
  if (state?.app.health.harness.status !== "healthy") return state?.app.health.harness.reason ?? "The harness is not running.";
  const reason = harnessModelUnavailableReason(state, model, needsImages, needsTools);
  return reason ? `${harnessModelLabel(state, model)} ${reason.startsWith("cannot") ? "" : "is "}${reason}.` : undefined;
}

export function HarnessModelOptions({
  state,
  selected,
  needsImages = false,
  needsTools = false,
}: {
  state: ClientState | null;
  selected?: string;
  needsImages?: boolean;
  needsTools?: boolean;
}) {
  const models = state?.app.harnessModels ?? [];
  const resolved = selected ? findHarnessModel(selected, models, state?.app.manifest?.models) : undefined;
  const byProvider = new Map<string, ModelInfo[]>();
  for (const model of models) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  const checking = state?.app.health.harness.status !== "healthy" ||
    state?.app.harnessModelStatus?.status !== "ready";
  return (
    <>
      {/* A catalogue still loading has not lost the saved model yet; a failed one cannot run it either. */}
      {selected && (!resolved || harnessModelReference(resolved) !== selected) && (
        <option value={selected} disabled>
          {resolved ? harnessModelLabel(state, resolved) : selected}{resolved ? " · saved" : state?.app.harnessModelStatus?.status === "loading" ? " · checking" : " · unavailable"}
        </option>
      )}
      {[...byProvider.entries()].map(([provider, list]) => (
        <optgroup key={provider} label={Object.entries(PROVIDERS).find(([id]) => id === provider)?.[1].displayName ?? provider}>
          {[...list].sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false)).map((model) => {
            const reason = harnessModelUnavailableReason(state, model, needsImages, needsTools);
            return (
              <option
                key={harnessModelReference(model)}
                value={harnessModelReference(model)}
                disabled={checking || reason !== undefined}
              >
                {harnessModelLabel(state, model)}{reason ? ` · ${reason}` : model.isDefault ? " · provider default" : ""}
                {needsImages && !model.inputModalities ? " · image support unreported" : ""}
              </option>
            );
          })}
        </optgroup>
      ))}
    </>
  );
}

/**
 * Whether the models' own status has anything to say. A chat composer names its model in a chip
 * and says nothing of the catalogue while it is simply fine (design turn 190e): only a catalogue
 * still loading, a failed one, an empty one or a harness that is not running earns a line.
 */
export function harnessModelsNeedAWord(state: ClientState | null): boolean {
  return state?.app.harnessModelStatus?.status !== "ready" ||
    (state?.app.harnessModels ?? []).length === 0 ||
    state?.app.health.harness.status !== "healthy";
}

export function HarnessModelStatus({ state }: { state: ClientState | null }) {
  const status = state?.app.harnessModelStatus;
  const healthy = state?.app.health.harness.status === "healthy";
  const models = state?.app.harnessModels ?? [];
  const message = status?.status === "loading"
    ? `Loading models from ${runningHarnessLabel(state)}…`
    : status?.status === "error"
      ? status.reason ?? "Model discovery failed."
      : !healthy
        ? state?.app.health.harness.reason ?? "The harness is not running."
        : status?.status !== "ready"
          ? models.length > 0 ? "Models need to be refreshed." : "Model discovery has not started."
          : models.length === 0 ? "The harness returned no models." : `${models.length} ${models.length === 1 ? "model" : "models"} from ${runningHarnessLabel(state)}`;
  return (
    <div className="fy-set__note" role="status">
      {message}
      {status?.status !== "loading" && (status?.status !== "ready" || models.length === 0) && (
        <> <button type="button" className="fy-set__link" onClick={() => listHarnessModels()}>Retry models</button></>
      )}
    </div>
  );
}
