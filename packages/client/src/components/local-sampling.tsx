import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  SAMPLING_CHOICE_NAMES,
  SAMPLING_RANGE_COPY,
  effectiveSampling,
  presetValues,
  samplingEstimateCopy,
  samplingEstimateSec,
  samplingOptions,
  samplingProblems,
  samplingSummary,
  type ManifestModel,
  type ModelSampling,
  type SamplingChoiceId,
  type SamplingField,
  type SamplingValues,
} from "@arke-studio/contracts";
import { EditorDialog } from "./editor-dialog.js";
import { Button, cx } from "./ui.js";
import { setLocalSampling, useStore } from "../lib/store.js";

/**
 * Sampling for a local recipe (design turn 177): the line on its AI models tile, the dialog that
 * line opens, and the chip beside the adapter in Generate. All three read and write the one
 * device setting per recipe, and every number they show is the recipe's catalogue or this
 * machine's measurement — nothing here holds a preset of its own.
 */

/** "Local · H3 Video" → "H3 Video": the dialog's title is already about this machine. */
function shortName(model: ManifestModel): string {
  return model.displayName.replace(/^Local · /, "");
}

/** The setting as stored, the values it resolves to, and the measured time per preset. */
function useSampling(model: ManifestModel) {
  const { state } = useStore();
  const catalogue = model.sampling!;
  const setting = state?.app.localSampling?.choices[model.id];
  const samples = state?.app.localSampling?.timings[model.id];
  const effective = effectiveSampling(catalogue, setting);
  const time = (steps: number) => samplingEstimateCopy(samplingEstimateSec(samples, steps));
  return { state, catalogue, setting, effective, time };
}

const PRESETS = ["fast", "balanced", "quality"] as const;

/** A draft of the five fields as typed: strings, so a half-typed number is not coerced away. */
type Draft = Record<SamplingField, string>;

function draftOf(values: SamplingValues): Draft {
  return {
    steps: String(values.steps),
    speedAdapter: String(values.speedAdapter),
    shift: String(values.shift),
    sampler: values.sampler,
    scheduler: values.scheduler,
  };
}

function valuesOf(draft: Draft) {
  const number = (text: string) => (text.trim() === "" ? Number.NaN : Number(text));
  return {
    steps: number(draft.steps),
    speedAdapter: number(draft.speedAdapter),
    shift: number(draft.shift),
    sampler: draft.sampler,
    scheduler: draft.scheduler,
  };
}

/** The dialog (design 177a, 177b): three presets and Custom, each with its time on this machine. */
export function SamplingDialog({ model, open, onClose }: { model: ManifestModel; open: boolean; onClose: () => void }) {
  const { state, catalogue, setting, time } = useSampling(model);
  const fast = presetValues(catalogue, "fast");
  const stored = setting?.preset ?? "fast";
  const [choice, setChoice] = useState<SamplingChoiceId>(stored);
  const [draft, setDraft] = useState<Draft>(draftOf(setting?.values ?? fast));
  // Each opening starts from what is saved, not from an abandoned edit.
  useEffect(() => {
    if (!open) return;
    setChoice(setting?.preset ?? "fast");
    setDraft(draftOf(setting?.values ?? fast));
  }, [open]);
  const engine = state?.app.comfyui?.engine.samplerOptions;
  const options = samplingOptions(catalogue, engine);
  const custom = valuesOf(draft);
  const problems = choice === "custom" ? samplingProblems(custom, catalogue, engine) : [];
  const vram = state?.app.runtime?.probes?.vramMbByAccelerator?.cuda ?? state?.app.runtime?.probes?.vramMb ?? null;
  const subtitle = [vram !== null ? `${Math.round(vram / 1024)} GB` : null, `${catalogue.clipSec} s clip`].filter(Boolean).join(" · ");
  const save = () => {
    setLocalSampling(
      model.id,
      choice === "fast"
        ? null
        : choice === "custom"
          ? { preset: "custom", values: custom as SamplingValues }
          : { preset: choice },
    );
    onClose();
  };
  const field = (name: "steps" | "speedAdapter" | "shift", label: string, step: string) => (
    <div className={cx("fy-samp__field", problems.includes(name) && "is-bad")}>
      <label htmlFor={`fy-samp-${name}`}>{label}</label>
      <input
        id={`fy-samp-${name}`}
        type="number"
        inputMode="decimal"
        step={step}
        value={draft[name]}
        aria-invalid={problems.includes(name)}
        onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
      />
      <span className="fy-samp__range">{SAMPLING_RANGE_COPY[name]}</span>
    </div>
  );
  const pick = (name: "sampler" | "scheduler", label: string, list: string[]) => (
    <div className={cx("fy-samp__field", problems.includes(name) && "is-bad")}>
      <label htmlFor={`fy-samp-${name}`}>{label}</label>
      <select id={`fy-samp-${name}`} value={draft[name]} onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}>
        {!list.includes(draft[name]) && <option value={draft[name]}>{draft[name]}</option>}
        {list.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <EditorDialog open={open} title={`${shortName(model)} · Sampling`} subtitle={subtitle} onClose={onClose} width={560} panelClassName="fy-samp">
      <div className="fy-samp__opts" role="radiogroup" aria-label="Sampling">
        {PRESETS.map((id) => {
          const values = presetValues(catalogue, id);
          return (
            <label key={id} className={cx("fy-samp__opt", choice === id && "is-on")}>
              <input type="radio" name={`fy-samp-${model.id}`} checked={choice === id} onChange={() => setChoice(id)} />
              <span className="fy-samp__what">
                <b>
                  {SAMPLING_CHOICE_NAMES[id]}
                  {id === "fast" && <span className="fy-samp__tag">Default</span>}
                </b>
                <span>{samplingSummary(values)}</span>
              </span>
              <span className="fy-samp__time">{time(values.steps)}</span>
            </label>
          );
        })}
        <label className={cx("fy-samp__opt", choice === "custom" && "is-on")}>
          <input type="radio" name={`fy-samp-${model.id}`} checked={choice === "custom"} onChange={() => setChoice("custom")} />
          <span className="fy-samp__what">
            <b>{SAMPLING_CHOICE_NAMES.custom}</b>
            {choice === "custom" && Number.isFinite(custom.steps) && Number.isFinite(custom.speedAdapter) && Number.isFinite(custom.shift) && (
              <span>{samplingSummary(custom as SamplingValues, fast)}</span>
            )}
          </span>
          <span className="fy-samp__time">{problems.includes("steps") || !Number.isFinite(custom.steps) ? "—" : time(custom.steps)}</span>
        </label>
        {choice === "custom" && (
          <div className="fy-samp__fields">
            {field("steps", "Steps", "1")}
            {field("speedAdapter", "Speed adapter", "0.05")}
            {field("shift", "Shift", "0.5")}
            {pick("sampler", "Sampler", options.samplers)}
            {pick("scheduler", "Scheduler", options.schedulers)}
          </div>
        )}
      </div>
      <div className="fy-samp__foot">
        <button
          type="button"
          className="fy-set__link"
          onClick={() => {
            setChoice("fast");
            setDraft(draftOf(fast));
          }}
        >
          Reset to Fast
        </button>
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={problems.length > 0} onClick={save}>
          Save
        </Button>
      </div>
    </EditorDialog>
  );
}

/** The tile's line (design 177a): `Sampling · Fast · Change`. */
export function SamplingLine({ model, openOnMount = false }: { model: ManifestModel; openOnMount?: boolean }) {
  const { effective } = useSampling(model);
  const [open, setOpen] = useState(openOnMount);
  return (
    <div className="fy-samp__line" data-testid="sampling-line">
      <span>Sampling</span>
      <strong>{SAMPLING_CHOICE_NAMES[effective.preset]}</strong>
      <span style={{ flex: 1 }} />
      <button type="button" className="fy-set__link" onClick={() => setOpen(true)}>
        Change
      </button>
      <SamplingDialog model={model} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

/**
 * The chip beside the adapter in Generate (design 177c): the chosen preset, and a menu that
 * writes the same Settings value — Custom included, which it keeps as stored — with `Edit in
 * Settings` opening the dialog there.
 */
export function SamplingChip({ model }: { model: ManifestModel }) {
  const { catalogue, setting, effective, time } = useSampling(model);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const customValues = setting?.preset === "custom" ? setting.values : undefined;
  const choose = (id: SamplingChoiceId) => {
    setOpen(false);
    if (id === "custom") {
      // Custom has values only the dialog can set; with none stored, the dialog is the way in.
      if (customValues === undefined) navigate(`/settings/models?model=${encodeURIComponent(model.id)}&sampling=1`);
      else setLocalSampling(model.id, { preset: "custom", values: customValues });
      return;
    }
    setLocalSampling(model.id, id === "fast" ? null : { preset: id });
  };
  const row = (id: SamplingChoiceId, steps: number | null) => (
    <button
      key={id}
      type="button"
      role="menuitemradio"
      aria-checked={effective.preset === id}
      className={cx("fy-samp__item", effective.preset === id && "is-on")}
      onClick={() => choose(id)}
    >
      <span>{SAMPLING_CHOICE_NAMES[id]}</span>
      <small>{steps === null ? "—" : time(steps)}</small>
    </button>
  );
  return (
    <span className="fy-samp__chipwrap" ref={root}>
      <button
        type="button"
        className="fy-samp__chip"
        data-testid="sampling-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Sampling: ${SAMPLING_CHOICE_NAMES[effective.preset]}`}
        onClick={() => setOpen(!open)}
      >
        {SAMPLING_CHOICE_NAMES[effective.preset]}
        <small>{effective.steps} steps</small>
      </button>
      {open && (
        <span className="fy-samp__menu" role="menu" aria-label="Sampling">
          {PRESETS.map((id) => row(id, presetValues(catalogue, id).steps))}
          {row("custom", customValues?.steps ?? null)}
          <button
            type="button"
            role="menuitem"
            className="fy-samp__item fy-samp__item--foot"
            onClick={() => {
              setOpen(false);
              navigate(`/settings/models?model=${encodeURIComponent(model.id)}&sampling=1`);
            }}
          >
            Edit in Settings
          </button>
        </span>
      )}
    </span>
  );
}

/** Whether a model offers a sampling choice at all. */
export function hasSampling(model: ManifestModel | null | undefined): model is ManifestModel & { sampling: ModelSampling } {
  return model?.provider === "comfyui" && model.sampling !== undefined;
}
