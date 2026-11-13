import { useEffect, useSyncExternalStore } from "react";

/**
 * Arke on a Fold7 takes the hinge half (design turn 202). From 840 to 1099 an open dock is the
 * right half of the screen beside the page, not a 340 drawer over a dimmed one: both halves stay
 * live, so the dock is shown without a modal and the page makes room for it. Below 840 the drawer
 * stays as turn 168 draws it; from 1100 the dock is the page's column.
 *
 * The dock that is open says so here, and the production's frame reads it: the rail folds to its
 * marks and the page keeps the left half. `data-arke-half` on the root carries the same fact to the
 * stylesheets, which give the page its right padding.
 */
export const ARKE_HALF_QUERY = "(min-width: 840px) and (max-width: 1099px)";

let held = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => held > 0;

function change(by: number): void {
  held = Math.max(0, held + by);
  if (typeof document !== "undefined") {
    if (held > 0) document.documentElement.dataset.arkeHalf = "open";
    else delete document.documentElement.dataset.arkeHalf;
  }
  for (const listener of listeners) listener();
}

/** Held while this dock is open as the half; let go when it closes, narrows or unmounts. */
export function useHoldArkeHalf(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    change(1);
    return () => change(-1);
  }, [open]);
}

/** Whether an Arke dock is open as the hinge half right now. */
export function useArkeHalfOpen(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
