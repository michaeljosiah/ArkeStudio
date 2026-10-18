import type { EpisodeScriptBlock } from "@arke-studio/contracts";
import { saveEpisodeScript, subscribeEpisodeScriptSaveResults } from "./store.js";

/**
 * An episode script's unsaved edits, kept when the score that held them goes away (codex on PR
 * 1870): leaving within the save's pause, or while a save is in flight, or while disconnected,
 * must not drop what was typed. A parked draft is sent as soon as it can be — after the save in
 * flight answers with the base it needs — and a score reopened on the episode takes back a draft
 * that could not be sent.
 */
export interface ParkedDraft {
  worldId: string;
  productionId: string;
  episode: number;
  title: string;
  blocks: EpisodeScriptBlock[];
  baseHash: string | null;
}

/** `carries`: the save `waitingOn` is this draft's own; otherwise it is an earlier copy's. */
type Entry = { draft: ParkedDraft; waitingOn: string | null; carries: boolean };
const parked = new Map<string, Entry>();
const keyOf = (productionId: string, episode: number) => `${productionId}:${episode}`;

function send(k: string, draft: ParkedDraft): void {
  const requestId = saveEpisodeScript(draft.worldId, draft.productionId, draft.episode, draft.title, draft.blocks, draft.baseHash);
  parked.set(k, { draft, waitingOn: requestId, carries: requestId !== null });
}

subscribeEpisodeScriptSaveResults((result) => {
  for (const [k, entry] of parked) {
    if (entry.waitingOn === null || entry.waitingOn !== result.requestId) continue;
    if (result.disposition !== "saved" || !result.hash) parked.set(k, { ...entry, waitingOn: null, carries: false });
    else if (entry.carries) parked.delete(k);
    else send(k, { ...entry.draft, baseHash: result.hash });
  }
});

/**
 * Park an unmounting score's draft. `inFlight` is the save already sent, if any: the draft then
 * waits for its answer and goes on the base it returns; otherwise it is sent now.
 */
export function parkDraft(draft: ParkedDraft, inFlight: string | null): void {
  const k = keyOf(draft.productionId, draft.episode);
  if (inFlight !== null) parked.set(k, { draft, waitingOn: inFlight, carries: false });
  else send(k, draft);
}

/** A draft that could not be sent for this episode, taken back by the score that opens it. */
export function takeParked(productionId: string, episode: number): ParkedDraft | null {
  const k = keyOf(productionId, episode);
  const entry = parked.get(k);
  if (!entry || entry.waitingOn !== null) return null;
  parked.delete(k);
  return entry.draft;
}
