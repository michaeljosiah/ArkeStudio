import { useSyncExternalStore } from "react";
import type { UpdateState } from "@arke-studio/contracts";

/**
 * The Activity panel's own state (design turn 136): whether it is open, which tab, and whether a
 * job's provider calls have taken the body's place. Module state rather than context, because
 * the things that open it do not share an ancestor — the bell in the chrome, a receipt's action,
 * the desktop's notification click arriving over IPC, and the retired route.
 */
export type ActivityTab = "new" | "inbox" | "spend";

export interface ActivityPanelState {
  open: boolean;
  tab: ActivityTab;
  /** `undefined` is the tab's own body; `null` is every recent provider call; an id is one job's. */
  calls: string | null | undefined;
}

/** An update the panel has something to say about: found, moving, or stuck. */
const WAITING_UPDATE = new Set<UpdateState["status"]>([
  "available",
  "downloading",
  "ready",
  "install-on-close",
  "error",
  "install-failed",
]);

/**
 * The update worth a card at the top of What's new — and the same fact lights the bell (R-24):
 * a release a person does not have yet is as unread as one they have not opened.
 */
export function waitingUpdate(update: UpdateState | null | undefined): UpdateState | null {
  return update && update.targetVersion && WAITING_UPDATE.has(update.status) ? update : null;
}

const CLOSED: ActivityPanelState = { open: false, tab: "inbox", calls: undefined };
let state: ActivityPanelState = CLOSED;
const listeners = new Set<() => void>();

function update(next: ActivityPanelState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Opens on the tab the caller chose: Inbox while anything needs you, What's new otherwise (R-21). */
export function openActivityPanel(tab: ActivityTab): void {
  update({ open: true, tab, calls: undefined });
}

/**
 * The retired route's way in (R-20). An external-store update renders synchronously, ahead of
 * the router's own, so a panel opened in the same breath as a redirect mounts over the route it
 * is leaving and closes on arrival. The flag waits instead: the mounted panel reads it once the
 * location has actually changed, and opens over the screen it will stay on.
 */
let arrival: ActivityTab | null = null;

export function openActivityPanelOnArrival(tab: ActivityTab): void {
  arrival = tab;
}

export function takeArrival(): ActivityTab | null {
  const tab = arrival;
  arrival = null;
  return tab;
}

export function showActivityTab(tab: ActivityTab): void {
  update({ ...state, open: true, tab, calls: undefined });
}

export function closeActivityPanel(): void {
  if (state.open) update(CLOSED);
}

/** A row's glyph swaps the body for that job's calls; `null` is the foot of Spend's "all calls". */
export function inspectProviderCalls(jobId: string | null): void {
  update({ ...state, open: true, calls: jobId });
}

export function leaveProviderCalls(): void {
  update({ ...state, calls: undefined });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => state;

export function useActivityPanel(): ActivityPanelState {
  return useSyncExternalStore(subscribe, read, read);
}

export function __resetActivityPanelForTest(): void {
  arrival = null;
  update(CLOSED);
}
