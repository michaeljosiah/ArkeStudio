import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { orderedShots, type ConversationActionCard, type WorldBundle, type WorldChatContext, type WorldChatWorkspace } from "@arke-studio/contracts";
import { BodyLayer } from "./body-layer.js";
import { ProductionStudioContext, useClientRender, type StudioControls } from "./production-studio-context.js";
import { ProductionStudioCanvas } from "./production-studio-canvas.js";
import { useStore } from "../lib/store.js";
import { studioActionFocus, studioEntry, type StudioFocus } from "../lib/production-studio.js";

/** A presentation owner. The same conversation and each full-size card keep one portal instance. */
export function ProductionStudio({ world, productionId, entry, workspace, docked, understanding, proposal, children }: {
  world: WorldBundle | null | undefined; productionId?: string; entry: WorldChatContext; workspace: WorldChatWorkspace | null;
  docked: boolean; understanding: ReactNode; proposal?: ReactNode; children: ReactNode;
}) {
  const proposalDecisions = workspace?.humanDecisions?.filter(card => card.worldId === world?.meta.worldId && card.body.control.kind === "proposal") ?? [];
  const hasProposal = !!proposal || proposalDecisions.length > 0;
  /** A staged proposal is what a wrap-up becomes, so the canvas opens on it (turns 89, 91). */
  const resting = (): StudioFocus => hasProposal ? { ...studioEntry(entry), view: "proposal" } : studioEntry(entry);
  const [active, setActive] = useState(!docked), [wide, setWide] = useState(false), [width, setWidth] = useState(420);
  const [focus, setFocus] = useState<StudioFocus>(resting);
  const [pinned, setPinned] = useState(false), [phoneView, setPhoneView] = useState("thread");
  const [fullCardId, setFullCardId] = useState<string | null>(null), [canvasHost, setCanvasHost] = useState<HTMLDivElement | null>(null);
  const [sideInline, setSideInline] = useState<HTMLDivElement | null>(null);
  const inline = useRef<HTMLDivElement>(null), thread = useRef<HTMLDivElement>(null);
  const understandingSlot = useRef<HTMLDivElement>(null), proposalSlot = useRef<HTMLDivElement>(null), parked = useRef<HTMLDivElement>(null);
  const client = useClientRender(), host = () => client ? document.createElement("div") : null;
  const [chatHost] = useState(host), [understandingHost] = useState(host), [proposalHost] = useState(host);
  const returnId = useRef<string | null>(null), drag = useRef<{ x: number; width: number } | null>(null);
  const production = world?.productions.find(p => p.meta.id === productionId);
  // Read as the transcript reads them: a workspace that never went through the schema's default
  // has no list, and a throw here takes the whole dock with it.
  const actions = (workspace?.actions ?? []).filter(a => a.worldId === world?.meta.worldId && a.productionId === productionId);
  const latest = actions.at(-1);
  const runs = useStore().state?.frameRuns ?? [];
  const actionRun = (action: ConversationActionCard) => {
    const keys = new Set(action.generationWork?.jobKeys ?? []);
    return action.actionKind.startsWith("world-chat-production-frame-run-") ? runs.find(r => r.worldId === world?.meta.worldId && r.productionId === productionId &&
      (r.run.id === `fr_${action.actionId.slice(4)}` || r.run.steps.some(step => keys.has(step.dispatch.idempotencyKey)))) : undefined;
  };
  const actionFocus = (action: ConversationActionCard, fallback: StudioFocus): StudioFocus => {
    const run = actionRun(action);
    return { ...studioActionFocus(action, production, fallback), ...(run ? { view: "scene", sceneId: run.run.sceneId } : {}) };
  };
  const run = latest && actionRun(latest);
  const latestFocus = latest ? actionFocus(latest, studioEntry(entry)) : studioEntry(entry);
  const key = `${world?.meta.worldId ?? ""}:${productionId ?? ""}:${JSON.stringify(entry)}:${workspace?.conversationId ?? ""}`;
  useEffect(() => { setFocus(studioEntry(entry)); setPinned(false); setFullCardId(null); }, [key]);
  useEffect(() => {
    if (!pinned && latest) { setFocus(latestFocus); setFullCardId(null); }
  }, [latest?.actionId, run?.run.id, pinned, key]);
  // The decision is the newest thing a wrap-up leaves, and the canvas follows the newest thing
  // unless pinned (§2.5). Declared after the two above so that, on arrival, it is the one that holds.
  useEffect(() => {
    if (!pinned && hasProposal) { setFocus(current => ({ ...current, view: "proposal" })); setFullCardId(null); }
  }, [hasProposal, key]);
  useLayoutEffect(() => {
    const target = active ? thread.current : inline.current;
    if (target && chatHost) target.appendChild(chatHost);
  }, [active, chatHost]);
  useLayoutEffect(() => {
    // A closed Studio draws no canvas, so its slots are gone. A host with nowhere to show waits in
    // the hidden lot, still mounted so its unsaved controls survive, rather than being left wherever
    // it last was. The understanding gives way to a staged proposal at rest (turn 91).
    const place = (portal: HTMLDivElement | null, target: HTMLDivElement | null | undefined) => {
      const into = target ?? parked.current;
      if (portal && into && portal.parentNode !== into) into.appendChild(portal);
    };
    place(understandingHost, active ? understandingSlot.current : hasProposal ? null : sideInline);
    place(proposalHost, active ? proposalSlot.current : sideInline);
  }, [active, sideInline, understandingHost, proposalHost, hasProposal]);
  const back = () => {
    setPhoneView("thread"); setFullCardId(null);
    if (returnId.current) requestAnimationFrame(() => {
      const element = document.getElementById(`studio-card-${returnId.current}`);
      element?.scrollIntoView?.({ block: "nearest" }); element?.focus();
    });
  };
  const choose = (next: StudioFocus) => { setFocus(next); setFullCardId(null); setPhoneView("canvas"); };
  const show = (action: ConversationActionCard, full: boolean) => {
    if (action.worldId !== world?.meta.worldId || action.productionId !== productionId) return;
    returnId.current = action.actionId; setActive(true); setFocus(actionFocus(action, focus));
    setFullCardId(full ? action.actionId : null); setPhoneView("canvas"); setPinned(full);
  };
  const close = () => { setActive(false); setFullCardId(null); setPhoneView("thread"); };
  const proposalPanel = proposal ?? (proposalDecisions.length ? <section><h2>Staged proposals</h2>{proposalDecisions.map(card =>
    <button key={card.id} type="button" onClick={() => controls.showDecision(card)}>{card.title} · Open review</button>)}</section> : null);
  const controls: StudioControls = { active, canvasHost, fullCardId, toggle: () => active ? close() : setActive(true),
    // The server has no hosts to move, so the side draws what a closed Studio would put there.
    restingSide: client || active ? null : <>{!hasProposal && understanding}{proposalPanel}</>,
    widen: () => { setWide(value => !value); setWidth(560); }, show, back, sideHost: setSideInline,
    showDecision: card => {
      if (card.worldId !== world?.meta.worldId) return;
      const control = card.body.control, target = control.kind === "stage-review" ? control.review : control;
      if ("productionId" in target && target.productionId !== productionId) return;
      setFocus({ ...focus, view: control.kind === "stage-review" || control.kind === "stage-host" ? "stage" : control.kind === "editor-request" ? "cut" : focus.view,
        ...("sceneId" in target ? { sceneId: target.sceneId } : {}), ...("shotId" in target ? { shotId: target.shotId } : {}) });
      returnId.current = card.id; setActive(true); setFullCardId(card.id); setPinned(true); setPhoneView("canvas");
    } };
  useEffect(() => {
    if (!active || !docked) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) close(); };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, [active, docked]);
  useEffect(() => {
    if (fullCardId && typeof document !== "undefined" && !document.getElementById(`studio-card-${fullCardId}`)) setFullCardId(null);
  }, [fullCardId, workspace, world]);
  if (!world) return <>{children}</>;
  const scene = production?.scenes.find(s => s.id === focus.sceneId) ?? production?.scenes.find(s => orderedShots(s).some(shot => shot.id === focus.shotId));
  const shot = scene && orderedShots(scene).find(s => s.id === focus.shotId);
  const resize = (next: number) => setWidth(Math.max(280, Math.min(typeof window === "undefined" ? 700 : window.innerWidth * .6, next)));
  // Closed, the Studio draws nothing. Kept mounted behind `hidden`, every production screen with a
  // dock rendered a second, invisible copy of its own storyboard or Cut beneath the real one: the
  // 200-shot scene paid for it twice, and the copy's clips and menus answered the page's queries.
  const studio = !active ? null : <section className="fy-production-studio" data-docked={docked || undefined} data-phone-view={phoneView}
    aria-label="Production Chat Studio" style={{ "--studio-thread-width": `${width}px` } as CSSProperties}>
    <header className="fy-production-studio__head"><strong>Production conversation · {production?.meta.title ?? "Studio"}</strong>
      <button type="button" onClick={() => setPhoneView(phoneView === "thread" ? "canvas" : "thread")}>{phoneView === "thread" ? "Canvas" : "Conversation"}</button>
      <button type="button" onClick={close}>Close Studio</button></header>
    <div ref={thread} className="fy-production-studio__thread" />
    <div role="separator" aria-label="Transcript width" aria-orientation="vertical" aria-valuenow={Math.round(width)} tabIndex={0} className="fy-production-studio__divider"
      onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); resize(width + (event.key === "ArrowRight" ? 20 : -20)); } }}
      onPointerDown={event => { drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={event => { if (drag.current) resize(drag.current.width + event.clientX - drag.current.x); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
    <div className="fy-production-studio__canvas">
      <div className="fy-production-studio__breadcrumb"><button type="button" onClick={() => choose({ view: "production" })}>{production?.meta.title ?? "Production"}</button>
        {scene && <><span>›</span><button type="button" onClick={() => choose({ view: "scene", sceneId: scene.id })}>{scene.title}</button></>}
        {shot && <><span>›</span><span>Shot {shot.number}</span></>}
        <span>› {fullCardId ? "Full card" : focus.view}</span>
        <button type="button" aria-pressed={pinned} onClick={() => setPinned(value => !value)}>{pinned ? "Unpin canvas" : "Pin canvas"}</button>
      </div>
      <nav aria-label="Canvas views">{["production", "understanding", ...(hasProposal ? ["proposal"] : [])].map(view =>
        <button key={view} type="button" aria-pressed={focus.view === view && !fullCardId} onClick={() => choose({ view: view as StudioFocus["view"] })}>
          {view === "production" ? "Production" : view === "understanding" ? "What it understood" : "Proposal"}</button>)}
        {scene && ["scene", "board", "stage"].map(view => <button key={view} type="button" aria-pressed={focus.view === view && !fullCardId}
          onClick={() => choose({ view: view as StudioFocus["view"], sceneId: scene.id, shotId: shot?.id ?? orderedShots(scene)[0]?.id })}>{view === "scene" ? "Shots" : view[0]!.toUpperCase() + view.slice(1)}</button>)}
        {production && <button type="button" aria-pressed={focus.view === "cut" && !fullCardId} onClick={() => choose({view:"cut"})}>Cut</button>}
      </nav>
      {pinned && latest && latest.actionId !== focus.actionId && <button type="button" onClick={() => { setPinned(false); setFocus(latestFocus); setFullCardId(null); }}>New card · Follow latest</button>}
      <button type="button" className="fy-production-studio__back" onClick={back}>Back to card</button>
      <div className="fy-production-studio__body">
        <div ref={setCanvasHost} hidden={!fullCardId} className="fy-production-studio__full-card" />
        <div ref={understandingSlot} data-studio-view="understanding" hidden={!!fullCardId || focus.view !== "understanding"}>{!understandingHost && understanding}</div>
        <div ref={proposalSlot} data-studio-view="proposal" hidden={!!fullCardId || focus.view !== "proposal"}>{!proposalHost && proposalPanel}</div>
        {!fullCardId && !["understanding", "proposal"].includes(focus.view) && <ProductionStudioCanvas world={world} production={production} focus={focus} actions={actions} onFocus={choose} />}
      </div>
    </div>
  </section>;
  return <ProductionStudioContext.Provider value={controls}><div className="fy-production-studio-owner" data-wide={wide && !active || undefined} data-dock-owner={docked ? "true" : "false"} style={{ "--studio-thread-width": `${width}px` } as CSSProperties}>
    <div ref={inline} className="fy-production-studio-inline" hidden={active}>
      {wide && <div className="fy-production-studio__dock-divider" role="separator" aria-label="Dock width" aria-orientation="vertical" aria-valuenow={Math.round(width)} tabIndex={0}
        onKeyDown={e => { if (["ArrowLeft","ArrowRight"].includes(e.key)) { e.preventDefault(); resize(width + (e.key === "ArrowLeft" ? 20 : -20)); } }}
        onPointerDown={e => { drag.current={x:e.clientX,width}; e.currentTarget.setPointerCapture?.(e.pointerId); }}
        onPointerMove={e => { if(drag.current) resize(drag.current.width - e.clientX + drag.current.x); }} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} />}
    </div>
    <div ref={parked} hidden />
    {chatHost ? createPortal(children, chatHost) : children}
    {understandingHost && createPortal(understanding, understandingHost)}{proposalHost && createPortal(proposalPanel, proposalHost)}
    {docked ? <BodyLayer>{studio}</BodyLayer> : studio}
  </div></ProductionStudioContext.Provider>;
}
