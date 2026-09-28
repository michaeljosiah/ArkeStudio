import { useMediaQuery } from "../../lib/media-query.js";
import { PageSheet } from "../../components/page-sheet.js";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { Copy, Maximize2, More, ChevronUp, ChevronDown, Plus, Trash } from "../../components/icons.js";
import { ImageDownload } from "../../components/image-actions.js";
import { ReadAloudButton } from "../../components/read-aloud.js";

/** Turn 138: image controls share one hover/focus toolbar; the popover clears the row's clip. */
export function FrameActions({ shotNumber, title, slug, framePath, variants, disabled, canUpload, canClear, onPreview, onVariants, onUpload, onClear, readAloud, order }: {
  order?: { onUp: (() => void) | null; onDown: (() => void) | null; onInsert: () => void; onDelete: () => void };
  shotNumber: number;
  title: string;
  slug: string | undefined;
  framePath: string | null;
  variants: number;
  disabled: boolean;
  canUpload: boolean;
  canClear: boolean;
  onPreview: () => void;
  onVariants: (trigger: HTMLButtonElement) => void;
  onUpload: () => void;
  onClear: () => void;
  readAloud: ComponentProps<typeof ReadAloudButton>;
}) {
  const sheet = useMediaQuery("(hover: none), (max-width: 599px)");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (sheet || !open || !trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const box = panel.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8)),
      top: anchor.bottom + box.height + 8 < window.innerHeight ? anchor.bottom + 6 : Math.max(8, anchor.top - box.height - 6),
    });
    panel.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, sheet]);
  useEffect(() => {
    if (sheet || !open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && (panel.current?.contains(event.target) || trigger.current?.contains(event.target))) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    const moved = () => setOpen(false);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
    };
  }, [open, sheet]);
  return (
    <>
      <div className="fy-swrow__frameactions" data-open={open || undefined} role="group" aria-label={`Image controls for shot ${shotNumber}`} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        <button type="button" title="Expand image" aria-label={`Expand image for shot ${shotNumber}`} disabled={framePath === null} onClick={onPreview}><Maximize2 size={15} /></button>
        <button type="button" title="Frame variants" aria-label={`Frame variants for shot ${shotNumber}`} aria-haspopup="dialog" disabled={variants === 0} onClick={(event) => onVariants(event.currentTarget)}><Copy size={15} /></button>
        <ImageDownload worldSlug={slug} path={framePath ?? ""} name={`Shot ${shotNumber} - ${title}`} ready={framePath !== null} />
        <button ref={trigger} type="button" title="More image actions" aria-label={`More image actions for shot ${shotNumber}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}><More size={15} /></button>
      </div>
      {sheet && <PageSheet open={open} keepMounted onClose={close} title={`Shot ${shotNumber}`} className="fy-frame-actions-sheet">
        <div className="fy-scene-menu">
          <button type="button" disabled={framePath === null} onClick={() => { close(); onPreview(); }}><Maximize2 size={20} />Expand</button>
          <button type="button" disabled={variants === 0} onClick={() => { close(); if (trigger.current) onVariants(trigger.current); }}><Copy size={20} />Variants · {variants}</button>
          <div className="fy-frame-download"><ImageDownload worldSlug={slug} path={framePath ?? ""} name={`Shot ${shotNumber} - ${title}`} ready={framePath !== null} /><span>Download</span></div>
          {order && <><span className="fy-scene-menu__group">Order</span>
            <button type="button" disabled={disabled || order.onUp === null} onClick={() => { close(); order.onUp?.(); }}><ChevronUp size={20} />Move up</button>
            <button type="button" disabled={disabled || order.onDown === null} onClick={() => { close(); order.onDown?.(); }}><ChevronDown size={20} />Move down</button>
            <button type="button" disabled={disabled} onClick={() => { close(); order.onInsert(); }}><Plus size={20} />Insert a shot after</button>
            <button type="button" className="fy-scene-menu__danger" disabled={disabled} onClick={() => { close(); order.onDelete(); }}><Trash size={20} />Delete shot</button>
          </>}
          <span className="fy-scene-menu__group">Frame</span>
          <button type="button" disabled={disabled || !canUpload} onClick={() => { close(); onUpload(); }}>{framePath === null ? "Upload frame" : "Replace frame"}</button>
          <button type="button" disabled={disabled || !canClear} onClick={() => { close(); onClear(); }}>Clear frame</button>
          <ReadAloudButton {...readAloud} />
        </div>
      </PageSheet>}
      {/* Keep read-aloud's request alive while its synthesis finishes, even after menu dismissal. */}
      {!sheet && typeof document !== "undefined" ? createPortal(
        <div ref={panel} hidden={!open} className="fy-swimage-menu" role={open ? "dialog" : undefined} aria-label={`Image actions for shot ${shotNumber}`} style={position} onClick={(event) => event.stopPropagation()}>
          <button type="button" disabled={disabled || !canUpload} title={canUpload ? "Use an image from this computer" : "Upload is available in the desktop app"} onClick={() => { close(); onUpload(); }}>{framePath === null ? "Upload frame" : "Replace frame"}</button>
          <button type="button" disabled={disabled || !canClear} onClick={() => { close(); onClear(); }}>Clear frame</button>
          <ReadAloudButton {...readAloud} />
        </div>, document.body,
      ) : null}
    </>
  );
}
