import { useLayoutEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./ui.js";
import { ChevronLeft, X } from "./icons.js";

/** Turn 163 uses the character sheet's shape with native focus containment and an inert page. */
export function PageSheet({ open, onClose, title, children, footer, className, onBack, resetKey, keepMounted = false }: {
  open: boolean;
  onClose: () => void;
  title: string;
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
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const opener = document.activeElement;
    dialog.showModal?.();
    dialog.querySelector("h2")?.focus({ preventScroll: true });
    return () => {
      dialog.close?.();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open, mounted]);
  useLayoutEffect(() => {
    if (!open || resetKey === undefined) return;
    const body = ref.current?.querySelector(".fy-page-sheet__body");
    if (body) body.scrollTop = 0;
    ref.current?.querySelector("h2")?.focus({ preventScroll: true });
  }, [open, mounted, resetKey]);
  if (!mounted || (!open && !keepMounted)) return null;
  return createPortal(
    <dialog ref={ref} className={["fy-page-sheet", className].filter(Boolean).join(" ")} aria-labelledby={heading}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}>
      <div className="fy-page-sheet__grab" />
      <header className="fy-page-sheet__head">{onBack && <IconButton label="Back" onClick={onBack}><ChevronLeft size={20} /></IconButton>}<h2 id={heading} tabIndex={-1}>{title}</h2><IconButton label="Close" onClick={onClose}><X size={20} /></IconButton></header>
      <div className="fy-page-sheet__body">{children}</div>
      {footer && <footer className="fy-page-sheet__foot">{footer}</footer>}
    </dialog>, document.body,
  );
}
