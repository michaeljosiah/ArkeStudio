import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  FIT_LABEL,
  ROW_STATE_LABEL,
  activationFor,
  comfyUiWeightsComponentId,
  formatGb,
  localModelRowState,
  PROVIDERS as PROVIDER_TABLE,
  type Capability,
  type LocalModelRowState,
  type ManifestModel,
} from "@arke-studio/contracts";
import { Button, cx } from "../components/ui.js";
import { ChevronDown, ChevronRight } from "../components/icons.js";
import { detectRuntimes, useSetup, useStore } from "../lib/store.js";
import { strandReason, usableModels } from "../components/dispatch-bar.js";
import { RuntimeSection, RuntimeStatus, sizeMb, type RuntimeTone } from "./settings-parts.js";

/**
 * Settings · Local AI (SPEC-033 §1.9). What this machine can run, and what is on it.
 *
 * It replaces Local runtime, which was a master and detail of six groups —
 * `This machine · Components · Voice · ComfyUI · Local models · Authoring harness` — three
 * different kinds of thing in one rail. Read together they answered *what is installed here*,
 * which is a question about our architecture. This answers *what can I make here*.
 *
 * Five rows, always all five, and no cloud provider anywhere on the screen. That second half is
 * not a matter of taste: the list is drawn from the local half of the manifest by construction,
 * so R-2 is checkable by enumerating what rendered rather than by reading the code.
 *
 * Nothing here derives a fact another surface owns. Locality and fit come from the gate,
 * activation from the setup ledger, and whether a model can dispatch *now* is SPEC-028 R-35's
 * answer, consumed through `usableModels` — the same function the dispatch bar reads, so the two
 * cannot disagree about one model.
 */

/**
 * The five, in order, and the manifest capabilities each one speaks for (R-47). Exported so a
 * test can assert every capability a local provider declares lands in exactly one row — a
 * capability drawn nowhere renders no models and nothing else would notice.
 */
export const LOCAL_AI_ROWS: ReadonlyArray<{ label: string; capabilities: readonly Capability[] }> = [
  { label: "Images", capabilities: ["image"] },
  { label: "Video", capabilities: ["video"] },
  // Dictation folds in here (epic decision 13): `voice-stt` is the one capability with no cloud
  // counterpart, and it is not a sixth thing anybody thinks about. Its own line, not its own row.
  { label: "Voice", capabilities: ["voice-tts", "voice-stt"] },
  { label: "Music", capabilities: ["music"] },
  { label: "Language", capabilities: ["llm"] },
];

/** What each headline state does to a row's dot. Only a refusal warns. */
const STATE_TONE: Record<LocalModelRowState, RuntimeTone> = {
  "served-elsewhere": "idle",
  unsupported: "warn",
  installed: "ok",
  available: "idle",
  downloading: "idle",
  installing: "idle",
  starting: "idle",
  "needs-attention": "warn",
};

interface Entry {
  model: ManifestModel;
  state: LocalModelRowState;
  /** The verdict's own figures — the refusal, or the floor a passing verdict cleared. */
  reason: string | undefined;
  fitLabel: string | undefined;
  sizeMbytes: number | undefined;
  recommended: boolean;
  /** SPEC-028 R-35's answer, where it refuses a model that is otherwise installed (R-31). */
  ineligible: string | undefined;
}

export function SettingsLocalAiScreen() {
  const { state } = useStore();
  const setup = useSetup();
  const navigate = useNavigate();
  const runtime = state?.app.runtime ?? null;
  const comfyui = state?.app.comfyui ?? null;
  const [open, setOpen] = useState<string | null>(null);

  // R-58: opening this screen is what asks. Detection costs a subprocess and is not done on
  // every boot, which is why SPEC-032's `unmeasured` exists and why it names this screen.
  useEffect(() => {
    if (!runtime) detectRuntimes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const manifest = state?.app.manifest ?? null;
  const components = setup?.components ?? [];
  const disabled = new Set(state?.app.models.disabled ?? []);
  const gatedById = new Map((runtime?.models ?? []).map((m) => [m.modelId, m]));

  /**
   * Every local model of a capability, whether or not the machine has been measured yet.
   *
   * Drawn from the manifest rather than from the gate's output, because the gate has nothing to
   * say until a probe returns and R-28 offers an unmeasured model rather than withholding it.
   * The gate's row is joined on where it exists; locality falls back to the engine's own answer,
   * which is where locality lives either way (R-9).
   */
  const entriesFor = (capabilities: readonly Capability[]): Entry[] => {
    const models = (manifest?.models ?? []).filter(
      (m) => capabilities.includes(m.capability) && PROVIDER_TABLE[m.provider].local,
    );
    const usableIds = new Set(capabilities.flatMap((c) => usableModels(state, c).map((m) => m.id)));
    return models.map((model) => {
      const gated = gatedById.get(model.id);
      const locality =
        gated?.locality ?? (model.provider === "comfyui" ? (comfyui?.engine.locality ?? "local") : "local");
      const activation = activationFor(model.provider, model.id, {
        components,
        ...(comfyui?.engine.state !== undefined ? { comfyUiEngineState: comfyui.engine.state } : {}),
      });
      const rowState = localModelRowState(locality, gated?.fit, activation);
      const component = components.find(
        (c) => c.provides?.includes(model.id) === true || c.id === comfyUiWeightsComponentId(model.id),
      );
      return {
        model,
        state: rowState,
        reason: gated?.reason,
        // Before the probe returns there is no verdict, and R-28 offers the model anyway — so
        // the row says the machine has not been measured rather than leaving the line a word
        // short. A remote model is the one case with no verdict to state at all.
        fitLabel:
          gated?.fit !== undefined
            ? FIT_LABEL[gated.fit]
            : locality === "local"
              ? FIT_LABEL.unknown
              : undefined,
        sizeMbytes: component?.sizeMb ?? model.requires?.diskMb,
        recommended: runtime?.recommended[model.capability] === model.id,
        // Installed and still unable to run is a different sentence from unsupported, and it is
        // not this screen's to compose: R-30 forbids a second eligibility answer, so the row
        // states the one the dispatch bar and enqueue admission already read.
        //
        // Switched off is stated at any row state, not only when installed: being turned down is
        // a decision and the other three are conditions, and R-32 forbids letting a decision
        // read as an absence.
        ineligible: disabled.has(model.id)
          ? "turned off in Providers"
          : rowState === "installed" && !usableIds.has(model.id)
            ? strandReason(state, model)
            : undefined,
      };
    });
  };

  return (
    <div data-screen="settings-local-ai" className="fy-set">
      <div className="fy-set__eyebrow">LOCAL AI</div>
      <MachineHeader />
      {LOCAL_AI_ROWS.map(({ label, capabilities }) => {
        const entries = entriesFor(capabilities);
        const installed = entries.filter((e) => e.state === "installed").length;
        return (
          <div key={label}>
            <RuntimeSection label={label.toUpperCase()}>
              <span className="fy-rt__count">
                {entries.length === 0 ? "NO LOCAL MODELS" : `${installed} OF ${entries.length} INSTALLED`}
              </span>
            </RuntimeSection>
            {label === "Voice" && <VoiceLines />}
            {entries.map((entry) => (
              <ModelRow
                key={entry.model.id}
                entry={entry}
                open={open === entry.model.id}
                onToggle={() => setOpen(open === entry.model.id ? null : entry.model.id)}
                onOpenEngines={() => navigate("/settings/local-runtime")}
              />
            ))}
          </div>
        );
      })}
      <div className="fy-set__actions">
        <Button variant="secondary" onClick={() => navigate("/settings/local-runtime")}>
          Engines
        </Button>
      </div>
    </div>
  );
}

/**
 * The machine, in every figure the verdicts turn on (R-53) plus the free disk the install guard
 * turns on. System memory is a fit input, and a header omitting it cannot explain a verdict it
 * produced.
 *
 * *Not yet measured* and *measured and failed* are different sentences (R-58). The first is the
 * whole status being absent; the second is a probe that answered null.
 */
function MachineHeader() {
  const { state } = useStore();
  const runtime = state?.app.runtime ?? null;
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
      <div className="fy-set__field">
        <span className="fy-set__state" data-testid="machine-header">
          {accelerator} · {figure(probes?.vramMb)} VRAM · {figure(probes?.memMb)} memory ·{" "}
          {figure(probes?.diskFreeMb)} free
        </span>
      </div>
      <button type="button" className="fy-set__link" onClick={() => detectRuntimes()}>
        {runtime === null ? "Measure" : "Re-detect"}
      </button>
    </div>
  );
}

/**
 * Local voices, dictation and conversational voice, independently readable (R-48, SPEC-028 R-2).
 *
 * Kokoro unavailable with whisper.cpp ready still reads as dictation usable; the row does not
 * collapse to one failed state. Conversational voice is the one line that needs both halves,
 * because a conversation is speech in and speech out.
 */
function VoiceLines() {
  const { state } = useStore();
  const voice = state?.app.voiceRuntime ?? null;
  const engineState = (engine: "kokoro" | "whisper"): string => voice?.engineStatus[engine]?.state ?? "unknown";
  const tone = (engine: "kokoro" | "whisper"): RuntimeTone => {
    const value = engineState(engine);
    return value === "ready" ? "ok" : value === "unknown" ? "idle" : "warn";
  };
  const both = engineState("kokoro") === "ready" && engineState("whisper") === "ready";
  const lines: Array<{ label: string; tone: RuntimeTone; state: string }> = [
    { label: "Local voices", tone: tone("kokoro"), state: engineState("kokoro") },
    { label: "Dictation", tone: tone("whisper"), state: engineState("whisper") },
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
  onOpenEngines,
}: {
  entry: Entry;
  open: boolean;
  onToggle: () => void;
  onOpenEngines: () => void;
}) {
  const { model, state } = entry;
  // `unsupported` is both a headline state and a fit verdict, so a declared refusal would print
  // the word twice and say nothing the second time. What distinguishes the two verdicts under
  // that one label is the reason beneath, which R-27 puts there.
  const parts = [ROW_STATE_LABEL[state], entry.fitLabel, entry.sizeMbytes && sizeMb(entry.sizeMbytes)];
  const line = parts.filter((part, at) => Boolean(part) && parts.indexOf(part) === at).join(" · ");
  return (
    <div className={cx("fy-set__row", "fy-set__row--stack", state === "unsupported" && "fy-set__row--off")}>
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
        <RuntimeStatus tone={STATE_TONE[state]}>{line}</RuntimeStatus>
        {state === "served-elsewhere" && (
          <button type="button" className="fy-set__link" onClick={onOpenEngines}>
            Engines
          </button>
        )}
      </div>
      {/* One clause on the thing refused, carrying its figures (R-88). `insufficient` and
          `unsupported` share the headline word and keep separate reasons, so the reader who has
          stopped on a row still gets the distinction the label costs them (R-27, D12).

          The gate's cloud alternative is deliberately not printed. R-2 keeps every cloud provider
          off this screen in any state, and R-24's remedy for `insufficient` is the smaller models
          for that capability — which are already the other entries in this very row. */}
      {entry.reason && (
        <div className="fy-set__why">
          <span className={cx("fy-set__dot", state === "unsupported" && "fy-set__dot--warn")} />
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
          </span>
        </div>
      )}
    </div>
  );
}
