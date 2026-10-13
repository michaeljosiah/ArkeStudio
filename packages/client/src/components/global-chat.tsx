import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { chatKey, chatSubjectKey, chatTitle, chatSurfaceForPage, conversationProps, createGlobalChatController, type GlobalChatController, type ChatSurface } from "../lib/global-chat.js";
import { isSettingsPath, settingsReturnPath } from "../lib/settings-return.js";
import { useDictation, useStore } from "../lib/store.js";
import { useMediaQuery } from "../lib/media-query.js";
import { useKeyboardInset } from "../lib/keyboard-inset.js";
import { ProductionConversationBody, type ProductionConversationProps } from "./conversation.js";
import { RowMenuPanel, WorldChatView } from "../screens/world-chat.js";
import { ProductionSetupView } from "../screens/production-setup.js";
import { useClientRender } from "./production-studio-context.js";
import { ConversationPresentationContext, GlobalChatContext, useGlobalChat } from "./global-chat-context.js";
import { PageSheet } from "./page-sheet.js";
import { More, X } from "./icons.js";
import { ProductionStudioCanvas } from "./production-studio-canvas.js";
import { RouteErrorBoundary } from "./route-error-boundary.js";
import { setWorldChatInitiative } from "../lib/store.js";

function afterPaint(action: () => void): () => void {
  if (typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function") {
    const id = requestAnimationFrame(action); return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(action, 0); return () => clearTimeout(id);
}

/** A page supplies exact context/selection, but never owns a second conversation. */
export function GlobalConversationEntry({ props, world }: { props: ProductionConversationProps; world: { worldId: string; name: string } }) {
  const owner = useGlobalChat()!, host = useRef<HTMLDivElement>(null), location = useLocation();
  const { state } = useStore();
  const entry = props.entry ?? { kind: "production" as const, productionId: props.productionId ?? "" };
  const key = chatKey(world.worldId, entry);
  const surface: ChatSurface = { key, worldId: world.worldId, worldName: world.name, entry,
    title: chatTitle(entry),
    label: chatSurfaceForPage(state, location.pathname + location.search)?.label ?? world.name, kind: "production", props,
    path: location.pathname + location.search };
  const latest = useRef(surface); latest.current = surface;
  useLayoutEffect(() => host.current ? owner.register(latest.current, host.current) : undefined, [owner, key]);
  useLayoutEffect(() => { if (host.current) owner.refresh(latest.current, host.current); });
  useLayoutEffect(() => { if (props.openWith || props.dock?.ask && !props.dock.ask.sent) owner.open(latest.current); }, [owner, props.openWith, props.dock?.ask?.press]);
  return <div className="fy-global-chat-slot"><ChatExpand owner={owner} surface={surface} /><ChatPageCanvas owner={owner} surface={surface} props={props} /><div ref={host} /></div>;
}

function ChatExpand({ owner, surface }: { owner: GlobalChatController; surface: ChatSurface }) {
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  return snapshot.open && snapshot.selected?.key === surface.key ? null : <button type="button" className="fy-global-chat-expand" onClick={() => owner.open(surface)}>Open {surface.title}</button>;
}

function ChatPageCanvas({ owner, surface, props }: { owner: GlobalChatController; surface: ChatSurface; props: ProductionConversationProps }) {
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot), { state } = useStore(), navigate = useNavigate();
  if (snapshot.selected?.key === surface.key || props.dock || !state?.world) return null;
  const production = state.world.productions.find(p => p.meta.id === props.productionId);
  return <div className="fy-global-chat-page-canvas"><ProductionStudioCanvas world={state.world} production={production} focus={{ view: "production" }} actions={[]}
    onFocus={focus => { if (production && focus.sceneId) navigate(`/w/${surface.worldId}/p/${production.meta.id}/scenes/${focus.sceneId}`); }} /></div>;
}

export function GlobalWorldChatEntry({ worldId, conversationId }: { worldId: string; conversationId?: string }) {
  const owner = useGlobalChat()!, { state } = useStore(), location = useLocation(), host = useRef<HTMLDivElement>(null);
  const surface = chatSurfaceForPage(state, location.pathname + location.search);
  const latest = useRef(surface); latest.current = surface;
  useLayoutEffect(() => host.current && latest.current ? owner.register(latest.current, host.current) : undefined, [owner, worldId, conversationId]);
  useLayoutEffect(() => { if (host.current && latest.current) owner.refresh(latest.current, host.current); });
  return <div className="fy-global-chat-slot">{surface && <ChatExpand owner={owner} surface={surface} />}<div ref={host} /></div>;
}

export function GlobalChatProvider({ children }: { children: ReactNode }) {
  const client = useClientRender();
  const [owner] = useState(createGlobalChatController);
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const { state } = useStore(), location = useLocation(), navigate = useNavigate(), dictation = useDictation();
  const phone = useMediaQuery("(max-width: 599px)"), keyboard = useKeyboardInset();
  const [width, setWidth] = useState(400), [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null), [history, setHistory] = useState(false);
  const [rowMenu, setRowMenu] = useState<ComponentProps<typeof RowMenuPanel>["menu"] | null>(null);
  const parked = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; width: number } | null>(null);
  const [bodyHost] = useState(() => { const host = client ? document.createElement("div") : null; if (host) host.className = "fy-global-chat-owner-body"; return host; });
  const path = isSettingsPath(location.pathname) ? settingsReturnPath() : location.pathname + location.search;
  owner.setCurrent(chatSurfaceForPage(state, path)); const current = owner.forPage();
  const selected = snapshot.selected;
  const world = state?.world;
  useLayoutEffect(() => { if (world) owner.reconcileConversations(world.meta.worldId, new Set(world.conversations.map(row => row.id)), state?.worldChat?.conversationId); }, [owner, world?.meta.worldId, world?.conversations, state?.worldChat?.conversationId]);
  const sameWorld = !!selected && selected.worldId === world?.meta.worldId && current?.worldId === selected.worldId;
  const home = sameWorld ? owner.host() : null;
  const inPanel = snapshot.open && sameWorld;
  const resize = (next: number) => setWidth(Math.min(560, Math.max(360, window.innerWidth - 630), Math.max(360, next)));
  useLayoutEffect(() => {
    if (!client) return;
    document.body.dataset.globalChatEnabled = "true";
    return () => { delete document.body.dataset.globalChatEnabled; };
  }, [client]);
  useEffect(() => { for (const [id, result] of Object.entries(dictation)) owner.deliverDictation(id, result); }, [owner, dictation]);
  useLayoutEffect(() => {
    if (!bodyHost) return;
    const into = selected?.kind === "world" && inPanel ? panelHost : home ?? parked.current;
    if (into && bodyHost.parentNode !== into) into.append(bodyHost);
    return () => { bodyHost.remove(); };
  }, [bodyHost, selected?.kind, inPanel, home, panelHost]);
  useEffect(() => {
    const dialog = panelHost?.closest("dialog");
    if (!dialog || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (!dialog.open && owner.getSnapshot().open) owner.stopDictation();
    });
    observer.observe(dialog, { attributes: true, attributeFilter: ["open"] });
    return () => observer.disconnect();
  }, [owner, panelHost]);
  useLayoutEffect(() => {
    if (!client) return;
    document.body.dataset.globalChatOpen = String(snapshot.open);
    document.documentElement.style.setProperty("--global-chat-width", `${width}px`);
    document.documentElement.style.setProperty("--chat-keyboard", `${keyboard}px`);
    return () => { delete document.body.dataset.globalChatOpen; document.documentElement.style.removeProperty("--global-chat-width"); document.documentElement.style.removeProperty("--chat-keyboard"); };
  }, [client, snapshot.open, width, keyboard]);
  useEffect(() => {
    if (!inPanel || !panelHost) return;
    return afterPaint(() => panelHost.querySelector<HTMLElement>('[contenteditable="true"],textarea')?.focus({ preventScroll: true }));
  }, [inPanel, panelHost, selected?.key]);
  useEffect(() => {
    if (!phone || !snapshot.open) return;
    const workspace = [...document.querySelectorAll<HTMLElement>("#root [data-screen]")];
    const original = workspace.map(element => [element, element.inert] as const);
    workspace.forEach(element => { element.inert = true; });
    const trap = (event: KeyboardEvent) => {
      const dialog = panelHost?.closest("dialog");
      if (event.key !== "Tab" || event.defaultPrevented || !dialog?.open || document.activeElement?.closest(".fy-msheet")) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[contenteditable="true"],[tabindex]:not([tabindex="-1"])')].filter(element => element.getBoundingClientRect().width > 0);
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      if (!dialog.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => { original.forEach(([element, inert]) => { element.inert = inert; }); document.removeEventListener("keydown", trap); };
  }, [phone, snapshot.open, panelHost, path]);
  const close = () => { owner.close(); setHistory(false); afterPaint(() => { if (typeof document !== "undefined") document.querySelector<HTMLElement>('[data-global-chat-trigger]')?.focus(); }); };
  useEffect(() => {
    if (!inPanel || !panelHost) return;
    const escape = (event: KeyboardEvent) => {
      const dialog = panelHost.closest("dialog");
      // Native modal sheets cover this view; anchored pickers consume Escape first.
      if (event.key !== "Escape" || event.defaultPrevented || !dialog?.open || !(event.target instanceof Node) || !dialog.contains(event.target)) return;
      event.preventDefault();
      if (history) setHistory(false); else close();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [owner, inPanel, panelHost, history]);
  const adopt = () => { const page = owner.forPage(); if (page) owner.open(page); setHistory(false); };
  const choose = (conversationId: string) => {
    const row = world?.conversations.find(c => c.id === conversationId); if (!world || !row) return;
    const entry = row.entryContext ?? { kind: "world" as const };
    const surface: ChatSurface = { key: chatKey(world.meta.worldId, entry, row.id), worldId: world.meta.worldId, worldName: world.meta.name,
      kind: entry.kind === "world" ? "world" : entry.kind === "production-setup" ? "setup" : "production", title: chatTitle(entry),
      label: `${world.meta.name} / ${row.title}`, entry, conversationId: row.id, path,
      ...(entry.kind !== "world" ? { props: conversationProps(world.meta.worldId, entry) } : {}) };
    owner.open(surface); setHistory(false);
  };
  const page = owner.forPage() ?? current;
  const mismatch = !!selected && !!page && (chatSubjectKey(selected) !== chatSubjectKey(page) ||
    !!page.conversationId && page.conversationId !== selected.conversationId);
  const presentation = selected ? { owner, key: selected.key, stopCapture: snapshot.stopCapture, inPanel,
    panelHost: inPanel ? panelHost : null, hasHome: !!home, scopeMissing: selected.scopeMissing, conversationId: selected.conversationId, newThread: selected.newThread } : null;
  const menuConversation = rowMenu ? world?.conversations.find(row => row.id === rowMenu.id) : undefined;
  return <GlobalChatContext.Provider value={owner}>
    {children}
    <div hidden ref={parked} />
    <PageSheet open={snapshot.open} onClose={close} title={selected?.title ?? "Chat"} headless modeless keepMounted className="fy-global-chat"
      preserveReturnFocus>
      <div className="fy-global-chat-panel" style={{ "--chat-width": `${width}px` } as CSSProperties}>
        <header><div><h2>{selected?.title ?? "Chat"}</h2><p>{selected?.label ?? "Open a world to begin"}</p></div>
          {sameWorld && <button type="button" aria-label="Conversations" aria-expanded={history} onClick={() => setHistory(value => !value)}><More size={16} /></button>}
          <button type="button" aria-label="Close Chat" onClick={close}><X size={16} /></button>
        </header>
        {history && <nav className="fy-global-chat-history" aria-label="Conversations">
          {selected && selected.kind !== "setup" && <button type="button" onClick={() => { owner.startNew(selected); setHistory(false); }}>New conversation</button>}
          {world?.conversations.map(row => <div key={row.id} className="fy-global-chat-history-row"><button type="button" onClick={() => choose(row.id)}>{row.title}{row.status === "archived" ? " · archived" : ""}</button>
            <button type="button" aria-label={`Options for ${row.title}`} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setRowMenu({ id: row.id, x: box.left, y: box.bottom, confirming: false }); }}><More size={16} /></button></div>)}
          <button type="button" onClick={() => { if (world) { owner.open({ key: chatKey(world.meta.worldId, { kind: "world" }), kind: "world", worldId: world.meta.worldId, worldName: world.meta.name, title: "World Chat", label: world.meta.name, entry: { kind: "world" }, path }); setHistory(false); } }}>World Chat</button>
          {selected?.kind === "world" && selected.conversationId && state?.worldChat?.conversationId === selected.conversationId && <label>Initiative<select value={state.worldChat.initiative} onChange={event => setWorldChatInitiative(selected.worldId, selected.conversationId!, event.target.value as "assist" | "collaborate" | "develop")}>
            <option value="assist">Assist</option><option value="collaborate">Collaborate</option><option value="develop">Develop</option></select></label>}
        </nav>}
        {!sameWorld && <div className="fy-global-chat-boundary" role="status"><p>{selected ? "This conversation belongs to another world. Its draft is retained there." : "Open a world to begin chatting with Arke."}</p>
          <button type="button" onClick={() => current ? adopt() : navigate("/worlds")}>{current ? "Open this world’s chat" : "Open world"}</button></div>}
        {sameWorld && mismatch && <div className="fy-global-chat-boundary"><p>You’re viewing {current?.label}. This conversation stays about {selected?.label}.</p><button type="button" onClick={adopt}>Use this page</button></div>}
        {sameWorld && selected.scopeMissing && <div className="fy-global-chat-boundary" role="status"><p>This saved draft’s subject could not be restored. Choose this page before sending; your words are retained.</p><button type="button" onClick={adopt}>Use this page</button></div>}
        {snapshot.switching && <p className="fy-global-chat-boundary" role="status">{owner.opening() ? "Waiting for the opening message before switching conversations…" : "Finishing dictation before switching conversations…"}</p>}
        <div ref={setPanelHost} className="fy-global-chat-conversation" />
        <div role="separator" aria-label="Chat width" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={560} aria-valuenow={width} tabIndex={0} className="fy-global-chat-resize"
          onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); resize(width + (event.key === "ArrowLeft" ? 20 : -20)); } }}
          onPointerDown={event => { drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
          onPointerMove={event => { if (drag.current) resize(drag.current.width + drag.current.x - event.clientX); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
      </div>
    </PageSheet>
    {rowMenu && menuConversation && world && <RowMenuPanel layer={71} worldId={world.meta.worldId} row={menuConversation} menu={rowMenu} onOpenMenu={setRowMenu} onCloseMenu={() => setRowMenu(null)} />}
    {client && bodyHost && selected && sameWorld && presentation && createPortal(<ConversationPresentationContext.Provider value={presentation}>
      <RouteErrorBoundary key={selected.key}>
      {selected.kind === "world" ? <WorldChatView key={selected.key} embedded={{ worldId: selected.worldId, conversationId: selected.conversationId,
        onConversationChange: id => owner.reportConversation(selected.key, id) }} /> : selected.kind === "setup" && selected.entry.kind === "production-setup"
        ? <ProductionSetupView key={selected.key} embedded={{ worldId: selected.worldId, setupId: selected.entry.setupId }} />
        : <ProductionConversationBody key={selected.key} {...(selected.props ?? conversationProps(selected.worldId, selected.entry))} />}
      </RouteErrorBoundary>
    </ConversationPresentationContext.Provider>, bodyHost)}
  </GlobalChatContext.Provider>;
}
