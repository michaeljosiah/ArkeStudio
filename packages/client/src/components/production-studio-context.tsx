import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ConversationActionCard, HumanDecisionCard } from "@arke-studio/contracts";

export type StudioControls = { active: boolean; canvasHost: HTMLElement | null; fullCardId: string | null;
  toggle(): void; widen(): void; show(action: ConversationActionCard, full: boolean): void;
  showDecision(card: HumanDecisionCard): void; back(): void; sideHost(element: HTMLDivElement | null): void };
export const ProductionStudioContext = createContext<StudioControls | null>(null);
export const useProductionStudio = () => useContext(ProductionStudioContext);

export function StudioToggle() {
  const studio = useProductionStudio();
  return studio ? <><button type="button" className="fy-studio-toggle" onClick={studio.toggle} aria-pressed={studio.active}>{studio.active ? "Close Studio" : "Studio"}</button>
    {!studio.active && <button type="button" className="fy-studio-toggle" onClick={studio.widen}>Widen dock</button>}</> : null;
}
export function StudioShow({ action }: { action: ConversationActionCard }) {
  const studio = useProductionStudio();
  return studio ? <div className="fy-studio-card-controls"><button type="button" onClick={() => studio.show(action, false)}>Show</button>
    <button type="button" onClick={() => studio.show(action, true)}>Open full size</button></div> : null;
}
export function StudioSidebar() { const studio = useProductionStudio(); return <div ref={studio?.sideHost} />; }

/** Reparent the one card instance: host work, decisions and unsaved reviews are never cloned. */
export function StudioCard({ id, children }: { id: string; children: ReactNode }) {
  const studio = useProductionStudio(), home = useRef<HTMLDivElement>(null);
  const [host] = useState(() => typeof document === "undefined" ? null : document.createElement("div"));
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
