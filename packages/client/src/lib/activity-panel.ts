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

/** A release name often repeats the version it names; the card and the announcement already say the version. */
export function releaseNameOf(update: UpdateState): string | null {
  const name = update.releaseName?.replace(/^v?\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?\s*[—–\-·:]*\s*/, "").trim() ?? "";
  return name.length > 0 ? name : null;
}

/** The waiting update's notes as paragraphs — the plain text the updater carries (SPEC-016 R-19), split as a release card is. */
export function updateParagraphs(update: UpdateState): string[] {
  return (update.releaseNotes ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
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

/**
 * Where a link to Activity goes now (R-20): the panel, over this screen, on the Inbox. Anything
 * else is a place. The receipts, the founding build's notice and the diagnostics remedies all
 * name `/activity`; only an arrival from outside the app should take the retired route.
 */
export function followLink(navigate: (to: string) => void, to: string): void {
  if (to === "/activity" || to.startsWith("/activity?")) openActivityPanel("inbox");
  else navigate(to);
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

/**
 * The panel's state as it is now, for an effect that runs in the same commit as the one that
 * opened it: the retired route's arrival opens the panel from the panel's own effect, and a
 * sibling's effect in that commit was rendered against the closed panel (design turn 152).
 */
export function activityPanelOpen(): boolean {
  return state.open;
}

export function useActivityPanel(): ActivityPanelState {
  return useSyncExternalStore(subscribe, read, read);
}

export function __resetActivityPanelForTest(): void {
  arrival = null;
  update(CLOSED);
}
