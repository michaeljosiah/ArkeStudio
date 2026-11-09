import { ulid } from "@arke-studio/contracts";
import { current, emitChange, send } from "./core.js";
import { useStoreSelector } from "./hooks.js";
import type { StoreState } from "./state.js";

// ---- turn 146: the door ----------------------------------------------------

/*
 * One ask of each door at a time, by world and production. The rail and the door both want
 * the answer, and every ask prepares the whole book. They used to ask by turns, each on its
 * own stamp, and only the latest ask's answer was kept (codex on PR 1187) — so on a long book
 * whose catalogue refreshed every few seconds nearly every answer arrived superseded, was
 * thrown away, and the door sat on "Opening…" (UI audit A1, 0.5.60). Now an ask for what is
 * already being asked is the same ask; an ask for something newer while one is out waits for
 * it and goes once, however many came in between; and an answer is kept whenever it is newer
 * than the one on screen, so the door shows the last one it has rather than nothing.
 */
const doorAsked = new Map<string, { key: string; seq: number; stamp: string }>();
const doorInFlight = new Map<string, { requestId: string; stamp: string; sentAt: number }>();
const doorWanted = new Map<string, string>();
const doorLanded = new Map<string, { seq: number; stamp: string }>();
/** Shared by the page and rail, including route remounts during a read. */
const doorSources = new Map<string, string>();
let doorSeq = 0;
/**
 * An ask out longer than this is presumed lost: the coordinator says nothing to an ask for a
 * world or production it no longer holds, and a door that waited on it would never ask again.
 */
const DOOR_LOST_MS = 30_000;

/**
 * Every ask forgotten — a new world, or a window rejoining, whose answers in flight will not
 * come. The door keeps what it shows; forgetting what landed only means the next ask goes, as
 * one should once a window has been away.
 */
export function forgetDoorAsks(): void {
  doorAsked.clear();
  doorInFlight.clear();
  doorWanted.clear();
  doorLanded.clear();
  doorSources.clear();
}

/**
 * Ask the door (SPEC-047 R-29): every chapter's state, who reads, the price; answered as
 * `audiobook.door`. `stamp` is what the answer depends on, as `useAudiobookDoorStamp` says it:
 * an ask for the stamp already out, or already answered, sends nothing.
 */
export function openAudiobook(worldId: string, productionId: string, stamp = "", manuscript?: { source: string; reading: boolean }): string | null {
  const key = `${worldId}/${productionId}`;
  const flying = doorInFlight.get(key);
  if (manuscript !== undefined) {
    if (manuscript.reading && current.audiobookDoor[productionId]?.door != null && doorSources.get(key) === manuscript.source && (flying === undefined || Date.now() - flying.sentAt < DOOR_LOST_MS)) return null;
    doorSources.set(key, manuscript.source);
  }
  if (flying !== undefined && Date.now() - flying.sentAt < DOOR_LOST_MS) {
    if (flying.stamp === stamp) doorWanted.delete(key);
    else doorWanted.set(key, stamp);
    return flying.requestId;
  }
  const landed = doorLanded.get(key);
  if (flying === undefined && landed !== undefined && landed.stamp === stamp && current.audiobookDoor[productionId]?.door != null) return null;
  return sendDoorAsk(worldId, productionId, stamp);
}

function sendDoorAsk(worldId: string, productionId: string, stamp: string): string | null {
  const key = `${worldId}/${productionId}`;
  const requestId = ulid();
  if (!send({ kind: "open-audiobook", worldId, productionId, requestId })) return null;
  doorSeq += 1;
  doorAsked.set(requestId, { key, seq: doorSeq, stamp });
  doorInFlight.set(key, { requestId, stamp, sentAt: Date.now() });
  doorWanted.delete(key);
  return requestId;
}

/**
 * An answer to one of this window's asks: whether to show it, and — once the ask it answers is
 * no longer out — the newer ask that waited on it, sent. Another window's answers are its own.
 */
export function landDoorAnswer(worldId: string, productionId: string, requestId: string): boolean {
  const key = `${worldId}/${productionId}`;
  const asked = doorAsked.get(requestId);
  if (asked === undefined || asked.key !== key) return false;
  const landed = doorLanded.get(key);
  const newer = landed === undefined || asked.seq > landed.seq;
  if (newer) {
    doorLanded.set(key, { seq: asked.seq, stamp: asked.stamp });
    for (const [id, other] of doorAsked) if (other.key === key && other.seq <= asked.seq) doorAsked.delete(id);
  } else doorAsked.delete(requestId);
  if (doorInFlight.get(key)?.requestId === requestId) {
    doorInFlight.delete(key);
    const wanted = doorWanted.get(key);
    // Sent once this answer is folded, not from inside the fold.
    if (wanted !== undefined)
      queueMicrotask(() => {
        if (!doorInFlight.has(key) && doorWanted.get(key) === wanted) sendDoorAsk(worldId, productionId, wanted);
      });
  }
  return newer;
}

/** Read the book (SPEC-047 R-16, R-17): every chapter with prose, priced once; the token answers the price. */
export function readAudiobookBook(worldId: string, productionId: string, options: { confirmationToken?: string; voiceUploadConfirmedFor?: string } = {}): boolean {
  return send({
    kind: "read-audiobook-book",
    worldId,
    productionId,
    ...(options.confirmationToken !== undefined ? { confirmationToken: options.confirmationToken } : {}),
    ...(options.voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor: options.voiceUploadConfirmedFor } : {}),
  });
}

export function stopAudiobookBook(worldId: string, productionId: string): void {
  send({ kind: "stop-audiobook-book", worldId, productionId });
}

/** A price declined, a consent declined, or an ended run put away: this window's word only. */
export function dismissAudiobookBook(productionId: string): void {
  const held = current.audiobookBook[productionId];
  if (held === undefined) return;
  const { [productionId]: _dropped, ...rest } = current.audiobookBook;
  emitChange({ ...current, audiobookBook: rest });
}

export function dismissAudiobookNote(productionId: string): void {
  if (current.audiobookNotes[productionId] === undefined) return;
  const { [productionId]: _dropped, ...rest } = current.audiobookNotes;
  emitChange({ ...current, audiobookNotes: rest });
}

export function useAudiobookDoors(): StoreState["audiobookDoor"] {
  return useStoreSelector(store => store.audiobookDoor);
}

export function useAudiobookCredits(): StoreState["audiobookCredits"] {
  return useStoreSelector(store => store.audiobookCredits);
}

/** The audiobook's credits (design turn 252), answered as `audiobook.credits`. */
export function openAudiobookCredits(worldId: string, productionId: string): boolean {
  return send({ kind: "open-audiobook-credits", worldId, productionId });
}

/** A credit detail, or a credit's words written over its draft (R-211); null words go back to the draft. */
export function setAudiobookCredits(
  worldId: string,
  productionId: string,
  change: { details?: import("@arke-studio/contracts").AudiobookCreditDetails; words?: { opening?: string | null; closing?: string | null } },
): boolean {
  return send({ kind: "set-audiobook-credits", worldId, productionId, ...change });
}

export function useAudiobookBooks(): StoreState["audiobookBook"] {
  return useStoreSelector(store => store.audiobookBook);
}

export function useAudiobookNotes(): StoreState["audiobookNotes"] {
  return useStoreSelector(store => store.audiobookNotes);
}
