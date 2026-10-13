import { useEffect, useId, useRef, useState } from "react";
import { Help } from "./icons.js";

/**
 * Help, asked for (design turn 200, rule 8): a glyph after a label that opens a small popover on
 * hover, focus or press — the thing's name, one line of what it is, and an example value as a
 * chip — closed by Escape or a press outside. The one place a use is explained; the row it sits in
 * carries no sentence (turn 137). `extra` is data only, such as each narrator's limit.
 */
export function HelpTip({ name, line, example, extra }: { name: string; line: string; example: string; extra?: string }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const press = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (panel.current?.contains(event.target as Node) || press.current?.contains(event.target as Node)) return;
      setOpen(false);
      setPinned(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      setPinned(false);
      press.current?.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return (
    <span className="fy-helptip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!pinned) setOpen(false); }}>
      <button
        ref={press}
        type="button"
        className="fy-helptip__press"
        aria-label={`What is ${name}?`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => { if (!pinned) setOpen(false); }}
        onClick={() => { setPinned((was) => !was || !open); setOpen(true); }}
        data-testid="help-tip"
      >
        <Help size={14} />
      </button>
      {open && (
        <div ref={panel} id={id} className="fy-helptip__pop" role="tooltip" data-testid="help-tip-pop">
          <b>{name}</b>
          <span className="fy-helptip__line">{line}</span>
          <span className="fy-helptip__eg">
            <span className="fy-mono">e.g.</span>
            <span className="fy-helptip__chip">{example}</span>
          </span>
          {extra !== undefined && <span className="fy-mono fy-helptip__extra">{extra}</span>}
        </div>
      )}
    </span>
  );
}
