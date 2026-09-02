import { useEffect, useRef, type ReactNode } from "react";

/**
 * A sheet over the editor (SPEC-039 R-5): mounted above the app frame, focus held inside it,
 * closed by Escape or the scrim, and focus handed back to the control that opened it. The
 * keyboard reference and the export sheet both use it; neither invents a second dialog.
 */
export function EditorDialog({
  open,
  title,
  subtitle,
  onClose,
  children,
  width = 430,
  labelledBy,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  labelledBy?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const first = panel.current?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    (first ?? panel.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || panel.current === null) return;
      // The tab ring stays inside the sheet: from the last control forward lands on the first,
      // from the first backward lands on the last.
      const focusable = [...panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (focusable.length === 0) return;
      const head = focusable[0]!;
      const tail = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  const heading = labelledBy ?? "editor-dialog-title";
  return (
    <div className="fy-editordialog" onClick={onClose} role="presentation">
      <div
        ref={panel}
        className="fy-editordialog__panel"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="fy-editordialog__head">
          <span className="fy-editordialog__title" id={heading}>
            {title}
          </span>
          {subtitle !== undefined && <span className="fy-editordialog__sub">{subtitle}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** The shortcut reference (R-17): every key the editor answers, beside the control that does the same. */
export const EDITOR_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["S", "split at the playhead"],
  ["D", "duplicate the selected clip"],
  ["⌫", "delete the selected clip"],
  ["⇧⌫", "ripple delete, closing the gap"],
  ["[ ]", "move the selected clip earlier or later"],
  ["Ctrl Z", "undo · Ctrl Shift Z redoes"],
  ["space", "play or pause"],
  ["← →", "nudge the playhead a second, on the ruler"],
  ["home end", "jump to the start or end, on the ruler"],
  ["+ −", "zoom the timeline"],
  ["esc", "deselect"],
  ["?", "this list"],
];
