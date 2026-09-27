import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "../lib/media-query.js";

/** Keep the last line above the actual bar, including feedback, wrapping and the safe area. */
export function HeldBar({ children, className = "", query = "(max-width: 599px)" }: {
  children: ReactNode;
  className?: string;
  query?: string;
}) {
  const held = useMediaQuery(query);
  const anchor = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const page = anchor.current?.closest<HTMLElement>("[data-screen]");
    const node = bar.current;
    if (!held || !page || !node) return;
    const measure = () => page.style.setProperty("--held-bar-height", `${node.getBoundingClientRect().height}px`);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => { observer?.disconnect(); page.style.removeProperty("--held-bar-height"); };
  }, [held]);
  const content = <div ref={bar} className={`${held ? "fy-held-bar " : ""}${className}`}>{children}</div>;
  // Animated page panels establish containing blocks; the viewport bar belongs outside them.
  return <div ref={anchor} className="fy-held-anchor">{held ? createPortal(content, document.body) : content}</div>;
}
