import { useSyncExternalStore } from "react";
import { closeActivityPanel } from "./activity-panel.js";

let open = false;
const listeners = new Set<() => void>();
function set(value: boolean) { if (open === value) return; open = value; for (const listener of listeners) listener(); }
export function openSystemPanel(): void { closeActivityPanel(); set(true); }
export function closeSystemPanel(): void { set(false); }
export function useSystemPanel(): boolean {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => open, () => false);
}
