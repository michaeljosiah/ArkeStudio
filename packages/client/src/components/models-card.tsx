import { useNavigate } from "react-router";
import {
  ENGINE_LABEL,
  PROVIDERS as PROVIDER_TABLE,
  engineOfProvider,
  modelEligible,
  type Capability,
  type ManifestModel,
  type ModelChoices,
  type ProviderId,
} from "@arke-studio/contracts";
import { IconButton, Select } from "./ui.js";
import { Cog, RotateCcw } from "./icons.js";
import { eligibilityInputs } from "./dispatch-bar.js";
import { CAPABILITY_LABEL, ProviderMark } from "../screens/settings-parts.js";

/** The card's labels: General's, shortened where a rail's label column cannot hold them. */
const CARD_LABEL: Partial<Record<Capability, string>> = { "voice-tts": "Voice" };
import type { useStore } from "../lib/store.js";

type State = ReturnType<typeof useStore>["state"];

/** What a world's own work makes (design turn 153): its images, its moving pictures, its voices. */
export const WORLD_MODEL_CAPABILITIES: readonly Capability[] = ["image", "video", "voice-tts"];
/** What a production makes: the world's three, and its score. */
export const PRODUCTION_MODEL_CAPABILITIES: readonly Capability[] = ["image", "video", "voice-tts", "music"];

/**
 * What a model row says about the model it holds, in the state cell's three words (design turn
 * 149). Shared by Settings › General and the Models card, because a card that called a model
 * `connected` while General called the same model `not tested` would be two answers to one
 * question.
 */
export function modelFacts(state: State) {
  const statuses = state?.app.providers ?? [];
  /**
   * Stored, tested, or neither — the three things Providers actually knows (SPEC-028 R-33), as
   * the state cell says them. `not tested` is muted and carries no dot (issue 991): a key nobody
   * has tried is not an unwell one.
   */
  const providerState = (id: ProviderId): string => {
    const status = statuses.find((p) => p.id === id);
    if (status?.configured !== true) return PROVIDER_TABLE[id].credential === "external" ? "not signed in" : "no key";
    if (status.validation === "valid") return "connected";
    if (status.validation === "invalid") return "key rejected";
    // `testing` is its own state and reads as one: a key mid-validation is not the same thing as
    // one nobody has tried, and the words are the ones the provider table actually has.
    return status.validation === "testing" ? "testing" : "not tested";
  };
  /**
   * Why a stranded model cannot run, in the state cell's three words. `strandReason` keeps the
   * sentence for the option list, where a row has room to say whose key is missing; here the
   * control already names the provider, so the state names only what is wrong with it.
   */
  const strandState = (model: ManifestModel): string => {
    if ((state?.app.models.disabled ?? []).includes(model.id)) return "turned off";
    const fit = (state?.app.runtime?.models ?? []).find((row) => row.modelId === model.id)?.fit;
    if (fit === "insufficient" || fit === "unsupported") return "cannot run here";
    if (PROVIDER_TABLE[model.provider].local) return "not ready";
    const status = statuses.find((p) => p.id === model.provider);
    if (status?.validation === "invalid") return "key rejected";
    if (status?.configured !== true) return providerState(model.provider);
    return "not unlocked";
  };
  /**
   * What to call the thing a model comes from, which is not the same word on both halves.
   *
   * A keyed service is its own source and names itself. A local model's is the **engine**, which
   * is what Providers' rail is keyed on: `Voxa · Kokoro 82M` rather than `Kokoro · Kokoro 82M`,
   * because the reader who wants to act on it goes to Voxa's pane. The id is what carries the
   * mark (SPEC-042 R-20), and the engine's mark is the engine's.
   */
  const sourceOf = (model: ManifestModel): { id: string; label: string } => {
    const engine = engineOfProvider(model.provider);
    return engine === undefined
      ? { id: model.provider, label: PROVIDER_TABLE[model.provider].displayName }
      : { id: engine, label: ENGINE_LABEL[engine] };
  };
  /**
   * Where a model actually runs (SPEC-034 R-16a), from the resolved engine rather than the
   * provider flag. `PROVIDERS.comfyui.local` is `true` for every recipe, so reading the flag
   * would tell someone their video drafts here while it renders on a box down the hall.
   */
  const runsOn = (model: ManifestModel): string => {
    if (!PROVIDER_TABLE[model.provider].local) return providerState(model.provider);
    const gated = (state?.app.runtime?.models ?? []).find((m) => m.modelId === model.id);
    const locality =
      gated?.locality ??
      (model.provider === "comfyui" ? (state?.app.comfyui?.engine.locality ?? "local") : "local");
    return locality === "remote" ? "another machine" : "this machine";
  };
  return { providerState, strandState, sourceOf, runsOn };
}

function Warn({ words }: { words: string }) {
  return (
    <span className="fy-fact__state fy-fact__state--warn">
      <span className="fy-set__dot fy-set__dot--warn" aria-hidden="true" />
      {words}
    </span>
  );
}

/**
 * The models a world or a production will make with (design turn 153).
 *
 * Two scopes, one parent: each row follows Settings' default until someone picks a model here,
 * and picking the default again is how the override ends — the key is removed rather than the
 * default's id written, so a later change in Settings still reaches every scope that never chose.
 * A production's card reads Settings, never its world's: the world's choice was for making the
 * world.
 *
 * The rows are General's grammar narrowed to a rail (turn 149): a label, the select with its
 * provider's mark, the state, and on an overridden row one reset. The state is `default` while
 * the row follows Settings and the scope's own word while it does not. An override that cannot
 * run keeps its warning; it is never swapped for another model (SPEC-033 R-77, R-78).
 *
 * The gear opens Settings at AI models over the screen, which stays mounted beneath the sheet
 * (turn 150): turning a model on or off there changes this card's options on return.
 */
export function ModelsCard({
  state,
  capabilities,
  choices,
  scopeWord,
  onChange,
  disabled = false,
}: {
  state: State;
  capabilities: readonly Capability[];
  choices: ModelChoices | undefined;
  /** What an overridden row says: `this world`, `this production`. */
  scopeWord: string;
  onChange: (capability: Capability, modelId: string | null) => void;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const manifest = state?.app.manifest ?? null;
  const defaults = state?.app.routing.defaults ?? {};
  const eligibility = eligibilityInputs(state);
  const { strandState, sourceOf, runsOn } = modelFacts(state);
  const name = (model: ManifestModel) => `${sourceOf(model).label} · ${model.displayName}`;

  return (
    <section className="fy-models" aria-label="Models" data-testid="models-card">
      <div className="fy-models__head">
        <h3>Models</h3>
        <IconButton label="AI models" onClick={() => navigate("/settings/models")}>
          <Cog size={15} />
        </IconButton>
      </div>
      {capabilities.map((capability) => {
        const all = (manifest?.models ?? []).filter((m) => m.capability === capability);
        const usable = (m: ManifestModel) => modelEligible(m, eligibility);
        const defaultId = defaults[capability];
        const defaultModel = all.find((m) => m.id === defaultId);
        const own = choices?.[capability];
        const ownModel = own === undefined ? undefined : all.find((m) => m.id === own);
        const shown = own === undefined ? defaultModel : ownModel;
        const source = shown === undefined ? undefined : sourceOf(shown);
        // The default is one row, first, named by the model it is today. Its model is not
        // listed again below it, and a model that is turned off or cannot run is not offered —
        // turning one on is Settings' job, and the gear is the way there.
        const offered = all.filter((m) => m.id !== defaultId && usable(m));
        const ownUnlisted = own !== undefined && !offered.some((m) => m.id === own);
        const label = CARD_LABEL[capability] ?? CAPABILITY_LABEL[capability];
        return (
          <div key={capability} className="fy-models__row">
            <span className="fy-models__what">{label}</span>
            <Select
              wrapClassName="fy-models__select"
              label={`Model for ${label}`}
              disabled={disabled || all.length === 0}
              value={own ?? ""}
              onChange={(e) => onChange(capability, e.target.value === "" ? null : e.target.value)}
              {...(source === undefined ? {} : { mark: <ProviderMark id={source.id} label={source.label} size="xs" /> })}
            >
              <option value="">{defaultModel ? `${name(defaultModel)} · default` : "Default · not set"}</option>
              {/* The stored choice stays visible when it can no longer be offered, so the control
                  shows what is kept rather than silently reading as the default. */}
              {ownUnlisted && <option value={own}>{ownModel ? name(ownModel) : own}</option>}
              {offered.map((m) => (
                <option key={m.id} value={m.id}>
                  {name(m)}
                </option>
              ))}
            </Select>
            {/* A kind with no default and no choice has no state: there is nothing to report on
                a model nobody chose (turn 149). */}
            {own === undefined ? (
              defaultModel !== undefined && <span className="fy-fact__state">default</span>
            ) : ownModel === undefined ? (
              <Warn words="not in the manifest" />
            ) : usable(ownModel) ? (
              <span className="fy-fact__state fy-models__own" title={runsOn(ownModel)}>
                {scopeWord}
              </span>
            ) : (
              <Warn words={strandState(ownModel)} />
            )}
            {own !== undefined && (
              <IconButton
                className="fy-models__reset"
                label="Use the default"
                hint={defaultModel ? name(defaultModel) : "Settings"}
                disabled={disabled}
                onClick={() => onChange(capability, null)}
              >
                <RotateCcw size={14} />
              </IconButton>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Set one capability in a choices map, removing it on `null`; an empty map is no map. */
export function withModelChoice(
  choices: ModelChoices | undefined,
  capability: Capability,
  modelId: string | null,
): ModelChoices | undefined {
  const next: ModelChoices = { ...choices };
  delete next[capability];
  if (modelId !== null) next[capability] = modelId;
  return Object.keys(next).length > 0 ? next : undefined;
}
