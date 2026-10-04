import { useLayoutEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./ui.js";
import { ChevronLeft, X } from "./icons.js";
import { focusNewestLayer, useCoveredAfter, useOverlay } from "../lib/overlays.js";

/** Turn 163 uses the character sheet's shape with native focus containment and an inert page. */
export function PageSheet({ open, onClose, title, children, footer, className, onBack, resetKey, keepMounted = false, headless = false }: {
  open: boolean;
  onClose: () => void;
  /** The sheet's heading, or with `headless` only its accessible name. */
  title: string;
  /**
   * No head of the sheet's own: what it holds draws its title and its close. The block's panel
   * raised as a sheet has its own head, and a second over it named the block twice with two
   * closes (194h draws one).
   */
  headless?: boolean;
  onBack?: () => void;
  /** A new in-sheet page starts at its heading without remounting the dialog or its opener. */
  resetKey?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Keep ongoing requests and viewport attachments alive while their sheet is put away. */
  keepMounted?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => { setMounted(true); }, []);
  // A sheet opened after this one, drawn on the body, stands in front: the dialog is put away while
  // it is open, its contents kept as they are, and shown again when it goes (see overlays.ts).
  const place = useOverlay("modal", open);
  const covered = useCoveredAfter(place);
  const coveredNow = useRef(covered);
  coveredNow.current = covered && open;
  const showing = open && !covered;
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !showing) return;
    const opener = document.activeElement;
    dialog.showModal?.();
    dialog.querySelector("h2")?.focus({ preventScroll: true });
    return () => {
      dialog.close?.();
      // Put away for a sheet in front, the focus goes to that sheet, not back to the page under both.
      if (coveredNow.current) focusNewestLayer();
      else if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [showing, mounted]);
  useLayoutEffect(() => {
    if (!open || resetKey === undefined) return;
    const body = ref.current?.querySelector(".fy-page-sheet__body");
    if (body) body.scrollTop = 0;
    ref.current?.querySelector("h2")?.focus({ preventScroll: true });
  }, [open, mounted, resetKey]);
  if (!mounted || (!open && !keepMounted)) return null;
  return createPortal(
    <dialog ref={ref} className={["fy-page-sheet", className].filter(Boolean).join(" ")} {...(headless ? { "aria-label": title } : { "aria-labelledby": heading })}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}>
      <div className="fy-page-sheet__grab" />
      {!headless && <header className="fy-page-sheet__head">{onBack && <IconButton label="Back" onClick={onBack}><ChevronLeft size={20} /></IconButton>}<h2 id={heading} tabIndex={-1}>{title}</h2><IconButton label="Close" onClick={onClose}><X size={20} /></IconButton></header>}
      <div className="fy-page-sheet__body">{children}</div>
      {footer && <footer className="fy-page-sheet__foot">{footer}</footer>}
    </dialog>, document.body,
  );
}
