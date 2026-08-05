import { useState } from "react";
import {
  deriveCapabilityAvailability,
  estimateCharacterImageMicroUsd,
  formatMicroUsd,
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
  /** Images: the normalised tier. Absent when the model declares none, i.e. it is unverified. */
  tier?: SizeTier;
  /** Video: the provider's own word, because 720p is what that surface means. */
  resolution?: string;
}

const TIERS: SizeTier[] = ["1K", "2K", "4K"];

/**
 * The models this studio offers for a capability: in the manifest, switched on, and behind a key
 * that actually unlocks this capability.
 *
 * The provider half comes from deriveCapabilityAvailability rather than a `configured` check of
 * its own. A key that was tested and rejected stays `configured: true` — it is still stored — so
 * a plain `configured` filter offered every model behind a key the app already knows is dead,
 * and Settings said the capability was unavailable on the same screen.
 */
export function usableModels(
  state: ReturnType<typeof useStore>["state"],
  capability: "image" | "video",
): ManifestModel[] {
  const manifest = state?.app.manifest;
  if (!manifest) return [];
  const disabled = new Set(state?.app.models.disabled ?? []);
  const unlocked = new Set(
    deriveCapabilityAvailability(state?.app.providers ?? []).find((a) => a.capability === capability)?.via ?? [],
  );
  return manifest.models.filter(
    (model) =>
      model.capability === capability &&
      !disabled.has(model.id) &&
      (unlocked.has(model.provider) || PROVIDERS[model.provider].local === true),
  );
}

/**
 * Which model a surface will actually use, and whether it is stranded — asked once, here,
 * because every host that answered it for itself eventually disagreed with the bar beside it.
 * A screen that shows one model and dispatches another is the worst failure in this area.
 *
 *   · An explicit choice wins. If it has since become unusable it is shown, flagged, and blocked
 *     rather than swapped, because nobody re-routes on the user's behalf.
 *   · A saved routing default is treated the same way: shown and flagged when it cannot run.
 *   · With no saved default there is nothing to strand — the manifest's first row is an accident
 *     of file order, not a decision — so the first usable model answers instead.
 */
export function resolveModel(
  state: ReturnType<typeof useStore>["state"],
  capability: "image" | "video",
  chosenId?: string,
): { model: ManifestModel | null; stranded: ManifestModel | null } {
  const usable = usableModels(state, capability);
  const all = state?.app.manifest?.models ?? [];
  if (chosenId !== undefined) {
    const chosen = usable.find((m) => m.id === chosenId);
    if (chosen) return { model: chosen, stranded: null };
    const known = all.find((m) => m.id === chosenId) ?? null;
    return { model: known, stranded: known };
  }
  const savedId = state?.app.routing.defaults[capability];
  if (savedId !== undefined) {
    const saved = usable.find((m) => m.id === savedId);
    if (saved) return { model: saved, stranded: null };
    const known = all.find((m) => m.id === savedId) ?? null;
    return { model: known, stranded: known };
  }
  return { model: usable[0] ?? null, stranded: null };
}

/**
 * Why a model cannot run, in the words of its repair. Switched off and no key are both
 * "unavailable" and are fixed in different places, so saying one when the other is true sends
 * the user to the wrong screen — the same distinction Who does what makes.
 */
function strandReason(state: ReturnType<typeof useStore>["state"], model: ManifestModel): string {
  if ((state?.app.models.disabled ?? []).includes(model.id)) return "turned off in Providers";
  const status = (state?.app.providers ?? []).find((p) => p.id === model.provider);
  if (status?.configured !== true) return `no ${PROVIDERS[model.provider].displayName} key`;
  return `the ${PROVIDERS[model.provider].displayName} key does not unlock this`;
}

/**
 * The choice after picking a model from the list. A tier the new model cannot reach is dropped
 * rather than carried: the bar falls back to that model's first size on screen, and a host that
 * reads the tier out of its own state would otherwise plan and dispatch at a size nothing on the
 * screen was showing.
 */
export function choiceForModel(
  candidate: ManifestModel,
  choice: { tier?: SizeTier },
): { modelId: string; tier?: SizeTier } {
  const keep = choice.tier !== undefined && tiersFor(candidate).includes(choice.tier);
  return { modelId: candidate.id, ...(keep ? { tier: choice.tier } : {}) };
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
  variant = "full",
  size = true,
}: {
  workflow: CharacterImageWorkflow;
  capability?: "image" | "video";
  /** Omit to leave the control out entirely: absent beats disabled where it would mean nothing. */
  count?: number;
  onCount?: (count: number) => void;
  /** Per generated image, for the estimate. The bar does not decide what rides along. */
  referenceImages?: number;
  choice: { modelId?: string; tier?: SizeTier; resolution?: string };
  onChoice: (choice: { modelId?: string; tier?: SizeTier; resolution?: string }) => void;
  onCancel?: () => void;
  primaryLabel?: string;
  onPrimary?: (chosen: DispatchChoice) => void;
  primaryDisabled?: boolean;
  /**
   * "controls" leaves out the figure and the buttons: some hosts already own their own action
   * and their own estimate — scene dispatch offers two modes with a price each — and duplicating
   * either would put two numbers on one screen that could disagree.
   */
  variant?: "full" | "controls";
  /**
   * False where the host's request carries no output spec — world key art sends a model id and
   * nothing else. Offering a size there set a value nobody read: the picker said 4K and the
   * provider's default ran. A control that cannot reach the request has no business being drawn.
   */
  size?: boolean;
}) {
  const { state } = useStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const models = usableModels(state, capability);
  const routedId = state?.app.routing.defaults[capability];
  const { model, stranded } = resolveModel(state, capability, choice.modelId);
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
          {/* Only where the host gave us actions to render. A controls-only surface passes none,
              and drawing a Cancel with no handler beside an unlabelled disabled button gave those
              screens two dead controls where the explanation was the whole point. */}
          {variant === "full" && onCancel && primaryLabel && (
            <span className="fy-dispatchbar__group">
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button variant="primary" disabled>
                {primaryLabel}
              </Button>
            </span>
          )}
        </div>
      </div>
    );
  }

  const isVideo = capability === "video";
  const reachable = tiersFor(model);
  const videoSizes = model.limits.resolutions ?? [];
  // Tiers are offered, with the unreachable ones disabled so the reason is visible — but only
  // when the model reaches any at all. A model that takes a free width and height (fal's GPT
  // Image 2) declares no tiers, and greying out all three would state a limit it does not have.
  const sizeOptions: string[] = isVideo ? videoSizes : reachable.length > 0 ? TIERS : [];
  const active = isVideo
    ? (choice.resolution !== undefined && videoSizes.includes(choice.resolution)
        ? choice.resolution
        : videoSizes[0])
    : (choice.tier !== undefined && reachable.includes(choice.tier) ? choice.tier : reachable[0]);
  // No size control means no size travels: the estimate and the detail line say provider default
  // because that is what will run, rather than pricing a tier the request cannot carry.
  const tier = isVideo || !size ? undefined : (active as SizeTier | undefined);
  const images = count ?? 1;
  const carried = model.unverified === true ? 0 : Math.min(referenceImages, model.accepts.referenceImages);
  const estimate = estimateCharacterImageMicroUsd(model, workflow, images, carried * images, tier);
  // DEFAULT means the saved routing default. With none saved nothing is the default — the model
  // showing is simply the first that can run, and calling that a default would invent a setting.
  const isDefault = model.id === routedId;

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
                onChoice(choiceForModel(candidate, choice));
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

        {size && (
        <span className="fy-dispatchbar__seg">
          <span className="fy-dispatchbar__eyebrow">SIZE</span>
          {sizeOptions.length === 0 ? (
            <span className="fy-dispatchbar__fixed">provider default</span>
          ) : (
            <span>
              {sizeOptions.map((value) => {
                const canReach = isVideo || reachable.includes(value as SizeTier);
                return (
                  <button
                    type="button"
                    key={value}
                    disabled={!canReach}
                    aria-pressed={value === active}
                    title={canReach ? undefined : `${model.displayName} does not reach ${value}`}
                    className={value === active ? "is-active" : ""}
                    onClick={() =>
                      onChoice(
                        isVideo ? { ...choice, resolution: value } : { ...choice, tier: value as SizeTier },
                      )
                    }
                  >
                    {value}
                  </button>
                );
              })}
            </span>
          )}
        </span>
        )}

        {variant === "full" && onCancel && primaryLabel && onPrimary && (
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
                  ...(isVideo && active !== undefined ? { resolution: active } : {}),
                })
              }
            >
              {primaryLabel}
            </Button>
          </span>
        )}
      </div>
      <div className="fy-dispatchbar__detail">
        {stranded ? `${model.displayName} · unavailable, ${strandReason(state, stranded)}` : modelDetail(model, tier, isDefault)}
      </div>
    </div>
  );
}
