import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Minus, Plus } from "../../components/icons.js";

/**
 * The Stage panel's field grammar (design turn 144): a row is a label in a fixed column and one
 * control that starts at the column's edge, whichever row it is. Every form on the panel is built
 * from these, so a number, a choice, a yes/no and three-of-a-kind each look one way.
 */

export function Eyebrow({ title, meta, hint }: { title: string; meta?: string; hint?: string }) {
  return (
    <div className="fy-swstage__eyebrow">
      <span title={hint}>{title}</span>
      {meta === undefined ? null : <span>{meta}</span>}
    </div>
  );
}

export function Row({ label, top, children }: { label: string; top?: boolean; children: ReactNode }) {
  return (
    <div className="fy-swstage__row" data-top={top ? "true" : undefined}>
      <span className="fy-swstage__rowlabel">{label}</span>
      {children}
    </div>
  );
}

export function Value({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <span className="fy-swstage__value" data-muted={muted ? "true" : undefined}>{children}</span>;
}

export function Link({ children, onClick, disabled, title }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return <button type="button" className="fy-swstage__link" disabled={disabled} title={title} onClick={onClick}>{children}</button>;
}

/**
 * Escape in a field is the field's: it drops what was typed and leaves the box, and stops there, so
 * the page's Escape (leaving full screen, on the document) waits for the next press. Every other
 * key propagates — the Stage's shortcuts already ignore keys typed into an input.
 */
export function fieldEscape(event: ReactKeyboardEvent<HTMLElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * A number: its value with its unit, typed or nudged. Typing lands as soon as it reads as a
 * number within bounds — a person watching the camera wants the move to follow the keystroke —
 * and the box tidies itself (clamped, to its places) when the typing leaves. A nudge steps from
 * the value, or from the inherited one the box shows muted when nothing is set.
 */
export function Stepper({ label, value, unit, step, min, max, decimals, placeholder, disabled, clearable, less, more, onCommit }: {
  label: string;
  value: number | undefined;
  unit?: string;
  step: number;
  min?: number;
  max?: number;
  decimals?: number;
  /** What the box reads when the value is not set — the inherited number, muted. */
  placeholder?: string;
  disabled?: boolean;
  /** An emptied box clears the value rather than reverting. */
  clearable?: boolean;
  less?: string;
  more?: string;
  onCommit: (value: number | undefined) => void;
}) {
  const places = decimals ?? decimalsOf(step);
  const shown = value === undefined ? "" : value.toFixed(places);
  const [text, setText] = useState(shown);
  const focused = useRef(false);
  // Escape reverts and leaves the box, and the blur that follows must not read the box first: the
  // revert has not rendered when blur() runs synchronously, so the blur would commit what was typed.
  const escaped = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);
  const within = (next: number) => (min === undefined || next >= min) && (max === undefined || next <= max);
  const clamp = (next: number) => {
    const low = min === undefined ? next : Math.max(min, next);
    return max === undefined ? low : Math.min(max, low);
  };
  const type = (raw: string) => {
    setText(raw);
    const trimmed = raw.trim();
    if (trimmed === "") { if (clearable) onCommit(undefined); return; }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed) || !within(parsed)) return;
    const next = Number(parsed.toFixed(places));
    if (next !== value) onCommit(next);
  };
  const leave = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") { setText(clearable ? "" : shown); return; }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed)) { setText(shown); return; }
    const next = Number(clamp(parsed).toFixed(places));
    setText(next.toFixed(places));
    if (next !== value) onCommit(next);
  };
  const nudge = (direction: -1 | 1) => {
    const inherited = placeholder === undefined ? Number.NaN : Number.parseFloat(placeholder);
    const base = value ?? (Number.isFinite(inherited) ? inherited : 0);
    onCommit(Number(clamp(base + direction * step).toFixed(places)));
  };
  // The box is as wide as its own text, so the unit reads right after the number (`1.55 m`) the
  // way the master draws it, rather than at the far end of a box that grew to fill the row.
  const chars = Math.max((text === "" ? placeholder ?? "" : text).length, 2) + 0.5;
  return (
    <span className="fy-swstage__stepper" data-inherited={value === undefined && placeholder !== undefined ? "true" : undefined}>
      <input
        type="number"
        aria-label={label}
        value={text}
        placeholder={placeholder}
        style={{ width: `${chars}ch` }}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onFocus={() => { focused.current = true; escaped.current = false; }}
        onChange={(event) => type(event.target.value)}
        onBlur={(event) => {
          focused.current = false;
          if (escaped.current) { escaped.current = false; setText(shown); return; }
          leave(event.currentTarget.value);
        }}
        onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          else if (event.key === "Escape") { fieldEscape(event); setText(shown); escaped.current = true; event.currentTarget.blur(); }
        }}
      />
      {unit === undefined ? null : <span className="fy-swstage__unit">{unit}</span>}
      <span className="fy-swstage__nudge">
        <button type="button" aria-label={less ?? `${label} down`} disabled={disabled} onClick={() => nudge(-1)}><Minus size={10} /></button>
        <button type="button" aria-label={more ?? `${label} up`} disabled={disabled} onClick={() => nudge(1)}><Plus size={10} /></button>
      </span>
    </span>
  );
}

/** Three of a kind on one row — a place, a size, a rotation — each cell prefixed with its axis. */
export function Triad({ cells, disabled, step = 0.1 }: {
  cells: readonly { prefix: string; label: string; value: number; min?: number; onCommit: (value: number) => void }[];
  disabled?: boolean;
  step?: number;
}) {
  return (
    <span className="fy-swstage__triad">
      {cells.map((cell) => (
        <label key={cell.prefix}>
          <span>{cell.prefix}</span>
          <input
            key={`${cell.prefix}:${cell.value}`}
            type="number"
            step={step}
            min={cell.min}
            aria-label={cell.label}
            defaultValue={cell.value}
            disabled={disabled}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
              else if (event.key === "Escape") { fieldEscape(event); event.currentTarget.value = String(cell.value); event.currentTarget.blur(); }
            }}
            onBlur={(event) => {
              const parsed = Number.parseFloat(event.currentTarget.value);
              if (!Number.isFinite(parsed)) { event.currentTarget.value = String(cell.value); return; }
              const next = cell.min === undefined ? parsed : Math.max(cell.min, parsed);
              if (next !== cell.value) cell.onCommit(Math.round(next * 100) / 100);
            }}
          />
        </label>
      ))}
    </span>
  );
}
