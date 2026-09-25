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
export function runningHarnessLabel(state: ClientState | null): string {
  const generation = state?.app.harnessInfo?.generation;
  return generation === "claude" ? "Claude Code" : generation === "codex" ? "Codex" : generation === "arke" ? "Local"
    : generation === "v1" || generation === "v2" ? "OpenCode" : "the running harness";
}

export function harnessModelUnavailableReason(
  state: ClientState | null,
  model: ModelInfo,
  needsImages = false,
): string | undefined {
  const manifest = state?.app.manifest?.models;
  if (harnessModelDisabled(model, state?.app.models.disabled ?? [], manifest)) {
    return "turned off in AI models";
  }
  const entry = harnessModelManifestEntry(model, manifest);
  // A harness's own login is independent of the provider keys used for media generation.
  if (entry && PROVIDERS[entry.provider].local && !modelEligible(entry, eligibilityInputs(state))) {
    return "local model unavailable";
  }
  const missingInput = harnessModelMissingInput(model, needsImages);
  if (missingInput === "text") return "cannot read text";
  if (missingInput === "image") {
    return "text only · Stage needs images";
  }
  return undefined;
}

export function HarnessModelOptions({
  state,
  selected,
  needsImages = false,
}: {
  state: ClientState | null;
  selected?: string;
  needsImages?: boolean;
}) {
  const models = state?.app.harnessModels ?? [];
  const resolved = selected ? findHarnessModel(selected, models, state?.app.manifest?.models) : undefined;
  const byProvider = new Map<string, ModelInfo[]>();
  for (const model of models) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  const checking = state?.app.health.harness.status !== "healthy" ||
    state?.app.harnessModelStatus?.status !== "ready";
  return (
    <>
      {selected && (!resolved || harnessModelReference(resolved) !== selected) && (
        <option value={selected} disabled>
          {resolved?.displayName ?? selected}{resolved ? " · saved" : " · unavailable"}
        </option>
      )}
      {[...byProvider.entries()].map(([provider, list]) => (
        <optgroup key={provider} label={provider}>
          {[...list].sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false)).map((model) => {
            const reason = harnessModelUnavailableReason(state, model, needsImages);
            return (
              <option
                key={harnessModelReference(model)}
                value={harnessModelReference(model)}
                disabled={checking || reason !== undefined}
              >
                {model.displayName ?? model.id}{reason ? ` · ${reason}` : model.isDefault ? " · provider default" : ""}
                {needsImages && !model.inputModalities ? " · image support unreported" : ""}
              </option>
            );
          })}
        </optgroup>
      ))}
    </>
  );
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
          : models.length === 0 ? "The harness returned no models." : `${models.length} models from ${runningHarnessLabel(state)}`;
  return (
    <div className="fy-set__note" role="status">
      {message}
      {status?.status !== "loading" && (status?.status !== "ready" || models.length === 0) && (
        <> <button type="button" className="fy-set__link" onClick={() => listHarnessModels()}>Retry models</button></>
      )}
    </div>
  );
}
