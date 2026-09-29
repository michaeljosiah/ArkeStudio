import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a CSS media query holds right now, re-read as the window crosses it.
 *
 * A one-shot `matchMedia` read at render time is right for a handler — the screen's Escape and
 * focus rules read it that way — but wrong for anything rendering depends on: the answer would
 * stand until something else happened to re-render, and a panel that stopped drawing below a
 * breakpoint would stay blank after the window widened past it again. The subscription is what
 * makes the crossing itself a render.
 *
 * Server rendering has no window and reports false. A test's stub may offer `matches` alone, so
 * the change listener is attached only where it exists; the answer is still read every render.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(query);
      if (typeof media.addEventListener !== "function") return () => {};
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  const read = useCallback(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches === true,
    [query],
  );
  return useSyncExternalStore(subscribe, read, () => false);
}
