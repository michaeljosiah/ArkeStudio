// The React side of the store: subscribing to it and reading it in a component (issue 2800).
import type { StoreState, ConnectionStatus } from "./state.js";
import { current, listeners } from "./core.js";
import { useSyncExternalStore, useRef } from "react";
import type { ClientState } from "@arke-studio/contracts";

export const getSnapshot = (): StoreState => current;
export const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useStore(): StoreState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Select a stable slice; inline selectors and custom equality are both supported. */
export function useStoreSelector<T>(selector: (state: StoreState) => T, equals: (left: T, right: T) => boolean = Object.is): T {
  const cache = useRef<{ state: StoreState; selector: typeof selector; equals: typeof equals; value: T } | null>(null);
  const selected = () => {
    const held = cache.current;
    if (held?.state === current && held.selector === selector && held.equals === equals) return held.value;
    const value = selector(current);
    cache.current = { state: current, selector, equals, value: held && equals(held.value, value) ? held.value : value };
    return cache.current.value;
  };
  return useSyncExternalStore(subscribe, selected, selected);
}

export function shallowEqual<T extends object>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true;
  const keys = Object.keys(left) as (keyof T)[];
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && Object.is(left[key], right[key]));
}

export function useClientState(): ClientState | null {
  return useStoreSelector(store => store.state);
}

export function useWorld(): ClientState["world"] {
  return useStoreSelector(store => store.state?.world ?? null);
}

/**
 * The connection alone. Shared hooks that read it through `useStore()` subscribed the shell and
 * both layouts to every store change, so one unrelated event re-rendered most of the screen
 * (issue 2783).
 */
export function useConnection(): ConnectionStatus {
  return useStoreSelector(store => store.connection);
}
