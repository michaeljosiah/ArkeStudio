import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useClientRender } from "./production-studio-context.js";
import { useLocation } from "react-router";
import type { GlobalChatController } from "../lib/global-chat.js";
export const GlobalChatContext = createContext<GlobalChatController | null>(null);
export const useGlobalChat = () => useContext(GlobalChatContext);
export const ConversationPresentationContext = createContext<{ owner: GlobalChatController; key: string; stopCapture: number; inPanel: boolean; panelHost: HTMLElement | null; hasHome: boolean; scopeMissing?: boolean; conversationId?: string; newThread?: boolean } | null>(null);
export const useConversationPresentation = () => useContext(ConversationPresentationContext);
/** Async media preparation may finish on a parked view. Its result cannot take over a new page. */
export function useConversationNavigationGuard() {
  const location = useLocation(), presentation = useConversationPresentation();
  const path = location.pathname + location.search;
  const current = useRef({ path, visible: true });
  current.current = { path, visible: !presentation || presentation.inPanel || presentation.hasHome };
  const allows = useCallback((origin: string) => current.current.path === origin && current.current.visible, []);
  return { path, allows };
}
/** Values belong to their selected subject, including an async dictation finishing after world navigation. */
export function useConversationState<T>(name: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const presentation = useConversationPresentation();
  const [local, setLocal] = useState(initial);
  const set = useCallback((next: SetStateAction<T>) => {
    if (!presentation) { setLocal(next); return; }
    const current = presentation.owner.value(presentation.key, name, initial);
    presentation.owner.setValue(presentation.key, name, typeof next === "function" ? (next as (previous: T) => T)(current) : next);
  }, [presentation?.owner, presentation?.key, name]);
  return [presentation ? presentation.owner.value(presentation.key, name, initial) : local, set];
}

/** Setup uses a different coordinator protocol, while sharing the same presentation owner. */
export function ConversationPanelContent({ children }: { children: ReactNode }) {
  const presentation = useConversationPresentation(), client = useClientRender(), home = useRef<HTMLDivElement>(null);
  const [host] = useState(() => client ? document.createElement("div") : null);
  useLayoutEffect(() => {
    const target = presentation?.panelHost ?? home.current;
    if (target && host) target.append(host);
    return () => host?.remove();
  }, [host, presentation?.panelHost]);
  return <><div ref={home} className="fy-conversation-panel-home" />{host ? createPortal(children, host) : children}</>;
}
