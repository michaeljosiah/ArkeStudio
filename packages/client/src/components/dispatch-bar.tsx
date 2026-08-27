import { useState } from "react";
import { useParams } from "react-router";
import {
  aspectOffered,
  deriveCapabilityAvailability,
  estimateCharacterImageMicroUsd,
  estimateImageMicroUsd,
  formatMicroUsd,
  isLandscapeWorkflow,
  MAX_IMAGE_PREVIEWS,
  offeredAspects,
  PROVIDERS,
  tiersFor,
  type CharacterImageWorkflow,
  type Capability,
  type ManifestModel,
  type SizeTier,
} from "@arke-studio/contracts";
import { setProductionModel, useStore } from "../lib/store.js";
import { ChevronDown } from "./icons.js";
import { Button } from "./ui.js";

/**
 * The counts the control offers, from the one number that caps them (design 65). Derived rather
 * than written out, so raising the cap moves the frame's validation, the request fan-out and this
 * row together — they are the same decision and they charge the same money.
 */
const PREVIEW_COUNTS = Array.from({ length: MAX_IMAGE_PREVIEWS }, (_, i) => i + 1);

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
  /** The shape, where the surface offered one and the model declared which it takes. */
  aspect?: string;
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
/**
 * The readiness result for a local recipe (SPEC-021 §2.12) — the same one coordinator enqueue
 * admission reads, so the picker and the refusal can never disagree. Null means the model is
 * not a recipe, or the combined status has not arrived yet.
 */
export function recipeReadinessFor(
  state: ReturnType<typeof useStore>["state"],
  modelId: string,
): NonNullable<NonNullable<ReturnType<typeof useStore>["state"]>["app"]["comfyui"]>["recipes"][number] | null {
  return state?.app.comfyui?.recipes.find((recipe) => recipe.recipeId === modelId) ?? null;
}

/** Local recipes of a capability that cannot run right now — listed disabled with the reason (R-10). */
export function disabledRecipes(
  state: ReturnType<typeof useStore>["state"],
  capability: Capability,
): Array<{ model: ManifestModel; reason: string }> {
  const manifest = state?.app.manifest;
  if (!manifest) return [];
  const out: Array<{ model: ManifestModel; reason: string }> = [];
  for (const model of manifest.models) {
    if (model.capability !== capability || model.provider !== "comfyui") continue;
    const readiness = recipeReadinessFor(state, model.id);
    const unreadyVoice =
      capability === "voice-tts" &&
      readiness?.state === "unknown" &&
      state?.app.comfyui?.engine.locality === "local";
    if (readiness?.state === "disabled" || unreadyVoice) {
      out.push({ model, reason: readiness.reason ?? "not ready for dispatch" });
    }
  }
  return out;
}

export function usableModels(
  state: ReturnType<typeof useStore>["state"],
  // A capability, not a bench mode: `voice` dispatches against `voice-tts`, so the caller maps
  // through modeCapability rather than handing a mode name straight in (design 70).
  capability: Capability,
): ManifestModel[] {
  const manifest = state?.app.manifest;
  if (!manifest) return [];
  const disabled = new Set(state?.app.models.disabled ?? []);
  const unlocked = new Set(
    deriveCapabilityAvailability(state?.app.providers ?? []).find((a) => a.capability === capability)?.via ?? [],
  );
  return manifest.models.filter((model) => {
    if (model.capability !== capability || disabled.has(model.id)) return false;
    if (!unlocked.has(model.provider) && PROVIDERS[model.provider].local !== true) return false;
    // A local recipe below readiness is not usable — it stays visible in the picker as a
    // disabled row with its measured reason (disabledRecipes), and coordinator admission
    // refuses it regardless (SPEC-021 R-16). Unknown image/video hardware still runs (D15);
    // cloned voice stays off until this build has proven the full use can complete.
    if (model.provider === "comfyui") {
      const readiness = recipeReadinessFor(state, model.id);
      if (
        readiness === null ||
        readiness.state === "disabled" ||
        (capability === "voice-tts" &&
          readiness.state === "unknown" &&
          state?.app.comfyui?.engine.locality === "local")
      ) return false;
    }
    return true;
  });
}

/**
 * The model this production reaches for, for a capability (SPEC-033 R-74, R-77).
 *
 * Read from the production's own record rather than from app settings: production ids are
 * world-scoped, so an installation-level store would collide across two copies of a world and
 * lose the choice when the world moved to another machine.
 */
export function productionModel(
  state: ReturnType<typeof useStore>["state"],
  productionId: string | undefined,
  capability: Capability,
): string | undefined {
  if (productionId === undefined) return undefined;
  return state?.world?.productions.find((p) => p.meta.id === productionId)?.meta.models?.[capability];
}

/**
 * Which model this surface will use, with the production's choice already in it.
 *
 * The hook rather than the function, everywhere inside a production. `resolveModel` takes the
 * remembered id as an argument, and an argument a caller can forget is an argument some caller
 * will: the dispatch dialog priced its cards and sent its request through the plain function
 * while the bar three lines below it resolved with the production's choice, so the screen named
 * one model and spent on another — the exact silent substitution R-78 forbids.
 */
export function useResolvedModel(
  state: ReturnType<typeof useStore>["state"],
  capability: "image" | "video",
  chosenId?: string,
): { model: ManifestModel | null; stranded: ManifestModel | null; remembered: string | undefined } {
  const { prodId } = useParams<{ prodId?: string }>();
  const remembered = productionModel(state, prodId, capability);
  return { ...resolveModel(state, capability, chosenId, remembered), remembered };
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
  /**
   * The production's own choice, where the surface is inside one (R-77). It seeds the picker and
   * does not lock it: an explicit per-dispatch choice still wins, and a stored reference that
   * cannot be honoured is *stated* rather than swapped — R-78, and the same shape a stranded
   * routing default already had, because falling back quietly is how somebody discovers they
   * spent money three weeks later.
   */
  productionModelId?: string,
): { model: ManifestModel | null; stranded: ManifestModel | null } {
  const usable = usableModels(state, capability);
  const all = state?.app.manifest?.models ?? [];
  for (const candidateId of [chosenId, productionModelId, state?.app.routing.defaults[capability]]) {
    if (candidateId === undefined) continue;
    const usableCandidate = usable.find((m) => m.id === candidateId);
    if (usableCandidate) return { model: usableCandidate, stranded: null };
    const known = all.find((m) => m.id === candidateId) ?? null;
    return { model: known, stranded: known };
  }
  return { model: usable[0] ?? null, stranded: null };
}

/**
 * Why a model cannot run, in the words of its repair. Switched off and no key are both
 * "unavailable" and are fixed in different places, so saying one when the other is true sends
 * the user to the wrong screen — the same distinction Who does what makes.
 */
export function strandReason(state: ReturnType<typeof useStore>["state"], model: ManifestModel): string {
  if ((state?.app.models.disabled ?? []).includes(model.id)) return "turned off in Providers";
  // A stranded local recipe carries its readiness reason — the measured one, never key advice
  // for a provider that takes no key (SPEC-021 R-10).
  if (model.provider === "comfyui") {
    return recipeReadinessFor(state, model.id)?.reason ?? "the local engine is not ready";
  }
  const status = (state?.app.providers ?? []).find((p) => p.id === model.provider);
  const info = PROVIDERS[model.provider];
  // Not every provider takes a key, and telling someone to paste one they can never paste
  // sends them to a field that does not exist (issue 137).
  if (info.credential === "external") {
    if (status?.configured !== true) return `not signed in to ${info.displayName}`;
    return `this ${info.displayName} account does not unlock this`;
  }
  if (status?.configured !== true) return `no ${info.displayName} key`;
  return `the ${info.displayName} key does not unlock this`;
}

/**
 * The choice after picking a model from the list. A tier or a shape the new model cannot reach is
 * dropped rather than carried: the bar falls back to that model's own first option on screen, and
 * a host that reads either out of its own state would otherwise plan and dispatch at a size or an
 * aspect nothing on the screen was showing.
 */
export function choiceForModel(
  candidate: ManifestModel,
  choice: { tier?: SizeTier; aspect?: string },
): { modelId: string; tier?: SizeTier; aspect?: string } {
  const keepTier = choice.tier !== undefined && tiersFor(candidate).includes(choice.tier);
  const keepAspect = choice.aspect !== undefined && aspectOffered(candidate, choice.aspect);
  return {
    modelId: candidate.id,
    ...(keepTier ? { tier: choice.tier } : {}),
    ...(keepAspect ? { aspect: choice.aspect } : {}),
  };
}

/**
 * The size and shape this bar will actually send, for a model and a choice.
 *
 * Exported because the host has to send them and the bar has to draw them, and those two answers
 * must be one answer. A choice is not the same as what will run: a model change can leave a tier
 * or an aspect selected that the new row does not reach, and both fall back to that row's own
 * first option — on screen and on the wire, or the request disagrees with the picture of it.
 */
export function resolveOutputChoice(
  model: ManifestModel,
  choice: { tier?: SizeTier; aspect?: string },
  options: { size?: boolean; aspect?: boolean; landscape?: boolean } = {},
): { tier?: SizeTier; aspect?: string } {
  const tiers = tiersFor(model);
  // Orientation matters here and not only for display: it decides which shape is first, and the
  // first shape is the default this returns when nothing was chosen.
  const aspects =
    options.aspect === true ? offeredAspects(model, { landscape: options.landscape ?? false }) : [];
  const tier =
    options.size === false
      ? undefined
      : choice.tier !== undefined && tiers.includes(choice.tier)
        ? choice.tier
        : tiers[0];
  const aspect =
    choice.aspect !== undefined && aspects.includes(choice.aspect) ? choice.aspect : aspects[0];
  return { ...(tier !== undefined ? { tier } : {}), ...(aspect !== undefined ? { aspect } : {}) };
}

/** What the chosen model will carry, said once the choice is made rather than argued in the list. */
export function modelDetail(
  model: ManifestModel,
  tier: SizeTier | undefined,
  isDefault: boolean,
  aspect?: string,
): string {
  const references =
    model.unverified === true || model.accepts.referenceImages === 0
      ? "no references"
      : `up to ${model.accepts.referenceImages} references`;
  const size = tier ?? "provider default";
  const parts = [model.displayName, references, `${size}`];
  if (aspect !== undefined) parts.push(aspect);
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
  aspect = false,
  landscape,
}: {
  workflow: CharacterImageWorkflow;
  capability?: "image" | "video";
  /** Omit to leave the control out entirely: absent beats disabled where it would mean nothing. */
  count?: number;
  onCount?: (count: number) => void;
  /** Per generated image, for the estimate. The bar does not decide what rides along. */
  referenceImages?: number;
  choice: { modelId?: string; tier?: SizeTier; resolution?: string; aspect?: string };
  onChoice: (choice: { modelId?: string; tier?: SizeTier; resolution?: string; aspect?: string }) => void;
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
  /**
   * Whether the shape is the author's to choose. Off by default, because most surfaces have a
   * shape the work itself decides — a head-and-shoulders portrait is not a 16:9 decision — and
   * only where the picture is the deliverable does asking make sense. Even then the control
   * appears only if the model declares which shapes it takes.
   */
  aspect?: boolean;
  /**
   * Which way round this surface's output is. Defaults to what the workflow implies, which is
   * right wherever the workflow is the real one; a host that borrowed a workflow for its price
   * band while making something the other way round says so here, because orientation decides
   * the default shape and the base the estimate is computed from.
   */
  landscape?: boolean;
}) {
  const { state } = useStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const models = usableModels(state, capability);
  const routedId = state?.app.routing.defaults[capability];
  // The production, where this bar is inside one. Taken from the address rather than threaded
  // through every host: `generation-dialog` is rendered from world-scoped surfaces too, and a
  // prop that half its callers cannot fill is a prop that gets filled wrongly.
  const { prodId, worldId } = useParams<{ prodId?: string; worldId?: string }>();
  const { model, stranded, remembered } = useResolvedModel(state, capability, choice.modelId);
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
  const wide = landscape ?? isLandscapeWorkflow(workflow);
  // One resolver for the highlight and for the wire, so the segment cannot show 2K while the
  // request carries 1K after a model change dropped an unreachable tier.
  const resolved = resolveOutputChoice(model, choice, { aspect, landscape: wide });
  const active = isVideo
    ? (choice.resolution !== undefined && videoSizes.includes(choice.resolution)
        ? choice.resolution
        : videoSizes[0])
    : resolved.tier;
  // No size control means no size travels: the estimate and the detail line say provider default
  // because that is what will run, rather than pricing a tier the request cannot carry.
  const tier = isVideo || !size ? undefined : resolved.tier;
  // What this model will actually take, in its own order — an empty list is a model that has not
  // said, and the control is then absent rather than drawn over a guess.
  const aspects = aspect && !isVideo ? offeredAspects(model, { landscape: wide }) : [];
  const chosenAspect = isVideo ? undefined : resolved.aspect;
  const images = count ?? 1;
  const carried = model.unverified === true ? 0 : Math.min(referenceImages, model.accepts.referenceImages);
  const estimate = isVideo
    ? estimateCharacterImageMicroUsd(model, workflow, images, carried * images, tier)
    : estimateImageMicroUsd(model, {
        images,
        referenceImages: carried * images,
        landscape: wide,
        ...(tier !== undefined ? { tier } : {}),
        ...(chosenAspect !== undefined ? { aspect: chosenAspect } : {}),
      });
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
              {candidate.id === remembered && <strong>THIS PRODUCTION</strong>}
              {candidate.id === routedId && candidate.id !== remembered && <strong>DEFAULT</strong>}
            </button>
          ))}
          {/* Local recipes that cannot run stay visible, disabled, with the measured reason —
              never quietly absent (SPEC-021 R-10). The same readiness result the coordinator's
              enqueue admission enforces, so this list and a refusal can never disagree. */}
          {disabledRecipes(state, capability).map(({ model: recipe, reason }) => (
            <button type="button" key={recipe.id} role="option" aria-selected={false} disabled title={reason}>
              <span className="fy-dispatchbar__provider">{PROVIDERS[recipe.provider].displayName}</span>
              <span>{recipe.displayName}</span>
              <em>{reason}</em>
            </button>
          ))}
          <div className="fy-dispatchbar__pickerfoot">
            {prodId !== undefined && worldId !== undefined ? (
              <button
                type="button"
                className="fy-linkbtn"
                style={{ font: "400 10.5px var(--font-sans)" }}
                onClick={() => {
                  setProductionModel(worldId, prodId, capability, remembered === model.id ? null : model.id);
                  setPickerOpen(false);
                }}
              >
                {remembered === model.id ? "This generation only" : "Remember for this production"}
              </button>
            ) : (
              <span>This generation only.</span>
            )}
            <span>more models · add a key in Settings</span>
          </div>
        </div>
      )}
      <div className="fy-dispatchbar__row">
        {/*
          A pill that opens a list, and looks like one.

          It has always been a button with a listbox behind it, and it read as a badge: no
          chevron, nothing saying there was anything else to pick. People took the routed default
          for a fixed fact about the surface. The count is the other half of that — "1 of 4" is a
          choice, "Flux 2 Pro" alone is an announcement — and both are dropped when there really
          is only one model, because an affordance that opens a list of one is a small lie.
        */}
        <button
          type="button"
          className="fy-dispatchbar__pill"
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          aria-label={
            models.length > 1
              ? `Model: ${model.displayName} · ${models.length} available`
              : `Model: ${model.displayName}`
          }
          onClick={() => setPickerOpen(!pickerOpen)}
        >
          <span className="fy-dispatchbar__provider">{PROVIDERS[model.provider].displayName}</span>
          <span>{model.displayName}</span>
          {model.unverified === true && <em>UNVERIFIED</em>}
          {stranded && <em>UNAVAILABLE</em>}
          {/* The production's own choice outranks the installation's default and says so, so the
              two are never both claimed on one pill. */}
          {remembered === model.id && !stranded && <strong>THIS PRODUCTION</strong>}
          {isDefault && remembered !== model.id && !stranded && <strong>DEFAULT</strong>}
          {models.length > 1 && (
            <>
              {/* One interpolation, not a number beside a word: React splits the latter with a
                  comment node, which puts a stray marker in the middle of the label. */}
              <span className="fy-dispatchbar__more">{`${models.length} models`}</span>
              <span className="fy-dispatchbar__chevron" aria-hidden>
                <ChevronDown size={13} />
              </span>
            </>
          )}
        </button>

        {count !== undefined && onCount && (
          <span className="fy-dispatchbar__seg">
            <span className="fy-dispatchbar__eyebrow">PREVIEWS</span>
            <span>
              {PREVIEW_COUNTS.map((value) => (
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

        {/* Only where the model said which shapes it takes. A row that never declared any is
            unverified or uncatalogued, and a picker over it would promise what nobody checked. */}
        {aspects.length > 0 && (
          <span className="fy-dispatchbar__seg">
            <span className="fy-dispatchbar__eyebrow">ASPECT</span>
            <span>
              {aspects.map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={value === chosenAspect}
                  className={value === chosenAspect ? "is-active" : ""}
                  onClick={() => onChoice({ ...choice, aspect: value })}
                >
                  {value}
                </button>
              ))}
            </span>
          </span>
        )}

        {/*
          The figure belongs to the controls, not to the buttons beside it (design 65).

          It used to render only in the `full` variant, bundled with Cancel and the primary — so
          the standard dialog, which draws its own actions and therefore asks for `controls`, has
          never priced anything. That was survivable while a dialog meant one image. It stopped
          being survivable the moment the count arrived: the count *is* money, four previews cost
          four times one, and a control that multiplies the bill silently is the one thing this
          bar exists to prevent.
        */}
        {!(variant === "full" && onCancel && primaryLabel && onPrimary) && (
          <span className="fy-dispatchbar__group">
            <span className="fy-dispatchbar__estimate">~{formatMicroUsd(estimate)}</span>
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
                  ...(chosenAspect !== undefined ? { aspect: chosenAspect } : {}),
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
        {stranded
          ? `${model.displayName} · unavailable, ${strandReason(state, stranded)}`
          : modelDetail(model, tier, isDefault, chosenAspect)}
      </div>
    </div>
  );
}
