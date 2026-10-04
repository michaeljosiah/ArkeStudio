import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** What a tip keeps clear of the window's edges, as the chip's menus do (design turn 195: 12). */
const EDGE = 12;

/**
 * A tip for a control in the composer's tool row, drawn on the body above the control on hover and
 * keyboard focus. `.fy-tip`'s pseudo-element cannot be used there: `.fy-cx` clips its overflow, so a
 * tip hung off the control is cut by the composer's own box, and every column enters with
 * `fy-fade-up`, whose transform makes a fixed tip inside it fixed to that column (model-chip.tsx has
 * the same reason for its menus). Inside a block drawer it is drawn on the dialog, since the body
 * outside a modal dialog is under it. It starts at the control's left edge and stays inside the
 * window: the production dock stands at the window's right edge.
 */
export function BodyTip({ anchor, className, children }: { anchor: HTMLElement; className?: string; children: ReactNode }) {
  const tip = useRef<HTMLSpanElement>(null);
  const box = anchor.getBoundingClientRect();
  const doc = anchor.ownerDocument;
  const viewHeight = doc.defaultView?.innerHeight || doc.documentElement.clientHeight || 0;
  useLayoutEffect(() => {
    const node = tip.current;
    if (node === null) return;
    const viewWidth = doc.defaultView?.innerWidth || doc.documentElement.clientWidth || 0;
    const width = node.getBoundingClientRect().width;
    node.style.left = `${Math.max(EDGE, Math.min(anchor.getBoundingClientRect().left, viewWidth - width - EDGE))}px`;
  });
  return createPortal(
    <span ref={tip} role="tooltip" className={className === undefined ? "fy-bodytip" : `fy-bodytip ${className}`} style={{ left: `${box.left}px`, bottom: `${viewHeight - box.top + 6}px` }}>
      {children}
    </span>,
    anchor.closest("dialog") ?? doc.body,
  );
}

/** Whether a focus is one the person can see, as `:focus-visible` decides it; a DOM that cannot say counts it as seen. */
export function focusIsVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}
