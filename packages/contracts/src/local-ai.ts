import { z } from "zod";
import { comfyUiWeightsComponentId, type ComfyUiEngineState } from "./comfyui.js";
import type { ProviderId } from "./provider.js";
import type { SetupComponent, SetupComponentState } from "./setup.js";
import type { FitVerdict } from "./settings.js";

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

/**
 * The local services that host models (SPEC-033 R-68). Three, with independent lifecycles,
 * overlapping capabilities, and one of them — Voxa — hosting two providers.
 *
 * Not the same list as the local providers, and deliberately so: an engine is not a provider and
 * a provider is not an engine (R-72). Voxa hosts Kokoro and whisper.cpp; ComfyUI hosts every
 * recipe. The authoring harness is not here at all — it governs agent execution, and R-5 puts it
 * on exactly one surface.
 */
export const EngineIdSchema = z.enum(["comfyui", "ollama", "voxa"]);
export type EngineId = z.infer<typeof EngineIdSchema>;

export const ENGINE_LABEL: Record<EngineId, string> = {
  comfyui: "ComfyUI",
  ollama: "Ollama",
  voxa: "Voxa",
};

/**
 * Which providers each engine hosts (SPEC-034 R-7). The join that lets one rail row carry several
 * named groups, and the reason the two lists above are not the same list.
 *
 * Voxa is the case the requirement exists for: one process, one executable, one port, hosting
 * Kokoro and whisper.cpp. Naming it a provider would put a word in the rail that no manifest row,
 * ledger entry or finding uses; naming its two providers separately would state its executable,
 * port and restart twice. The rail takes the engine and the groups take the providers.
 */
export const ENGINE_PROVIDERS: Record<EngineId, readonly ProviderId[]> = {
  comfyui: ["comfyui"],
  ollama: ["ollama"],
  voxa: ["kokoro", "whispercpp"],
};

/** The engine that hosts a provider, where one does. Cloud providers have none. */
export function engineOfProvider(provider: ProviderId): EngineId | undefined {
  return (Object.keys(ENGINE_PROVIDERS) as EngineId[]).find((engine) =>
    ENGINE_PROVIDERS[engine].includes(provider),
  );
}

/**
 * The closed set of headline states R-26's table produces. Nothing else may reach a row.
 *
 * `served-elsewhere` left in SPEC-034 R-10. Locality is the engine's fact, and the engine states
 * it in exactly two places — `elsewhere` in the Providers rail, the address in its pane. Carried
 * on the row as well it was the same fact a third time, once per model the engine serves.
 */
export type LocalModelRowState =
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
  /**
   * Absent where nothing has measured this machine yet, and absent for a model served by a
   * remote engine, which has no verdict to carry (R-15). Neither absence refuses the model:
   * R-28 offers an unmeasured one rather than withholding it.
   */
  fit: FitVerdict | undefined,
  activation: ActivationState,
): LocalModelRowState {
  if (fit === "insufficient" || fit === "unsupported") return "unsupported";
  // `runs-well`, `runs-slowly` and `unknown` all behave the same here: a machine that has not
  // been measured is offered rather than withheld (R-28), and the header says it was not.
  if (activation === "ready") return "installed";
  if (activation === "not-installed") return "available";
  return activation;
}

/** What a row prints for each state. Labels and states only — no adjectives, no reassurance. */
export const ROW_STATE_LABEL: Record<LocalModelRowState, string> = {
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
    case "paused":
      return "downloading";
    case "installing":
      return "installing";
    case "blocked":
    case "failed":
      return "needs-attention";
  }
}

/**
 * Worst first. A model's own files can be in several components at once, so its activation is
 * the least settled of them — and anything in flight beats anything absent, because what is
 * moving is what the reader wants to know about.
 */
const ACTIVATION_ORDER: readonly ActivationState[] = [
  "needs-attention",
  "downloading",
  "installing",
  "starting",
  "not-installed",
  "ready",
];

function worst(states: readonly ActivationState[]): ActivationState | undefined {
  return ACTIVATION_ORDER.find((candidate) => states.includes(candidate));
}

export interface ActivationInputs {
  /** Every setup component, as published. `provides` is what links one to a manifest model. */
  components: readonly SetupComponent[];
  /** The resolved ComfyUI engine's state, where one has been asked. */
  comfyUiEngineState?: ComfyUiEngineState;
}

/**
 * What the engine adds to a model it hosts — and it only ever *degrades* one.
 *
 * A `ready` engine adds nothing, because the model's own files already answered. An `absent` one
 * adds nothing either: the model is still installed, and *installed but unable to run* is
 * eligibility's sentence (R-31), not a claim that the weights are missing. What is left is the
 * two states that are genuinely about this model right now — the engine coming up, and the
 * engine in trouble.
 *
 * The `comfyui-runtime` setup component is deliberately not consulted. It is `optional`, so it
 * sits at `available` forever on a machine whose owner runs their own ComfyUI — and folding that
 * into the model's activation printed `available` beside weights that were downloaded, installed
 * and dispatching.
 */
function engineActivation(state: ComfyUiEngineState | undefined): ActivationState | undefined {
  if (state === "starting") return "starting";
  if (state === "unreachable" || state === "incompatible" || state === "failed") return "needs-attention";
  return undefined;
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
 * **A model's own absence is final.** An engine that is starting does not make an uninstalled
 * model *starting* — nothing is coming for it — so the engine's state is consulted only once the
 * model's own files are here.
 *
 * A model nothing provides is `not-installed`. Arke cannot fetch it and cannot see it, and the
 * honest reading of that is absence rather than a claim either way; the detail names the engine
 * so the reader knows where it would come from.
 */
export function activationFor(provider: ProviderId, modelId: string, inputs: ActivationInputs): ActivationState {
  const own: ActivationState[] = [];
  if (provider === "comfyui") {
    const weights = inputs.components.find((c) => c.id === comfyUiWeightsComponentId(modelId));
    if (weights) own.push(activationOfComponent(weights.state));
  } else {
    for (const component of inputs.components) {
      if (component.provides?.includes(modelId) === true) own.push(activationOfComponent(component.state));
    }
  }
  const mine = worst(own) ?? "not-installed";
  if (mine === "not-installed") return mine;
  if (provider !== "comfyui") return mine;
  const engine = engineActivation(inputs.comfyUiEngineState);
  return engine === undefined ? mine : (worst([mine, engine]) ?? mine);
}
