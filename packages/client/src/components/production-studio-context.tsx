import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ConversationActionCard, HumanDecisionCard } from "@arke-studio/contracts";
import { PanelRight } from "./icons.js";

export type StudioControls = { active: boolean; canvasHost: HTMLElement | null; fullCardId: string | null;
  toggle(): void; widen(): void; show(action: ConversationActionCard, full: boolean): void;
  showDecision(card: HumanDecisionCard): void; back(): void; sideHost(element: HTMLDivElement | null): void;
  /** What the side holds when there is no portal host to move into it: server rendering only. */
  restingSide: ReactNode };
export const ProductionStudioContext = createContext<StudioControls | null>(null);
/**
 * Told when a Studio opens inside the page rather than over it (design turn 196o). The production
 * shell owns the rail, and the rail is what has to give way: on a Fold the full rail kept 270px
 * beside an open Studio, and the canvas — meant to take the rest — was left a third of the screen.
 */
export const StudioInlineContext = createContext<((open: boolean) => void) | null>(null);
export const useProductionStudio = () => useContext(ProductionStudioContext);

const subscribe = () => () => {};
/**
 * True once rendering on the client. A portal host is made only then: `typeof document` let the
 * linkedom document a test installs globally through, and the server renderer — which those same
 * tests use for their string snapshots — throws on a portal.
 */
export const useClientRender = () => useSyncExternalStore(subscribe, () => true, () => false);

export function StudioToggle() {
  const studio = useProductionStudio();
  return studio ? <><button type="button" className="fy-studio-toggle" onClick={studio.toggle} aria-pressed={studio.active}>{studio.active ? "Close Studio" : "Studio"}</button>
    {!studio.active && <button type="button" className="fy-studio-toggle" onClick={studio.widen}>Widen dock</button>}</> : null;
}
/** The page's way back to its canvas while the Studio is closed (design turn 202c). */
export function StudioCanvasPress() {
  const studio = useProductionStudio();
  return studio && !studio.active ? <button type="button" className="fy-studio-canvas" onClick={studio.toggle}><PanelRight size={16} />Canvas</button> : null;
}
export function StudioShow({ action }: { action: ConversationActionCard }) {
  const studio = useProductionStudio();
  return studio ? <div className="fy-studio-card-controls"><button type="button" onClick={() => studio.show(action, false)}>Show</button>
    <button type="button" onClick={() => studio.show(action, true)}>Open full size</button></div> : null;
}
export function StudioSidebar() { const studio = useProductionStudio(); return <div ref={studio?.sideHost}>{studio?.restingSide}</div>; }

/** Reparent the one card instance: host work, decisions and unsaved reviews are never cloned. */
export function StudioCard({ id, children }: { id: string; children: ReactNode }) {
  const studio = useProductionStudio(), home = useRef<HTMLDivElement>(null);
  const client = useClientRender();
  const [host] = useState(() => client ? document.createElement("div") : null);
  const moved = !!studio?.active && studio.fullCardId === id && !!studio.canvasHost;
  useLayoutEffect(() => {
    const target = moved ? studio?.canvasHost : home.current;
    if (host && target) target.appendChild(host);
    return () => { host?.remove(); };
  }, [host, moved, studio?.canvasHost]);
  if (!studio) return <>{children}</>;
  return <><div ref={home} id={`studio-card-${id}`} tabIndex={-1} />
    {moved && <button type="button" className="fy-studio-return" onClick={studio.back}>Opened in canvas · Back to card</button>}
    {host ? createPortal(children, host) : children}</>;
}
