import { modelEligible, modelForCapability, PROVIDERS, type ClientState, type ModelChoices } from "@arke-studio/contracts";
import { eligibilityInputs } from "./dispatch-bar.js";
import { Select } from "./ui.js";

/** Setup and Pages share the production's image choice; only lettering models are offered. */
export function ComicModelChoice({ state, choices, disabled, onChange }: {
  state: ClientState | null; choices: ModelChoices | undefined; disabled: boolean; onChange: (model: string | null) => void;
}) {
  const manifest = state?.app.manifest;
  const defaultModel = manifest ? modelForCapability(manifest, state?.app.routing.defaults, "image") : undefined;
  const eligibility = eligibilityInputs(state);
  const offered = (manifest?.models ?? []).filter(model => model.capability === "image" && model.upscale === undefined && model.limits.lettering === true && modelEligible(model, eligibility));
  const own = choices?.image;
  const held = manifest?.models.find(model => model.id === own);
  const usableDefault = defaultModel != null && offered.some(model => model.id === defaultModel.id);
  return <Select label="Picture model" value={own ?? ""} disabled={disabled} onChange={event => onChange(event.target.value || null)}>
    <option value="" disabled={!usableDefault}>{usableDefault ? `${defaultModel!.displayName} (default)` : "Choose a model that letters"}</option>
    {own !== undefined && !offered.some(model => model.id === own) && <option value={own} disabled>{held?.displayName ?? own} · unavailable</option>}
    {offered.map(model => <option key={model.id} value={model.id}>{PROVIDERS[model.provider].displayName} · {model.displayName}</option>)}
  </Select>;
}
