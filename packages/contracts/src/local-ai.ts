import { z } from "zod";
import { comfyUiWeightsComponentId } from "./comfyui.js";
import type { ProviderId } from "./provider.js";
import type { SetupComponent, SetupComponentState } from "./setup.js";
import type { FitVerdict, Locality } from "./settings.js";

/**
 * What Local AI shows on a model row (SPEC-033 §1.6). Three axes meet here and none of them is
 * computed here: **locality** and **fit** come from the gate, **activation** from the setup
 * ledger, and **eligibility** stays SPEC-028 R-35's. This file is the projection and nothing
 * else — the moment it starts deriving one of those, two screens can disagree about one model.
 */

/**
 * SPEC-028 R-6's vocabulary, less `unsupported` and `unknown` (SPEC-033 R-25).
 *
 * Those two are facts about a machine rather than about a transfer, and leaving them here made
 * the row state undefined for a model downloading onto hardware that will not run it — a
 * sentence the closed list cannot form, and a state a person reaches in one press. They moved
 * to fit, where they are answered once. The other six keep their spellings exactly.
 */
export const ActivationStateSchema = z.enum([
  "not-installed",
  "downloading",
  "installing",
  "starting",
  "ready",
  "needs-attention",
]);
export type ActivationState = z.infer<typeof ActivationStateSchema>;

/** The closed set of headline states R-26's table produces. Nothing else may reach a row. */
export type LocalModelRowState =
  | "served-elsewhere"
  | "unsupported"
  | "installed"
  | "available"
  | "downloading"
  | "installing"
  | "starting"
  | "needs-attention";

/**
 * R-26's table, total over fit × activation. A combination it does not name is a defect in one
 * of the two vocabularies, not a case for an implementer to decide — so this is a projection
 * with no default arm that guesses.
 *
 * `insufficient` and `unsupported` share the word **Unsupported** and keep separate reasons: the
 * reader scanning a list needs few buckets, and the reader who has stopped on a row needs the
 * distinction (D12). R-27 is what carries it, on the row itself.
 */
export function localModelRowState(
  locality: Locality,
  /** Absent exactly when the model is served elsewhere — a remote model has no verdict (R-15). */
  fit: FitVerdict | undefined,
  activation: ActivationState,
): LocalModelRowState {
  if (locality === "remote") return "served-elsewhere";
  if (fit === "insufficient" || fit === "unsupported") return "unsupported";
  // `runs-well`, `runs-slowly` and `unknown` all behave the same here: a machine that has not
  // been measured is offered rather than withheld (R-28), and the header says it was not.
  if (activation === "ready") return "installed";
  if (activation === "not-installed") return "available";
  return activation;
}

/** What a row prints for each state. Labels and states only — no adjectives, no reassurance. */
export const ROW_STATE_LABEL: Record<LocalModelRowState, string> = {
  "served-elsewhere": "served elsewhere",
  unsupported: "unsupported",
  installed: "installed",
  available: "available",
  downloading: "downloading",
  installing: "installing",
  starting: "starting",
  "needs-attention": "needs attention",
};

/** The fit verdict as a row prints it: measured words, never adjectives (R-87). */
export const FIT_LABEL: Record<FitVerdict, string> = {
  "runs-well": "runs well",
  "runs-slowly": "runs slowly",
  insufficient: "not enough here",
  unsupported: "unsupported",
  unknown: "not measured",
};

/**
 * A setup component's state in the activation vocabulary.
 *
 * `queued` is a transfer somebody committed to that has not reached the front of the line, so it
 * reads as `downloading` rather than as absence — a row saying *available* under a press that
 * already happened is the one reading a person would call a bug.
 *
 * `skipped` is `not-installed` and deliberately not `needs-attention`: being turned down is a
 * decision, and the other is a condition (R-32's argument, applied to a transfer).
 */
export function activationOfComponent(state: SetupComponentState): ActivationState {
  switch (state) {
    case "present":
    case "ready":
      return "ready";
    case "available":
    case "skipped":
      return "not-installed";
    case "queued":
    case "downloading":
      return "downloading";
    case "installing":
      return "installing";
    case "blocked":
    case "failed":
      return "needs-attention";
  }
}

/**
 * Worst first. A model needs everything in its chain, so the chain's activation is the least
 * settled link — and anything in flight beats anything absent, because what is moving is what
 * the reader wants to know about.
 */
const ACTIVATION_ORDER: readonly ActivationState[] = [
  "needs-attention",
  "downloading",
  "installing",
  "starting",
  "not-installed",
  "ready",
];

function worst(states: readonly ActivationState[]): ActivationState {
  for (const candidate of ACTIVATION_ORDER) if (states.includes(candidate)) return candidate;
  return "ready";
}

/** The engine that hosts a ComfyUI recipe, as a setup component. */
export const COMFYUI_RUNTIME_COMPONENT = "comfyui-runtime";

export interface ActivationInputs {
  /** Every setup component, as published. `provides` is what links one to a manifest model. */
  components: readonly SetupComponent[];
  /** The resolved ComfyUI engine's state, where one has been asked. */
  comfyUiEngineState?: "absent" | "starting" | "ready" | "unreachable" | "incompatible" | "failed";
}

/**
 * Where a model is in getting here (R-25).
 *
 * The link from a model to the things that must be on disk for it is **declared**, never
 * inferred from an identifier's shape (R-39). Two declarations, and only two: a setup component
 * names the manifest models it provides, and a ComfyUI recipe's weights component is derived
 * from the recipe catalogue exactly as it already was — a second declaration of those weights is
 * the bug, not the fix.
 *
 * A model nothing provides is `not-installed`. Arke cannot fetch it and cannot see it, and the
 * honest reading of that is absence rather than a claim either way; the detail names the engine
 * so the reader knows where it would come from.
 */
export function activationFor(provider: ProviderId, modelId: string, inputs: ActivationInputs): ActivationState {
  const byId = new Map(inputs.components.map((c) => [c.id, c]));
  const parts: ActivationState[] = [];

  if (provider === "comfyui") {
    // The engine speaks for itself where it has answered — a starting engine is a starting
    // model, and one that failed is a model needing attention, whatever is on disk.
    const engine = inputs.comfyUiEngineState;
    if (engine === "starting") parts.push("starting");
    else if (engine === "unreachable" || engine === "incompatible" || engine === "failed") {
      parts.push("needs-attention");
    }
    const runtime = byId.get(COMFYUI_RUNTIME_COMPONENT);
    if (runtime) parts.push(activationOfComponent(runtime.state));
    const weights = byId.get(comfyUiWeightsComponentId(modelId));
    if (weights) parts.push(activationOfComponent(weights.state));
    return parts.length === 0 ? "not-installed" : worst(parts);
  }

  for (const component of inputs.components) {
    if (component.provides?.includes(modelId) === true) parts.push(activationOfComponent(component.state));
  }
  return parts.length === 0 ? "not-installed" : worst(parts);
}
