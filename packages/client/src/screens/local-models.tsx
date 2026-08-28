import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  ENGINE_PROVIDERS,
  FIT_LABEL,
  ROW_STATE_LABEL,
  activationFor,
  comfyUiWeightsComponentId,
  formatGb,
  localModelRowState,
  setupClosure,
  transferProgress,
  PROVIDERS as PROVIDER_TABLE,
  type EngineId,
  type Locality,
  type LocalModelRowState,
  type ManifestModel,
  type ProviderId,
  type SetupClosure,
  type SetupComponent,
} from "@arke-studio/contracts";
import { Button, cx } from "../components/ui.js";
import { ChevronDown, ChevronRight } from "../components/icons.js";
import { detectRuntimes, setupInstall, setupRemove, setupRepair, useSetup, useStore } from "../lib/store.js";
import { strandReason, usableModels } from "../components/dispatch-bar.js";
import {
  CAPABILITY_LABEL,
  RuntimeSection,
  RuntimeStatus,
  sizeMb,
  type RuntimeTone,
} from "./settings-parts.js";

/**
 * The local half of Settings · Providers (SPEC-034 R-7). One engine's models, and the machine
 * they run on.
 *
 * This was the Local AI screen — a capability rail, and one capability's models under it. That
 * rail answered *what can I make here*, and Providers' own rail answers it now, with the engines
 * beside the services they are an alternative to. What is left is the narrower question a reader
 * has already asked by opening a pane: what does this engine host, and what of it is here.
 *
 * No cloud provider reaches these rows, and that is by construction rather than by a filter
 * applied late: the models come from `ENGINE_PROVIDERS`, which claims only local providers and is
 * tested doing so.
 */

/**
 * Which headline states draw a dot at all (SPEC-034 R-22) — the two that warn, and nothing else.
 *
 * The table used to be total over the states, with `ok` for installed and `idle` for the other
 * six. Green said what the word beside it had already said, and grey stood for five states while
 * separating none of them; drawn on every row, the one that meant something was competing with
 * seven that did not.
 *
 * `needs-attention` keeps its dot beside `unsupported` although it is not a refusal: it is a
 * transfer somebody can retry and never does, which is the one thing on this list worth finding
 * by scanning for colour. R-23 separates the two for dimming and this joins them for the dot,
 * deliberately — what warns and what recedes are different questions.
 */
const STATE_TONE: Partial<Record<LocalModelRowState, RuntimeTone>> = {
  unsupported: "warn",
  "needs-attention": "warn",
};

interface Entry {
  model: ManifestModel;
  state: LocalModelRowState;
  /**
   * Which machine actually runs it (R-9). No longer folded into the row state, and this screen
   * has no engine pane to state it in yet, so the row states it here until issue 623 lands one.
   */
  locality: Locality;
  /** The verdict's own figures — the refusal, or the floor a passing verdict cleared. */
  reason: string | undefined;
  fitLabel: string | undefined;
  sizeMbytes: number | undefined;
  recommended: boolean;
  /** SPEC-028 R-35's answer, where it refuses a model that is otherwise installed (R-31). */
  ineligible: string | undefined;
  /** A *declared* refusal, which recedes — never a measured one, which does not (R-23). */
  declined: boolean;
  /** The component that provides this model, where one does. Absent means nothing can fetch it. */
  component: SetupComponent | undefined;
  /** What one press actually costs — the whole chain, never this model's own weights (R-40). */
  closure: SetupClosure | undefined;
  /** The rest of the chain, by display name, for the detail. Empty where there is no rest. */
  supporting: string[];
}


/**
 * One engine's models, grouped by the provider that owns them (SPEC-034 R-7).
 *
 * Replaces the Local AI screen's capability rail. The question that rail answered — *what can I
 * make here* — is now answered by Providers' own rail, where the engines sit beside the services;
 * this answers the narrower one a reader has already asked by opening a pane.
 *
 * Nothing here derives a fact another surface owns. Locality and fit come from the gate,
 * activation from the setup ledger, and whether a model can dispatch *now* is SPEC-028 R-35's
 * answer consumed through `usableModels` — the same function the dispatch bar reads, so the two
 * cannot disagree about one model.
 */
export function EngineModelGroups({ engine }: { engine: EngineId }) {
  const { state } = useStore();
  const setup = useSetup();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const runtime = state?.app.runtime ?? null;
  const comfyui = state?.app.comfyui ?? null;

  const manifest = state?.app.manifest ?? null;
  const components = setup?.components ?? [];
  const disabled = new Set(state?.app.models.disabled ?? []);
  const gatedById = new Map((runtime?.models ?? []).map((m) => [m.modelId, m]));
  const providers = ENGINE_PROVIDERS[engine];
  /**
   * A ComfyUI recipe is a ComfyUI model, and its own pane lists the ones the engine has
   * answered for — with the controls a recipe needs, which a model row has no place for:
   * the pinned version, Re-verify, the node-class refusal. Drawing those again here would
   * state one thing twice, which is the duplication SPEC-033 R-6 deletes rather than tidies.
   *
   * The ones it has *not* answered for still belong here. With no engine resolved the recipe
   * list is empty, and dropping the manifest rows with it would withhold every model this
   * machine could install — the opposite of R-28, and a fact Local AI used to state.
   */
  const answered = new Set((comfyui?.recipes ?? []).map((r) => r.recipeId));
  // R-7's heading rule. Where an engine hosts one provider the rail item has already named it,
  // and repeating it one line below is the redundancy R-19 removes from rows and headings alike.
  const several = providers.length > 1;

  /**
   * Every model this engine hosts, whether or not the machine has been measured yet.
   *
   * Drawn from the manifest rather than from the gate's output, because the gate has nothing to
   * say until a probe returns and R-28 offers an unmeasured model rather than withholding it.
   * The gate's row is joined on where it exists; locality falls back to the engine's own answer,
   * which is where locality lives either way (R-9).
   */
  const entriesFor = (provider: ProviderId): Entry[] => {
    const models = (manifest?.models ?? []).filter((m) => m.provider === provider && !answered.has(m.id));
    // Asked of each model's own capability, never the group's: a recipe drawn under one heading
    // may dispatch as another, and asking the wrong one would strand a model that runs perfectly.
    const usableIds = new Set(
      [...new Set(models.map((m) => m.capability))].flatMap((c) => usableModels(state, c).map((m) => m.id)),
    );
    return models.map((model) => {
      const gated = gatedById.get(model.id);
      const locality =
        gated?.locality ?? (model.provider === "comfyui" ? (comfyui?.engine.locality ?? "local") : "local");
      const activation = activationFor(model.provider, model.id, {
        components,
        ...(comfyui?.engine.state !== undefined ? { comfyUiEngineState: comfyui.engine.state } : {}),
      });
      const rowState = localModelRowState(gated?.fit, activation);
      // A declared `unsupported` is a fact about this machine nobody can act on, so it recedes;
      // a measured `insufficient` names a shortfall a smaller model or a bigger card answers,
      // and receding hides something actionable (SPEC-033 D8, SPEC-034 R-23). The row state
      // folds the two, so the verdict has to travel beside it.
      const declined = gated?.fit === "unsupported";
      const component = components.find(
        (c) => c.provides?.includes(model.id) === true || c.id === comfyUiWeightsComponentId(model.id),
      );
      return {
        model,
        state: rowState,
        locality,
        declined,
        reason: gated?.reason,
        // One of the five outcomes prints (SPEC-034 R-20, R-21). `runs well` changes no
        // decision; `unknown` is the machine row said once per model instead of once; and a
        // refusal is already the row's headline, with its figures on the line beneath — the
        // label between them says the same thing a third time and vaguer.
        fitLabel: gated?.fit === "runs-slowly" ? FIT_LABEL["runs-slowly"] : undefined,
        sizeMbytes: component?.sizeMb ?? model.requires?.diskMb,
        component,
        closure: component === undefined ? undefined : setupClosure(components, component.id),
        supporting:
          component === undefined
            ? []
            : setupClosure(components, component.id)
                .componentIds.filter((id) => id !== component.id)
                .map((id) => components.find((c) => c.id === id)?.displayName ?? id),
        recommended: runtime?.recommended[model.capability] === model.id,
        // Installed and still unable to run is a different sentence from unsupported, and it is
        // not this surface's to compose: R-30 forbids a second eligibility answer, so the row
        // states the one the dispatch bar and enqueue admission already read.
        //
        // Never for a model served elsewhere. `strandReason` answers about *this* machine's
        // engine, and a row another machine serves must not carry it (SPEC-034 R-10).
        //
        // Switched off is stated at any row state, not only when installed: being turned down is
        // a decision and the other three are conditions, and R-32 forbids letting a decision
        // read as an absence.
        ineligible: disabled.has(model.id)
          ? "turned off in Providers"
          : locality === "local" && rowState === "installed" && !usableIds.has(model.id)
            ? strandReason(state, model)
            : undefined,
      };
    });
  };

  const groups = providers
    .map((provider) => ({ provider, entries: entriesFor(provider) }))
    .filter((g) => g.entries.length > 0);

  return (
    <>
      {/* Three readable lines, once (SPEC-033 R-48). The capability rail put each half on a
          different screen and had to draw `Conversational voice` under both; one pane draws the
          pair and the line that needs it together. */}
      {engine === "voxa" && (
        <>
          <RuntimeSection label="VOICE" />
          <VoiceLines />
        </>
      )}
      {groups.map(({ provider, entries }) => {
        const installed = entries.filter((e) => e.locality === "local" && e.state === "installed").length;
        // A provider serves one capability in every case the manifest has; where it ever serves
        // two, the heading names the one its first model dispatches as rather than inventing a
        // pairing the capability vocabulary has no word for.
        const capability = entries[0]!.model.capability;
        return (
          <div key={provider}>
            <RuntimeSection
              label={
                several
                  ? `${CAPABILITY_LABEL[capability]} · ${PROVIDER_TABLE[provider].displayName}`.toUpperCase()
                  : "MODELS"
              }
            >
              <span className="fy-rt__count">{`${installed} OF ${entries.length} INSTALLED`}</span>
            </RuntimeSection>
            {entries.map((entry) => (
              <ModelRow
                key={entry.model.id}
                entry={entry}
                open={open === entry.model.id}
                onToggle={() => setOpen(open === entry.model.id ? null : entry.model.id)}
                onOpenDownloads={() => navigate("/settings/downloads")}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

/**
 * The machine, in every figure the verdicts turn on (R-53) plus the free disk the install guard
 * turns on. System memory is a fit input, and a header omitting it cannot explain a verdict it
 * produced.
 *
 * *Not yet measured* and *measured and failed* are different sentences (R-58). The first is the
 * whole status being absent; the second is a probe that answered null.
 *
 * One row per engine pane rather than one header per screen (SPEC-034 R-13), and drawn only
 * where fit is a question — a remote engine has no verdict for these figures to explain, so its
 * pane omits it rather than stating figures nothing on that pane turns on.
 */
export function MachineRow() {
  const { state } = useStore();
  const runtime = state?.app.runtime ?? null;

  // R-58: drawing this is what asks. Detection costs a subprocess and is not done on every boot,
  // which is why SPEC-032's `unmeasured` exists and why its `runtime-detect` control names the
  // pane this row sits in.
  useEffect(() => {
    if (!runtime) detectRuntimes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const probes = runtime?.probes;
  const figure = (mb: number | null | undefined): string => {
    if (runtime === null) return "not measured";
    return mb == null ? "could not measure" : formatGb(mb);
  };
  const accelerator =
    runtime === null
      ? "not measured"
      : probes?.accelerators == null
        ? "could not measure"
        : probes.accelerators.length === 0
          ? "none"
          : probes.accelerators.join(" · ");
  return (
    <div className="fy-rt__keyline">
      <div className="fy-rt__eyebrow">THIS MACHINE</div>
      <div className="fy-set__field">
        {/* Nothing probed is one fact about the machine, not four about its parts: the figures
            all came back the same way and saying so once per figure is the same sentence four
            times. A probe that answered null is different, and keeps its own word. */}
        <span className="fy-set__state" data-testid="machine-header">
          {runtime === null ? (
            "not measured"
          ) : (
            <>
              {accelerator} · {figure(probes?.vramMb)} VRAM · {figure(probes?.memMb)} memory ·{" "}
              {figure(probes?.diskFreeMb)} free
            </>
          )}
        </span>
      </div>
      <button type="button" className="fy-set__link" onClick={() => detectRuntimes()}>
        {runtime === null ? "Measure" : "Re-detect"}
      </button>
    </div>
  );
}

/** Which engine each voice capability runs on, and what its line is called on the screen. */
const VOICE_LINE = {
  kokoro: "Local voices",
  whisper: "Dictation",
} as const;

/**
 * Local voices, dictation and conversational voice, independently readable (R-48, SPEC-028 R-2).
 *
 * Kokoro unavailable with whisper.cpp ready still reads as dictation usable; neither capability
 * collapses into one failed state. Conversational voice is the one line that needs both halves,
 * because a conversation is speech in and speech out — so it is stated under each of them rather
 * than under whichever one it was arbitrarily filed with. Both readings come off the same
 * `voiceRuntime` in the same render, so the two cannot disagree.
 */
function VoiceLines() {
  const { state } = useStore();
  const voice = state?.app.voiceRuntime ?? null;
  const engineState = (which: "kokoro" | "whisper"): string => voice?.engineStatus[which]?.state ?? "unknown";
  const tone = (which: "kokoro" | "whisper"): RuntimeTone => {
    const value = engineState(which);
    return value === "ready" ? "ok" : value === "unknown" ? "idle" : "warn";
  };
  const both = engineState("kokoro") === "ready" && engineState("whisper") === "ready";
  const lines: Array<{ label: string; tone: RuntimeTone; state: string }> = [
    { label: VOICE_LINE.kokoro, tone: tone("kokoro"), state: engineState("kokoro") },
    { label: VOICE_LINE.whisper, tone: tone("whisper"), state: engineState("whisper") },
    {
      label: "Conversational voice",
      tone: both ? "ok" : voice === null ? "idle" : "warn",
      state: both ? "ready" : voice === null ? "unknown" : "needs both",
    },
  ];
  return (
    <>
      {lines.map((line) => (
        <div key={line.label} className="fy-set__row">
          <span className="fy-set__routelabel">{line.label}</span>
          <span style={{ flex: 1 }} />
          <RuntimeStatus tone={line.tone}>{line.state}</RuntimeStatus>
        </div>
      ))}
    </>
  );
}

/**
 * One model. Its name, its state, its verdict and its size — and nothing else on the line (R-51).
 * The engine is never on it (R-52): model ids carry their runtime, so a row that printed one
 * would be listing engines whether it meant to or not. It is in the detail, where somebody
 * troubleshooting will look for it.
 */
function ModelRow({
  entry,
  open,
  onToggle,
  onOpenDownloads,
}: {
  entry: Entry;
  open: boolean;
  onToggle: () => void;
  onOpenDownloads: () => void;
}) {
  const { model, state } = entry;
  const elsewhere = entry.locality === "remote";
  // `unsupported` is both a headline state and a fit verdict, so a declared refusal would print
  // the word twice and say nothing the second time. What distinguishes the two verdicts under
  // that one label is the reason beneath, which R-27 puts there.
  // A transfer's progress rides between the state and the size (R-19): the percentage alone
  // does not say 62 percent of what, and the bar below is a shape rather than a figure.
  const moving = entry.component !== undefined ? transferProgress(entry.component) : null;
  const parts = [
    ROW_STATE_LABEL[state],
    moving?.active === true ? `${moving.percent}%` : undefined,
    entry.fitLabel,
    entry.sizeMbytes && sizeMb(entry.sizeMbytes),
  ];
  const line = parts.filter((part, at) => Boolean(part) && parts.indexOf(part) === at).join(" · ");
  return (
    <div className={cx("fy-set__row", "fy-set__row--stack", !elsewhere && entry.declined && "fy-set__row--off")}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          className="fy-set__link"
          aria-expanded={open}
          aria-label={`Detail for ${model.displayName}`}
          onClick={onToggle}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">{model.displayName}</div>
        </div>
        {entry.recommended && <span className="fy-prov__unverified">recommended</span>}
        <RuntimeStatus tone={elsewhere ? undefined : STATE_TONE[state]}>{line}</RuntimeStatus>
        {/*
         * Starting work stays where the decision is made; watching it belongs to Downloads
         * (R-83). The figure on the button is the whole closure's, because quoting the model's
         * own weight while silently fetching an engine beside it makes honest arithmetic
         * dishonest (R-40).
         */}
        {!elsewhere && state === "available" && entry.closure !== undefined && (
          <Button onClick={() => setupInstall(entry.component!.id)}>
            Install · {sizeMb(entry.closure.downloadMb)}
          </Button>
        )}
        {/* Retry starts the chain, not one link of it. Retrying the model alone re-blocks it on
            the runtime that failed, with no way to reach that runtime from this row — the same
            failure the Install button was widened to a closure to avoid. */}
        {!elsewhere && state === "needs-attention" && entry.component !== undefined && (
          <button
            type="button"
            className="fy-set__link"
            onClick={() =>
              entry.component!.repairRequired === true
                ? setupRepair(entry.component!.id)
                : setupInstall(entry.component!.id)
            }
          >
            {entry.component.repairRequired === true ? "Repair" : "Retry"}
          </button>
        )}
        {/* Remove is offered wherever a size on disk is stated (R-43): a screen that only ever
            grows is a screen that eventually costs somebody their disk. */}
        {/* Only where Arke may actually take it away: a component setup fetches unasked comes
            back on the next launch, and a weight file inside a mapped folder may have been the
            user's before Arke ever saw it. A Remove that cannot act is worse than none. */}
        {!elsewhere && state === "installed" && entry.component?.removable === true && (
          <button type="button" className="fy-set__link" onClick={() => setupRemove(entry.component!.id)}>
            Remove
          </button>
        )}
        {!elsewhere && (state === "downloading" || state === "installing") && (
          <button type="button" className="fy-set__link" onClick={onOpenDownloads}>
            Downloads
          </button>
        )}
      </div>
      {/* Stated by count, and only by count (R-41). `Install ComfyUI 0.3.48 and its nodes` is the
          machine's sentence; the components themselves are behind the detail. */}
      {!elsewhere && state === "available" && (entry.closure?.supporting ?? 0) > 0 && (
        <div className="fy-set__why">
          <span className="fy-set__dot" />
          <span>
            {entry.closure!.supporting} supporting component{entry.closure!.supporting === 1 ? "" : "s"}
            {entry.closure!.installedMb > entry.closure!.downloadMb
              ? ` · ${sizeMb(entry.closure!.installedMb)} on disk`
              : ""}
          </span>
        </div>
      )}
      {/* The same projection Downloads computes, never a second one (R-82). */}
      {entry.component !== undefined && transferProgress(entry.component).active && (
        <div className="fy-set__bar">
          <div className="fy-set__barfill" style={{ width: `${transferProgress(entry.component).percent}%` }} />
        </div>
      )}
      {/* One clause on the thing refused, carrying its figures (R-88). `insufficient` and
          `unsupported` share the headline word and keep separate reasons, so the reader who has
          stopped on a row still gets the distinction the label costs them (R-27, D12).

          The gate's cloud alternative is deliberately not printed. R-2 keeps every cloud provider
          off this screen in any state, and R-24's remedy for `insufficient` is the smaller models
          for that capability — which are already the other entries in this very row. */}
      {/* Only a refusal owes one (R-27, R-21). A passing verdict's reason is the floor it
          cleared — `Needs 3.9 GB memory · this machine has 32 GB` under a row that says
          `installed` — which is the good news stated as a requirement, and changes nothing. */}
      {entry.reason && (entry.state === "unsupported" || entry.state === "needs-attention") && (
        <div className="fy-set__why">
          <span className={cx("fy-set__dot", !elsewhere && state === "unsupported" && "fy-set__dot--warn")} />
          <span>{entry.reason}</span>
        </div>
      )}
      {entry.ineligible && (
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>{entry.ineligible}</span>
        </div>
      )}
      {open && (
        <div className="fy-set__why">
          <span className="fy-set__dot" />
          {/* R-51 also names quantisation and install location for this disclosure. Neither is
              stated: no manifest row carries a quantisation, and an absolute install path is
              host-owned and belongs to Engines, where SPEC-028 R-4's constraint already puts it. */}
          <span>
            {PROVIDER_TABLE[model.provider].displayName} · {model.id}
            {model.limits.maxContextTokens ? ` · ${Math.round(model.limits.maxContextTokens / 1000)}K context` : ""}
            {model.family ? ` · ${model.family}` : ""}
            {/* By name, never by id: `ollama-gemma4-12b` carrying its runtime in its own id is
                the leak this whole rearrangement exists to stop, and printing one on screen
                would be committing it in the one place a person reads. */}
            {entry.supporting.length > 0 ? ` · needs ${entry.supporting.join(", ")}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
