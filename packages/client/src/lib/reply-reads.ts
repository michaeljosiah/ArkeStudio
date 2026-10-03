import { useSyncExternalStore } from "react";

/*
 * One read at a time, across the app (design turn 183).
 *
 * The element in audio.ts already plays one clip at a time, but a read is more than the clip
 * sounding: a long read arrives in pieces and its owner queues each one as it lands. A second
 * read that only replaced the clip left the first one's owner queueing — the next piece of the
 * old reply landed and took the voice back mid-sentence. So whoever starts a read claims it
 * here, and the claim stops the previous owner outright: its request dropped, its queue cleared,
 * the coordinator told to stop making pieces nobody will hear.
 */

type Owner = { key: string; stop: () => void; reply: boolean };
let owner: Owner | null = null;

/** Start owning the read; whoever owned it before is stopped first. */
export function claimRead(key: string, stop: () => void, reply = false): void {
  const previous = owner;
  owner = { key, stop, reply };
  if (previous !== null && previous.key !== key) previous.stop();
}

/** The read under this key is over — finished, stopped or replaced. */
export function releaseRead(key: string): void {
  if (owner?.key === key) owner = null;
}

/**
 * Stop a reply being read: speaking to the composer, sending a message, or leaving the chat
 * (design turn 183). Only a reply — a page read somebody started on the bible is not the chat's
 * to stop.
 */
export function stopReplyRead(): void {
  const current = owner;
  if (current === null || !current.reply) return;
  owner = null;
  current.stop();
}

/*
 * Read replies (design turn 183): each reply that finishes while the chat is on screen reads
 * itself. Kept per device, as a choice about this machine's speakers rather than about the
 * world, and mirrored in memory so a browser that refuses storage still keeps it for the
 * session. Only the one word goes into storage — `on` or `off`.
 */
const KEY = "arke.chat.readReplies";
const listeners = new Set<() => void>();
let remembered: boolean | null = null;

function stored(): boolean {
  if (remembered !== null) return remembered;
  try {
    remembered = window.localStorage?.getItem(KEY) === "on";
  } catch {
    remembered = false;
  }
  return remembered;
}

export function setReadReplies(on: boolean): void {
  remembered = on;
  try {
    window.localStorage?.setItem(KEY, on ? "on" : "off");
  } catch {
    // The session keeps the choice; nothing else to do.
  }
  listeners.forEach((listener) => listener());
}

export function useReadRepliesChoice(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stored,
    () => false,
  );
}

/** Tests start from a device that has chosen nothing. */
export function resetReadRepliesForTest(): void {
  remembered = null;
  owner = null;
}
