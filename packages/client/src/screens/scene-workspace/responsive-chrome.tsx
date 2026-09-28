import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMediaQuery } from "../../lib/media-query.js";
import { PageSheet } from "../../components/page-sheet.js";
import { ChevronLeft, More, Pin, Sparkle } from "../../components/icons.js";

/** Turn 168: a deep page owns the phone's head and the assistant overlays its work. */
export function SceneBackRow({ context, title, onBack, children }: { context: string; title: string; onBack: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <header className="fy-scene-back">
      <button type="button" aria-label="Back" onClick={onBack}><ChevronLeft size={20} /></button>
      <div><span>{context}</span><h1>{title}</h1></div>
      <button type="button" aria-label="Page actions" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><More size={20} /></button>
    </header>
    <PageSheet open={open} onClose={() => setOpen(false)} title={title} className="fy-scene-page-menu">
      <div className="fy-scene-menu" onClick={event => { if ((event.target as Element).closest("button")) setOpen(false); }}>{children}</div>
    </PageSheet>
  </>;
}

export function useSceneDock() {
  const compact = useMediaQuery("(max-width: 1099px)");
  const [open, setOpen] = useState(!compact);
  useEffect(() => { setOpen(!compact); }, [compact]);
  return [open, setOpen] as const;
}

export function SceneDock({ open, onOpen, onClose, stage = false, children }: { open: boolean; onOpen: () => void; onClose: () => void; stage?: boolean; children: ReactNode }) {
  const compact = useMediaQuery("(max-width: 1099px)");
  const phone = useMediaQuery("(max-width: 599px)");
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!phone || stage) return;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = trigger.current;
        if (!element) return;
        element.style.translate = "none";
        const box = element.getBoundingClientRect();
        const buttons = [...document.querySelectorAll(".fy-sw__centre button, .fy-sw__centre a, .fy-sw__centre input, .fy-sw__centre textarea, .fy-sw__centre select")].map(button => button.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
        // The master floats over the picture. While scrolling, move it up if a control would
        // otherwise land underneath; neither the shot's actions nor the composer lose a tap.
        for (let lift = 0; lift < window.innerHeight / 2; lift += 8) {
          if (buttons.some(rect => rect.left < box.right && rect.right > box.left && rect.top < box.bottom - lift && rect.bottom > box.top - lift)) continue;
          element.style.translate = `0 -${lift}px`; break;
        }
      });
    };
    place(); window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { cancelAnimationFrame(frame); if (trigger.current) trigger.current.style.translate = "none"; window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [phone, stage]);
  const rail = <button ref={trigger} type="button" className="fy-sw__rail" title="Open Arke" aria-haspopup={compact ? "dialog" : undefined} onClick={onOpen}>
    {phone ? <Sparkle size={16} /> : <span className="fy-sw__rail-dot" aria-hidden="true" />}<span className="fy-sw__rail-label">{phone ? "Arke" : "Ask Arke"}</span><span className="fy-sw__rail-pin"><Pin size={13} /></span>
  </button>;
  if (!compact) return open ? children : rail;
  return <>
    {phone && stage ? null : rail}
    <PageSheet open={open} onClose={onClose} title="Arke" className="fy-scene-dock">{children}</PageSheet>
  </>;
}

export function StageInspectorSheet({ sheet, children }: { sheet: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!sheet) return children;
  return <>
    <button type="button" className="ui-btn ui-btn--outline fy-stage-inspector-open" aria-haspopup="dialog" onClick={() => setOpen(true)}>Inspector</button>
    <PageSheet open={open} keepMounted onClose={() => setOpen(false)} title="Stage inspector" className="fy-stage-inspector-sheet">
      <div data-screen="shot">{children}</div>
    </PageSheet>
  </>;
}

export function SceneRenameSheet({ title, value, locked, onClose, onCommit }: { title: string; value: string; locked: boolean; onClose: () => void; onCommit: (name: string) => boolean }) {
  const [name, setName] = useState(value);
  const submit = () => { const next = name.trim(); if (next && !locked && (next === value || onCommit(next))) onClose(); };
  return <PageSheet open title={title} onClose={onClose} className="fy-scene-rename" footer={<button type="button" className="ui-btn ui-btn--primary" disabled={locked || !name.trim()} onClick={submit}>Save name</button>}>
    <label>Name<input value={name} disabled={locked} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); submit(); } }} /></label>
  </PageSheet>;
}
