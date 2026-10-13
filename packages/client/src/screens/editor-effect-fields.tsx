import { formatFrames, type FrameRate } from "@arke-studio/contracts";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { timecodeFrames } from "../lib/picture-edit.js";

/** Typed decimals are seconds; timecode stays frame-exact and is rounded only once. */
export function effectTimeFrames(text: string, frameRate: FrameRate): number | null {
  const value = text.trim();
  if (/^\d+(?:\.\d+)?s?$/.test(value)) {
    const frames = Math.round(Number(value.replace(/s$/, "")) * frameRate);
    return Number.isSafeInteger(frames) ? frames : null;
  }
  return timecodeFrames(value, frameRate);
}

function EffectTypedField({ label, value, shown, parse, validate, disabled, suffix, onCommit, resetToken, timecode = false }: {
  label: string; value: number; shown: string; parse: (text: string) => number | null;
  validate: (value: number) => string | null; disabled: boolean; suffix?: string; onCommit: (value: number) => void;
  resetToken?: number | string;
  timecode?: boolean;
}) {
  const id = useId(), [text, setText] = useState(shown), [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) setText(shown); }, [shown]);
  useLayoutEffect(() => { dirty.current = false; setText(shown); setError(null); }, [resetToken, disabled]);
  const commit = () => {
    if (!dirty.current || disabled) return;
    const next = parse(text), problem = next === null ? "Enter a valid number or time." : validate(next);
    if (problem || next === null) { setError(problem); return; }
    dirty.current = false; setError(null); setText(shown);
    if (next !== value) onCommit(next);
  };
  return <div className={`fx-field${timecode ? " fx-field--time" : ""}`}>
    <label htmlFor={id}>{label}{suffix && <span className="fx-field__unit">{suffix}</span>}</label>
    <input id={id} value={text} inputMode="decimal" disabled={disabled} spellCheck={false}
      aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
      onFocus={event => event.currentTarget.select()}
      onInput={event => { dirty.current = true; setText(event.currentTarget.value); setError(null); }}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commit(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dirty.current = false; setText(shown); setError(null); }
      }} />
    {error && <span id={`${id}-error`} className="fx-field__error" role="alert">{error}</span>}
  </div>;
}

export function EffectNumberField({ label, value, min, max, step = 0.01, suffix, disabled, onCommit, onPreview, slider = false, validate, resetToken }: {
  label: string; value: number; min: number; max: number; step?: number; suffix?: string; disabled: boolean;
  onCommit: (value: number) => void; onPreview?: (value: number | null) => void; slider?: boolean;
  validate?: (value: number) => string | null;
  resetToken?: number | string;
}) {
  const [draft, setDraft] = useState<number | null>(null), latest = useRef({ onCommit, onPreview, value, disabled });
  latest.current = { onCommit, onPreview, value, disabled };
  const gesture = useRef<{ value: number; initial: number } | null>(null);
  useEffect(() => () => { if (gesture.current !== null) latest.current.onPreview?.(null); }, []);
  useLayoutEffect(() => {
    if (gesture.current !== null) { gesture.current = null; latest.current.onPreview?.(null); }
    setDraft(null);
  }, [resetToken, disabled]);
  const finish = (cancel = false) => {
    const next = gesture.current; gesture.current = null; setDraft(null);
    if (next === null) return;
    latest.current.onPreview?.(null);
    if (!cancel && !latest.current.disabled && next.value !== next.initial) latest.current.onCommit(next.value);
  };
  return <div className="fx-number">
    <EffectTypedField label={label} value={value} shown={String(Number(value.toFixed(4)))} disabled={disabled} suffix={suffix} resetToken={resetToken}
      parse={text => text.trim() !== "" && /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text.trim()) && Number.isFinite(Number(text)) ? Number(text) : null}
      validate={next => next < min || next > max ? `Use a value from ${min} to ${max}.` : validate?.(next) ?? null} onCommit={onCommit} />
    {slider && <input className="fx-number__slider" type="range" min={min} max={max} step={step} value={draft ?? value}
      aria-label={`${label} slider`} disabled={disabled}
      onPointerDown={event => { try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Released pointers cannot be captured. */ } }}
      onInput={event => { const next = Number(event.currentTarget.value); gesture.current = { value: next, initial: gesture.current?.initial ?? value }; setDraft(next); onPreview?.(next); }}
      onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)} onBlur={() => finish()}
      onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) finish(); }}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(true); } }} />}
  </div>;
}

export function EffectTimeField({ label, value, frameRate, min = 0, max = Number.MAX_SAFE_INTEGER, disabled, onCommit, resetToken }: {
  label: string; value: number; frameRate: FrameRate; min?: number; max?: number; disabled: boolean; onCommit: (frame: number) => void;
  resetToken?: number | string;
}) {
  return <EffectTypedField timecode label={label} value={value} shown={formatFrames(value, frameRate)} disabled={disabled} resetToken={resetToken}
    parse={text => effectTimeFrames(text, frameRate)} validate={next => next < min || next > max ? `Use a time from ${formatFrames(min, frameRate)} to ${max === Number.MAX_SAFE_INTEGER ? "the end of the timeline" : formatFrames(max, frameRate)}.` : null}
    onCommit={onCommit} />;
}
