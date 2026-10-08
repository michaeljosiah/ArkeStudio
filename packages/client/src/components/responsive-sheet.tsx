import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PageSheet } from "./page-sheet.js";

const subscribe = () => () => {};

/** One mounted panel keeps its draft and pending request when its inline slot becomes a sheet. */
export function ResponsiveSheet({ sheet, open, title, onClose, children, className = "", headless = false, modeless = false }: {
  sheet: boolean; open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string;
  /** The panel draws its own title and close, so the sheet draws none (see PageSheet). */
  headless?: boolean;
  /** Beside the page, not over it (see PageSheet). */
  modeless?: boolean;
}) {
  const client = useSyncExternalStore(subscribe, () => true, () => false);
  const host = useMemo(() => client ? document.createElement("div") : null, [client]);
  const inline = useRef<HTMLDivElement>(null), modal = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = sheet ? modal.current : inline.current;
    if (host && target) { host.style.display = "contents"; target.appendChild(host); }
  }, [host, sheet]);
  return <>
    <div ref={inline} style={{ display: sheet ? "none" : "contents" }} />
    <PageSheet open={sheet && open} title={title} onClose={onClose} keepMounted className={className} headless={headless} modeless={modeless}>
      <div style={{ display: "contents" }} ref={node => { modal.current = node; if (node && host && sheet) { host.style.display = "contents"; node.appendChild(host); } }} />
    </PageSheet>
    {host ? createPortal(children, host) : children}
  </>;
}
