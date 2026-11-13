import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Which sheets are open, in the order they opened, so a modal `<dialog>` can give way to a sheet
 * opened after it.
 *
 * A `PageSheet` is a modal dialog: the browser draws it in the top layer, above every z-index, and
 * makes the rest of the page inert. Only the newest modal or layer stays active; older panels
 * remain mounted without owning input. A sheet drawn on the body (`EditorDialog`) or over the main
 * area (Illustrate's sheet) opened while one is showing was drawn under it and could not be
 * pressed — the block drawer of a 1,700-wide window covered the Looks and the Illustrate sheet
 * (2026-10-04, 0.5.60-local.14). Whichever opened last is the one in front, so a dialog closes
 * while a later sheet is open and shows again, as it was, when that sheet goes.
 */

type Kind = "layer" | "modal";

let next = 0;
const open = new Map<number, { kind: Kind; element: () => HTMLElement | null }>();
const listeners = new Set<() => void>();
/** The newest overlay still open, including native dialogs, or 0. */
let newestOverlay = 0;

function changed(): void {
  newestOverlay = Math.max(0, ...open.keys());
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Holds a place in the order while `isOpen`; returns that place, or null while closed. `element`
 * is the sheet's panel: a dialog that gives way hands focus to it, since the sheet's own attempt
 * to take focus was made while the dialog still held the page inert.
 */
export function useOverlay(kind: Kind, isOpen: boolean, element?: () => HTMLElement | null): number | null {
  const [id, setId] = useState<number | null>(null);
  const read = useRef(element);
  read.current = element;
  useLayoutEffect(() => {
    if (!isOpen) return;
    next += 1;
    const mine = next;
    open.set(mine, { kind, element: () => read.current?.() ?? null });
    setId(mine);
    changed();
    return () => {
      open.delete(mine);
      setId(null);
      changed();
    };
  }, [kind, isOpen]);
  return id;
}

/** Whether another sheet opened later: only the newest overlay owns focus and active controls. */
export function useCoveredAfter(id: number | null): boolean {
  const newest = useSyncExternalStore(subscribe, () => newestOverlay, () => 0);
  return id !== null && newest > id;
}

/**
 * How many sheets have opened so far, of either kind. A menu drawn on the body (the model chip's)
 * stands above the page it was opened from and the sheets already open, but a sheet opened after
 * it belongs in front: the menu notes this count when it opens and closes once it grows. It does
 * not hold a place itself, which would put away a block drawer the chip sits inside.
 */
export function useOverlaysOpened(): number {
  return useSyncExternalStore(subscribe, () => next, () => 0);
}

/** Focus the newest open sheet's first control, or the sheet itself. */
export function focusNewestLayer(): void {
  const panel = open.get(newestOverlay)?.element() ?? null;
  if (panel === null) return;
  const first = panel.querySelector<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])");
  (first ?? panel).focus({ preventScroll: true });
}
