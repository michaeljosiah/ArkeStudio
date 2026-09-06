import type { Capability } from "./provider.js";
import type { ManifestModel, ModelManifest } from "./manifest.js";
import { PROVIDERS, deriveCapabilityAvailability, type ProviderId, type ProviderStatus } from "./provider.js";
import type { RecipeReadiness } from "./comfyui.js";
import type {
  FitVerdict,
  LocalRuntimeModel,
  LocalRuntimeStatus,
  Locality,
  RuntimeProbes,
} from "./settings.js";

/**
 * Gate the manifest's local models against measured machine figures (SPEC-033 §1.5).
 * Pure: probing is the platform's business (@arke-studio/providers); the judgement is shared.
 * A failed probe means unknown, never unavailable (SPEC-008 D12).
 *
 * The gate answers exactly one question — *can this machine run it* — and stopped answering the
 * other two it used to blur into the same three words. Whether a model can dispatch right now is
 * SPEC-028 R-35's, and whether it has arrived is the setup ledger's.
 */

/**
 * The margin over a declared floor that separates *runs well* from *runs slowly*: **25 percent**,
 * for VRAM and for system memory (SPEC-033 R-20).
 *
 * Meeting a floor by two hundred megabytes and meeting it by six gigabytes are the same boolean
 * and very different experiences — the weights are the floor, and activations, the KV cache and
 * the compositor's own framebuffer live above it, so a machine at the floor spills into system
 * memory and slows by an order of magnitude. The number is arguable, which is exactly why it is
 * a contract constant: two conforming builds must not disagree about the same machine (R-24).
 */
export const LOCAL_FIT_HEADROOM_RATIO = 0.25;

/**
 * Gigabytes to one decimal, dropping a bare `.0`. The old spelling rounded to whole gigabytes,
 * which printed a machine holding 12.1 GB against a 12 GB floor as `12 GB` — the one figure that
 * makes `runs-slowly` legible, rendered as though the floor were met exactly.
 *
 * Exported so that every surface stating a machine figure states it the same way. Three
 * roundings of one number on one screen is how a rail saying `6 GB VRAM` ends up beside a row
 * saying `needs 6.2 GB`.
 */
export function formatGb(mb: number): string {
  const rounded = Math.round((mb / 1024) * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} GB`;
}

/**
 * A floor and what the machine answered for it, in figures that differ.
 *
 * One decimal shrinks the window where two different numbers print the same string; it does not
 * close it. Kokoro's floor is 4000 MB, so a laptop reporting 3993 refused with
 * `Needs 3.9 GB memory · this machine has 3.9 GB` — a refusal whose two figures agree, which is
 * the one thing R-19's *both figures* rule exists to prevent. Where the gigabyte spellings
 * collide, both drop to megabytes, where they cannot.
 */
function figures(need: number, have: number): { need: string; have: string } {
  const asGb = { need: formatGb(need), have: formatGb(have) };
  if (asGb.need !== asGb.have) return asGb;
  return { need: `${need} MB`, have: `${have} MB` };
}

/** The one cloud alternative worth naming, when the same capability has a cloud model. */
function cloudAlternative(manifest: ModelManifest, model: ManifestModel): string | undefined {
  const cloud = manifest.models.find((m) => m.capability === model.capability && !PROVIDERS[m.provider].local);
  if (!cloud) return undefined;
  return `Cloud ${model.capability} still works via ${PROVIDERS[cloud.provider].displayName}.`;
}

/** The platform names a person recognises. An unlisted one prints as the host spells it. */
const PLATFORM_LABEL: Record<string, string> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
};

function platformLabel(value: string): string {
  return PLATFORM_LABEL[value] ?? value;
}

/** Accelerators as a row names them, rather than as a driver does. */
const ACCELERATOR_LABEL: Record<string, string> = {
  cuda: "CUDA",
  rocm: "ROCm",
  metal: "Metal",
  directml: "DirectML",
};

function acceleratorLabel(value: string): string {
  return ACCELERATOR_LABEL[value] ?? value;
}

/** A list a sentence can hold: `CUDA`, `CUDA or ROCm`, `CUDA, ROCm or Metal`. */
function orList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

/** Where a model's work would run. Absent means this machine, which is every provider's default. */
export type EngineLocalities = Partial<Record<ProviderId, Locality>>;

/** One measured floor and what the machine answered for it. */
interface Floor {
  need: number;
  have: number | null;
  what: string;
  /** The authored runs-well boundary, where one is declared; the generic margin otherwise. */
  well?: number;
}

export interface FitResult {
  fit: FitVerdict;
  /** Both figures, always — the verdict is the label and these are what make it checkable. */
  reason?: string;
}

/**
 * The fit verdict for one model on one machine (R-16..R-22). Exported because #569's install
 * closure and #566's rows both want it for a single model without re-gating the manifest.
 */
export function fitFor(model: ManifestModel, probes: RuntimeProbes): FitResult {
  const req = model.requires ?? {};
  /** What was asked for and not answered — a declared requirement counts as much as a floor. */
  const unmeasured: string[] = [];

  // 1 · The declared refusals first. `unsupported` is the stronger statement — no machine of
  //     this kind will work — and stating a VRAM shortfall over it would offer a remedy that
  //     cannot help. R-22 keeps an unmeasured probe from producing either of them: `null` is
  //     *nobody answered*, and only a measured empty list refuses.
  const platform = probes.platform ?? null;
  if (req.platform !== undefined) {
    if (platform === null) unmeasured.push("the platform");
    else if (!req.platform.includes(platform)) {
      return {
        fit: "unsupported",
        reason: `Runs on ${orList(req.platform.map(platformLabel))} · this machine is ${platformLabel(platform)}`,
      };
    }
  }
  const accelerators = probes.accelerators ?? null;
  if (req.accelerator !== undefined) {
    if (accelerators === null) unmeasured.push("the accelerator");
    else if (!req.accelerator.some((name) => accelerators.includes(name))) {
      const has = accelerators.length === 0 ? "none" : orList(accelerators.map(acceleratorLabel));
      return {
        fit: "unsupported",
        reason: `Needs ${orList(req.accelerator.map(acceleratorLabel))} · this machine reports ${has}`,
      };
    }
  }

  // 2 · The measured floors. Free disk is deliberately not among them (R-17).
  const floors: Floor[] = [];
  if (req.vramMb !== undefined) {
    // The card the floor is about: with an accelerator declared and per-adapter figures
    // measured, the biggest card of a REQUIRED family answers. The machine-wide maximum can
    // belong to a vendor the row cannot use — a 24 GB Radeon beside an 8 GB GeForce passed a
    // 10 GB CUDA floor on the Radeon's figure and offered a 42 GB download the GeForce
    // could not run.
    const byFamily = probes.vramMbByAccelerator ?? null;
    const familyFigures =
      req.accelerator !== undefined && byFamily !== null
        ? req.accelerator.filter((name) => byFamily[name] !== undefined).map((name) => byFamily[name]!)
        : [];
    floors.push({
      need: req.vramMb,
      have: familyFigures.length > 0 ? Math.max(...familyFigures) : probes.vramMb,
      what: "VRAM",
      ...(req.recommendedVramMb !== undefined ? { well: req.recommendedVramMb } : {}),
    });
  }
  if (req.memMb !== undefined) floors.push({ need: req.memMb, have: probes.memMb, what: "memory" });
  for (const floor of floors) if (floor.have === null) unmeasured.push(floor.what);

  const short = floors.find((f) => f.have !== null && f.have < f.need);

  // 3 · A measured refusal beats an unmeasured probe (R-21, D9). Without the precedence, a
  //     machine whose VRAM probe failed and whose memory is plainly short reads `unknown`, and
  //     R-28 then offers an install that is known to fail. The failed probe is noted rather
  //     than allowed to soften the refusal.
  if (short !== undefined) {
    const both = figures(short.need, short.have!);
    const note = unmeasured.length === 0 ? "" : ` · ${unmeasured[0]} could not be measured`;
    return {
      fit: "insufficient",
      reason: `Needs ${both.need} ${short.what} · this machine has ${both.have}${note}`,
    };
  }

  // 4 · Nothing refuses, and something was not measured. That is `unknown` whichever probe
  //     failed: a declared requirement nobody could check is exactly as unanswered as a floor
  //     nobody could measure, and calling it `runs-well` would let R-35 recommend a model on a
  //     claim about a machine no one made (R-36).
  if (unmeasured.length > 0) {
    return { fit: "unknown", reason: `${unmeasured[0]} could not be measured on this machine` };
  }

  // 5 · Every floor is met. The binding one — the one closest to its floor — is what decides
  //     between the two passing verdicts, and it is the figure worth stating either way.
  if (floors.length === 0) return { fit: "runs-well" };
  // An authored boundary beats the generic margin: the author measured where comfortable begins,
  // and 25% over a floor built for offloading is not it. Comfort is judged per floor and ALL
  // floors must clear their own boundary — selecting one floor by nearness to its minimum let a
  // 20 GB card ride memory's comfortable margin straight past the authored 24 GB VRAM boundary.
  // The stated floor is the least comfortable one, because that is the one deciding the verdict.
  const wellAt = (f: Floor): number => f.well ?? f.need * (1 + LOCAL_FIT_HEADROOM_RATIO);
  const binding = floors.reduce((tightest, f) => (f.have! / wellAt(f) < tightest.have! / wellAt(tightest) ? f : tightest));
  const comfortable = floors.every((f) => f.have! >= wellAt(f));
  const both = figures(binding.need, binding.have!);
  return {
    fit: comfortable ? "runs-well" : "runs-slowly",
    reason: `Needs ${both.need} ${binding.what} · this machine has ${both.have}`,
  };
}

/**
 * The recommendation for each capability (R-33..R-38): authored order in, measured filter over
 * it, first `runs-well` entry out. Nothing whose fit is `unknown` is ever recommended — a
 * recommendation is a claim about the machine, and no claim can rest on an unmeasured one.
 */
export function recommendLocalModels(
  manifest: ModelManifest,
  models: readonly LocalRuntimeModel[],
): Partial<Record<Capability, string>> {
  const byId = new Map(models.map((m) => [m.modelId, m]));
  const recommended: Partial<Record<Capability, string>> = {};
  for (const [capability, order] of Object.entries(manifest.localPreference ?? {}) as Array<
    [Capability, readonly string[] | undefined]
  >) {
    if (order === undefined) continue;
    for (const modelId of order) {
      const gated = byId.get(modelId);
      // Locality is filtered before the verdict (R-34): a model served by a remote engine is
      // not a recommendation about this machine, and it carries no verdict to select on anyway.
      if (!gated || gated.locality !== "local" || gated.fit !== "runs-well") continue;
      // The order is keyed by capability, so an entry naming a model of another one is a
      // manifest fault. Skipped here rather than trusted, because the alternative is a voice
      // model recommended as the writing model — and the check belongs beside the data rather
      // than in the test that noticed it.
      if (gated.capability !== capability) continue;
      recommended[capability] = modelId;
      break;
    }
  }
  return recommended;
}

export function gateLocalRuntimes(
  manifest: ModelManifest,
  probes: RuntimeProbes,
  detectedAt: string,
  /**
   * Where each local provider's engine actually resolved to. Absent means this machine, which
   * is every provider's answer but ComfyUI's — and ComfyUI's only when the user pointed it at a
   * non-loopback URL. Reading `PROVIDERS[x].local` instead would judge another computer's work
   * against this machine's VRAM (R-9, SPEC-028 R-37).
   */
  engineLocality: EngineLocalities = {},
): LocalRuntimeStatus {
  const models: LocalRuntimeModel[] = [];
  for (const model of manifest.models) {
    if (!PROVIDERS[model.provider].local) continue;
    const locality = engineLocality[model.provider] ?? "local";
    if (locality === "remote") {
      // No verdict at all, and the absence is stated as *served elsewhere* rather than as
      // `unknown` (R-15). It keeps dispatching; this only governs what Settings claims (R-12).
      models.push({
        modelId: model.id,
        provider: model.provider,
        displayName: model.displayName,
        capability: model.capability,
        locality,
      });
      continue;
    }
    const { fit, reason } = fitFor(model, probes);
    const alt = fit === "insufficient" || fit === "unsupported" ? cloudAlternative(manifest, model) : undefined;
    models.push({
      modelId: model.id,
      provider: model.provider,
      displayName: model.displayName,
      capability: model.capability,
      locality,
      fit,
      ...(reason !== undefined ? { reason } : {}),
      ...(alt !== undefined ? { cloudAlternative: alt } : {}),
    });
  }
  return { probes, detectedAt, models, recommended: recommendLocalModels(manifest, models) };
}

/**
 * Whether a model can be dispatched right now (SPEC-028 R-35), as one function.
 *
 * It lived in the dispatch bar, which was fine while the only caller was a picker. SPEC-034 R-15a
 * gives it a second: General may name a local default, and the routing write has to refuse an
 * ineligible one — a picker that merely disables the option is a courtesy, not a guarantee, and
 * an id arriving over the wire would otherwise store a default nothing can honour. Two callers
 * deriving this separately is how a screen and a write come to disagree about one model, so
 * neither derives it.
 *
 * Fit is an input, not a rival: a refusing verdict is the gate's, and this reads it rather than
 * recomputing one. A model can fail this while fitting the machine perfectly — an engine that
 * never started is not a fit question — and can fit nothing while being perfectly installed.
 */
export interface EligibilityInputs {
  /** Provider connection state, for the capabilities a credential actually unlocks. */
  readonly providers: readonly ProviderStatus[];
  /** Model ids somebody switched off in AI models. */
  readonly disabled: readonly string[];
  /** ComfyUI's own recipe answers, keyed by recipe id — which is the model id. */
  readonly recipes: readonly RecipeReadiness[];
  /** Where the resolved ComfyUI engine runs, which changes what an unknown recipe means. */
  readonly comfyUiLocality: "local" | "remote" | undefined;
  /**
   * The gate's rows, for the fit verdict. Absent where nothing has probed, which R-28 offers
   * rather than withholds — an unmeasured machine is not a refusing one.
   */
  readonly gated?: readonly { readonly modelId: string; readonly fit?: FitVerdict }[];
}

export function modelEligible(model: ManifestModel, inputs: EligibilityInputs): boolean {
  if (inputs.disabled.includes(model.id)) return false;
  const unlocked = new Set(
    deriveCapabilityAvailability([...inputs.providers]).find((a) => a.capability === model.capability)?.via ?? [],
  );
  const local = PROVIDERS[model.provider].local === true;
  if (!unlocked.has(model.provider) && !local) return false;
  // A machine that cannot run it cannot be told to. Only a *measured* refusal counts: `unknown`
  // is offered rather than withheld (SPEC-033 R-28), and `runs-slowly` is a warning, not a bar.
  const fit = inputs.gated?.find((row) => row.modelId === model.id)?.fit;
  if (fit === "insufficient" || fit === "unsupported") return false;
  // A local engine that answered and failed refuses everything it hosts. This is the case
  // SPEC-034 R-15a names — a Kokoro runtime that never started must not become a default — and
  // it is invisible to the credential check above, because a local provider takes no credential.
  // `untested` is not a refusal: nothing has asked yet, and R-28's instinct applies to engines
  // as much as to hardware.
  if (local) {
    const status = inputs.providers.find((p) => p.id === model.provider);
    if (status?.validation === "invalid" || (status?.fault ?? null) !== null) return false;
  }
  // A local recipe below readiness is not usable — it stays visible in the picker as a disabled
  // row with its measured reason, and coordinator admission refuses it regardless (SPEC-021
  // R-16). Unknown image/video hardware still runs (D15); cloned voice stays off until this
  // build has proven the full use can complete.
  if (model.provider === "comfyui") {
    const readiness = inputs.recipes.find((recipe) => recipe.recipeId === model.id) ?? null;
    if (
      readiness === null ||
      readiness.state === "disabled" ||
      (model.capability === "voice-tts" && readiness.state === "unknown" && inputs.comfyUiLocality === "local")
    ) {
      return false;
    }
  }
  return true;
}
