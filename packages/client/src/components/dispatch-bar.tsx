import { useState } from "react";
import {
  estimateCharacterImageMicroUsd,
  formatMicroUsd,
  modelForCapability,
  PROVIDERS,
  tiersFor,
  type CharacterImageWorkflow,
  type ManifestModel,
  type SizeTier,
} from "@arke-studio/contracts";
import { useStore } from "../lib/store.js";
import { Button } from "./ui.js";

/**
 * The line that says what will run and what it costs, turned into the line that chooses
 * (design-system turn 39).
 *
 * One component for every surface that generates an image, because the alternative was five
 * partial versions: main photo had a count and no model, the sheet had neither, dispatch had a
 * model and no size, and nowhere could choose a resolution at all.
 *
 * Three rules it exists to keep:
 *
 *   · The figure is live. It recomputes from model x count x size on every change, before
 *     anything is spent, because an estimate that only appears at the end is a receipt.
 *   · A size a model cannot reach is shown disabled, never hidden — the reason is the point.
 *   · The picker lists only models a stored key can reach. An unreachable model is not a
 *     choice, and keys are managed in Settings rather than mid-generation.
 *
 * The row wraps: hosts run from a wide dialog to a 370px side panel, and the figure travels
 * with the buttons so it is never orphaned at the left of a new line.
 */

export interface DispatchChoice {
  model: ManifestModel;
  /** Absent where the surface makes one thing — a character sheet is one composite. */
  count?: number;
  /** Absent when the chosen model declares no tiers, i.e. it is unverified. */
  tier?: SizeTier;
}

const TIERS: readonly SizeTier[] = ["1K", "2K", "4K"];

/** The models this studio offers for a capability: in the manifest, keyed, and switched on. */
export function usableModels(
  state: ReturnType<typeof useStore>["state"],
  capability: "image" | "video",
): ManifestModel[] {
  const manifest = state?.app.manifest;
  if (!manifest) return [];
  const disabled = new Set(state?.app.models.disabled ?? []);
  const configured = new Set((state?.app.providers ?? []).filter((p) => p.configured).map((p) => p.id));
  return manifest.models.filter(
    (model) =>
      model.capability === capability &&
      !disabled.has(model.id) &&
      (configured.has(model.provider) || PROVIDERS[model.provider].local === true),
  );
}

/** What the chosen model will carry, said once the choice is made rather than argued in the list. */
export function modelDetail(model: ManifestModel, tier: SizeTier | undefined, isDefault: boolean): string {
  const references =
    model.unverified === true || model.accepts.referenceImages === 0
      ? "no references"
      : `up to ${model.accepts.referenceImages} references`;
  const size = tier ?? "provider default";
  const parts = [model.displayName, references, `${size}`];
  if (model.unverified === true) parts.push("unverified");
  if (!isDefault) parts.push("one-shot, default unchanged");
  return parts.join(" · ");
}

export function DispatchBar({
  workflow,
  capability = "image",
  count,
  onCount,
  referenceImages = 0,
  choice,
  onChoice,
  onCancel,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
}: {
  workflow: CharacterImageWorkflow;
  capability?: "image" | "video";
  /** Omit to leave the control out entirely: absent beats disabled where it would mean nothing. */
  count?: number;
  onCount?: (count: number) => void;
  /** Per generated image, for the estimate. The bar does not decide what rides along. */
  referenceImages?: number;
  choice: { modelId?: string; tier?: SizeTier };
  onChoice: (choice: { modelId?: string; tier?: SizeTier }) => void;
  onCancel: () => void;
  primaryLabel: string;
  onPrimary: (chosen: DispatchChoice) => void;
  primaryDisabled?: boolean;
}) {
  const { state } = useStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const models = usableModels(state, capability);
  const routedId = state?.app.routing.defaults[capability];
  const routed = state?.app.manifest
    ? modelForCapability(state.app.manifest, state.app.routing.defaults, capability)
    : null;

  const chosen = models.find((m) => m.id === choice.modelId) ?? null;
  // A model can be chosen and then switched off in Providers. Keep showing it and say it cannot
  // run, rather than quietly moving the job to something else.
  const stranded =
    choice.modelId !== undefined && chosen === null
      ? (state?.app.manifest?.models.find((m) => m.id === choice.modelId) ?? null)
      : null;
  const model = chosen ?? stranded ?? routed;
  // No model at all — no key, or nothing of this capability in the manifest. The bar stays,
  // because vanishing would take Cancel and the explanation with it and leave a dialog with no
  // way out and no reason given.
  if (!model) {
    return (
      <div className="fy-dispatchbar" data-testid="dispatch-bar">
        <div className="fy-dispatchbar__row">
          <span className="fy-dispatchbar__fixed">
            No {capability} model is available — add a provider key in Settings.
          </span>
          <span className="fy-dispatchbar__group">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" disabled>
              {primaryLabel}
            </Button>
          </span>
        </div>
      </div>
    );
  }

  const reachable = tiersFor(model);
  const tier = choice.tier !== undefined && reachable.includes(choice.tier) ? choice.tier : reachable[0];
  const images = count ?? 1;
  const carried = model.unverified === true ? 0 : Math.min(referenceImages, model.accepts.referenceImages);
  const estimate = estimateCharacterImageMicroUsd(model, workflow, images, carried * images, tier);
  const isDefault = model.id === routedId || (routedId === undefined && model.id === routed?.id);

  return (
    <div className="fy-dispatchbar" data-testid="dispatch-bar">
      {pickerOpen && (
        <div className="fy-dispatchbar__picker" role="listbox" aria-label="Image models">
          <span className="fy-dispatchbar__eyebrow">
            {capability === "video" ? "VIDEO MODELS" : "IMAGE MODELS"}
          </span>
          {models.map((candidate) => (
            <button
              type="button"
              key={candidate.id}
              role="option"
              aria-selected={candidate.id === model.id}
              className={candidate.id === model.id ? "is-selected" : ""}
              onClick={() => {
                onChoice({ modelId: candidate.id, ...(choice.tier ? { tier: choice.tier } : {}) });
                setPickerOpen(false);
              }}
            >
              <span className="fy-dispatchbar__provider">{PROVIDERS[candidate.provider].displayName}</span>
              <span>{candidate.displayName}</span>
              {candidate.unverified === true && <em>UNVERIFIED</em>}
              {candidate.id === routedId && <strong>DEFAULT</strong>}
            </button>
          ))}
          <div className="fy-dispatchbar__pickerfoot">
            <span>This generation only.</span>
            <span>more models · add a key in Settings</span>
          </div>
        </div>
      )}
      <div className="fy-dispatchbar__row">
        <button
          type="button"
          className="fy-dispatchbar__pill"
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen(!pickerOpen)}
        >
          <span className="fy-dispatchbar__provider">{PROVIDERS[model.provider].displayName}</span>
          <span>{model.displayName}</span>
          {model.unverified === true && <em>UNVERIFIED</em>}
          {stranded && <em>UNAVAILABLE</em>}
          {isDefault && !stranded && <strong>DEFAULT</strong>}
        </button>

        {count !== undefined && onCount && (
          <span className="fy-dispatchbar__seg">
            <span className="fy-dispatchbar__eyebrow">PREVIEWS</span>
            <span>
              {[1, 2, 3, 4].map((value) => (
                <button
                  type="button"
                  key={value}
                  className={value === count ? "is-active" : ""}
                  aria-pressed={value === count}
                  onClick={() => onCount(value)}
                >
                  {value}
                </button>
              ))}
            </span>
          </span>
        )}

        <span className="fy-dispatchbar__seg">
          <span className="fy-dispatchbar__eyebrow">SIZE</span>
          {reachable.length === 0 ? (
            <span className="fy-dispatchbar__fixed">provider default</span>
          ) : (
            <span>
              {TIERS.map((value) => {
                const canReach = reachable.includes(value);
                return (
                  <button
                    type="button"
                    key={value}
                    disabled={!canReach}
                    aria-pressed={value === tier}
                    title={canReach ? undefined : `${model.displayName} does not reach ${value}`}
                    className={value === tier ? "is-active" : ""}
                    onClick={() => onChoice({ ...choice, tier: value })}
                  >
                    {value}
                  </button>
                );
              })}
            </span>
          )}
        </span>

        <span className="fy-dispatchbar__group">
          <span className="fy-dispatchbar__estimate">~{formatMicroUsd(estimate)}</span>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={primaryDisabled || stranded !== null}
            onClick={() =>
              onPrimary({
                model,
                ...(count !== undefined ? { count } : {}),
                ...(tier !== undefined ? { tier } : {}),
              })
            }
          >
            {primaryLabel}
          </Button>
        </span>
      </div>
      <div className="fy-dispatchbar__detail">
        {stranded
          ? `${model.displayName} · unavailable, turned off in Providers`
          : modelDetail(model, tier, isDefault)}
      </div>
    </div>
  );
}
