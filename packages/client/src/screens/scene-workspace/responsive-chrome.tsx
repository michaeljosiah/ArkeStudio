import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "../../lib/media-query.js";
import { PageSheet } from "../../components/page-sheet.js";
import { ChevronLeft, More, Pin, Sparkle } from "../../components/icons.js";

/**
 * Turn 168: a deep page owns the phone's head and the assistant overlays its work. Two lines, the
 * context over the title, unless `back` names where the chevron goes: then the bar is 194h's one
 * line, the chevron and the title, and the context is said only to a screen reader, by the press.
 */
export function SceneBackRow({ context, back, title, onBack, press, children }: { context?: string; /** The one-line bar (194h): what the back press returns to, as its label says it. */ back?: string; title: string; onBack: () => void; /** One press in the place of the ⋯ menu, for a page whose menu would hold only that press (design turn 194, rule 15). */ press?: ReactNode; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const line = back !== undefined;
  return <>
    <header className={line ? "fy-scene-back fy-scene-back--line" : "fy-scene-back"}>
      <button type="button" aria-label={line ? `Back to ${back}` : "Back"} onClick={onBack}><ChevronLeft size={line ? 16 : 20} /></button>
      <div>{!line && <span>{context}</span>}<h1>{title}</h1></div>
      {press ?? <button type="button" aria-label="Page actions" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><More size={line ? 16 : 20} /></button>}
    </header>
    {press === undefined && <PageSheet open={open} onClose={() => setOpen(false)} title={title} className="fy-scene-page-menu">
      <div className="fy-scene-menu" onClick={event => { if ((event.target as Element).closest("button")) setOpen(false); }}>{children}</div>
    </PageSheet>}
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
  const inlineHost = useRef<HTMLDivElement>(null), sheetHost = useRef<HTMLDivElement>(null);
  const [conversationHost, setConversationHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => { setConversationHost(document.createElement("div")); }, []);
  // Reparent one portal host, not the conversation: its unsent words and thread-opening
  // request must survive both putting the dock away and moving it across a breakpoint.
  useLayoutEffect(() => {
    const parent = compact ? sheetHost.current : inlineHost.current;
    if (parent && conversationHost) { conversationHost.className = "fy-scene-dock-content"; parent.appendChild(conversationHost); }
  }, [compact, conversationHost]);
  useEffect(() => {
    if (!phone) return;
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
    {phone ? <Sparkle size={16} /> : <span className="fy-sw__rail-dot" aria-hidden="true" />}<span className="fy-sw__rail-label">{phone ? stage ? "Conversation" : "Arke" : "Ask Arke"}</span><span className="fy-sw__rail-pin"><Pin size={13} /></span>
  </button>;
  return <>
    {compact ? rail : open ? null : rail}
    <div ref={inlineHost} className="fy-scene-dock-inline" hidden={compact || !open} />
    <PageSheet open={compact && open} keepMounted onClose={onClose} title="Arke" className="fy-scene-dock"><div ref={sheetHost} className="fy-scene-dock-content" /></PageSheet>
    {conversationHost ? createPortal(children, conversationHost) : children}
  </>;
}

export function StageInspectorSheet({ sheet, children }: { sheet: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const inlineHost = useRef<HTMLDivElement>(null), sheetHost = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => { setHost(document.createElement("div")); }, []);
  useLayoutEffect(() => {
    const parent = sheet ? sheetHost.current : inlineHost.current;
    if (parent && host) { host.style.display = "contents"; parent.appendChild(host); }
  }, [sheet, host]);
  return <>
    {sheet && <button type="button" className="ui-btn ui-btn--outline fy-stage-inspector-open" aria-haspopup="dialog" onClick={() => setOpen(true)}>Inspector</button>}
    <div ref={inlineHost} hidden={sheet} className="fy-stage-inspector-inline" />
    <PageSheet open={sheet && open} keepMounted onClose={() => setOpen(false)} title="Stage inspector" className="fy-stage-inspector-sheet">
      <div ref={sheetHost} data-screen="shot" />
    </PageSheet>
    {host ? createPortal(children, host) : children}
  </>;
}

export function SceneRenameSheet({ title, value, locked, onClose, onCommit }: { title: string; value: string; locked: boolean; onClose: () => void; onCommit: (name: string) => boolean }) {
  const [name, setName] = useState(value);
  const openingValue = useRef(value);
  const changed = openingValue.current !== value;
  useEffect(() => { if (changed) onClose(); }, [changed, onClose]);
  const submit = () => { const next = name.trim(); if (next && !locked && !changed && (next === value || onCommit(next))) onClose(); };
  return <PageSheet open title={title} onClose={onClose} className="fy-scene-rename" footer={<button type="button" className="ui-btn ui-btn--primary" disabled={changed || locked || !name.trim()} onClick={submit}>Save name</button>}>
    <label>Name<input value={name} disabled={locked} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); submit(); } }} /></label>
  </PageSheet>;
}
