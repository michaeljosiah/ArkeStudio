import { useEffect, useSyncExternalStore } from "react";
import type { ThemePreference } from "@arke-studio/contracts";
import { send, useStore } from "./store.js";

export type { ThemePreference } from "@arke-studio/contracts";
export type ResolvedTheme = "light" | "dark";

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

const listeners = new Set<() => void>();
let initialized = false;
let media: MediaQueryList | null = null;
let removeHostListener: (() => void) | null = null;
let current: ThemeState = { preference: "system", resolved: "light" };
let pendingPreference: ThemePreference | null = null;
let pendingNeedsRetry = false;

function isPreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isResolved(value: unknown): value is ResolvedTheme {
  return value === "light" || value === "dark";
}

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  media ??= window.matchMedia("(prefers-color-scheme: dark)");
  return media.matches ? "dark" : "light";
}

function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

function applyRoot(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

function emit(next: ThemeState): void {
  if (next.preference === current.preference && next.resolved === current.resolved) return;
  current = next;
  applyRoot(next.resolved);
  for (const listener of listeners) listener();
}

function onSystemThemeChanged(): void {
  if (current.preference === "system") emit({ ...current, resolved: systemTheme() });
}

function subscribeToSystemTheme(): void {
  media ??=
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
  media?.addEventListener("change", onSystemThemeChanged);
}

function unsubscribeFromSystemTheme(): void {
  media?.removeEventListener("change", onSystemThemeChanged);
}

function adoptPreference(preference: ThemePreference, resolved?: ResolvedTheme): void {
  unsubscribeFromSystemTheme();
  const nextResolved = resolved ?? resolve(preference);
  emit({ preference, resolved: nextResolved });
  if (preference === "system") subscribeToSystemTheme();
}

/** Apply the startup theme synchronously, before the store connects or React mounts. */
export function initializeTheme(): void {
  if (initialized) return;
  initialized = true;
  const startup = window.arke?.theme;
  const preference = isPreference(startup?.preference) ? startup.preference : "system";
  const resolved = isResolved(startup?.resolved) ? startup.resolved : resolve(preference);
  current = { preference, resolved };
  applyRoot(resolved);
  if (preference === "system") subscribeToSystemTheme();
  removeHostListener =
    window.arke?.onThemeChange?.((theme) => {
      if (isPreference(theme.preference) && isResolved(theme.resolved)) {
        adoptPreference(theme.preference, theme.resolved);
      }
    }) ?? null;
  window.arke?.themeReady?.();
}

export function setThemePreference(preference: ThemePreference): void {
  pendingPreference = preference;
  adoptPreference(preference);
  window.arke?.setHostTheme?.(preference);
  pendingNeedsRetry = !send({ kind: "set-appearance-theme", preference });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference(): ThemePreference {
  const store = useStore();
  const authority = store.state?.app.appearance.theme;
  const preference = useSyncExternalStore<ThemePreference>(
    subscribe,
    () => current.preference,
    () => "system",
  );
  useEffect(() => {
    if (!authority) return;
    if (pendingPreference && authority !== pendingPreference) {
      if (pendingNeedsRetry && store.connection === "open") {
        pendingNeedsRetry = !send({ kind: "set-appearance-theme", preference: pendingPreference });
      }
      return;
    }
    pendingPreference = null;
    adoptPreference(authority);
  }, [authority, preference, store.connection]);
  return preference;
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore<ResolvedTheme>(
    subscribe,
    () => current.resolved,
    () => "light",
  );
}

/** Test cleanup for module-global browser subscriptions. */
export function resetThemeForTests(): void {
  unsubscribeFromSystemTheme();
  removeHostListener?.();
  removeHostListener = null;
  initialized = false;
  media = null;
  pendingPreference = null;
  pendingNeedsRetry = false;
  current = { preference: "system", resolved: "light" };
  listeners.clear();
}
