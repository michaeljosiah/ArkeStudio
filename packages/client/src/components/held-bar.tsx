import { useConversationPresentation } from "./global-chat-context.js";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "../lib/media-query.js";
import { useKeyboardInset } from "../lib/keyboard-inset.js";

/** Keep the last line above the actual bar, including feedback, wrapping and the safe area. */
export function HeldBar({ children, className = "", query = "(max-width: 599px)" }: {
  children: ReactNode;
  className?: string;
  query?: string;
}) {
  const matches = useMediaQuery(query);
  const presentation = useConversationPresentation();
  const held = matches && (!presentation || !presentation.inPanel && presentation.hasHome);
  const keyboard = useKeyboardInset();
  const anchor = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = bar.current;
    if (!held || !node) return;
    let page: HTMLElement | null = null;
    const measure = () => {
      // The conversation portal attaches after child layout effects. Find its page when the
      // observer measures, or the fallback padding leaves retry controls behind the composer.
      const next = anchor.current?.closest<HTMLElement>("[data-screen]") ?? null;
      if (page !== next) page?.style.removeProperty("--held-bar-height");
      page = next;
      page?.style.setProperty("--held-bar-height", `${node.getBoundingClientRect().height + keyboard}px`);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => { observer?.disconnect(); page?.style.removeProperty("--held-bar-height"); };
  }, [held, keyboard]);
  const content = <div ref={bar} style={held ? { bottom: keyboard } : undefined} className={`${held ? "fy-held-bar " : ""}${className}`}>{children}</div>;
  // Animated page panels establish containing blocks; the viewport bar belongs outside them.
  return <div ref={anchor} className="fy-held-anchor">{held ? createPortal(content, document.body) : content}</div>;
}
