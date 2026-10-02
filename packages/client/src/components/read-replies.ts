import { useEffect, useRef, useState } from "react";
import { freeCreditLeft, narratorLabelFor, narratorReadsUnasked, type WorldChatWorkspace } from "@arke-studio/contracts";
import { useStore } from "../lib/store.js";
import { setReadReplies, stopReplyRead, useReadRepliesChoice } from "../lib/reply-reads.js";
import type { ReadRepliesControl } from "./composer.js";

/**
 * Read replies, for one chat on screen (design turn 183).
 *
 * The toggle reads every reply as it finishes, so it is offered only while the narrator — as it
 * resolves in this world — reads without asking: a voice on this machine, a Free plan key, or a
 * free credit with room this month. A toggle that read through a priced voice would be a way to
 * spend by talking. When the narrator changes to one that would ask, it switches itself off and
 * says so once, rather than vanishing with the author's choice silently undone.
 *
 * What is read automatically is only a reply that arrives while this chat is mounted: the newest
 * studio message, when it was not there before. Opening a conversation, or paging back through
 * an older window, reads nothing.
 */
export function useReadReplies(workspace: WorldChatWorkspace | null): {
  composer: ReadRepliesControl;
  /** The reply that has just finished and should read itself, or null. */
  autoRead: string | null;
} {
  const { state } = useStore();
  const choice = useReadRepliesChoice();
  const narrator = state?.app.narrator ?? null;
  const worldId = state?.world?.meta.worldId;
  const models = state?.app.manifest?.models;
  // A cloud narrator cannot be judged before the manifest arrives; the shipped voice always can.
  const known = narrator === null || narrator.provider === "kokoro" || models !== undefined;
  const offered = known && narratorReadsUnasked(narrator, worldId, models ?? [], freeCreditLeft(state?.app.ledger ?? []));
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!choice || !known || offered) return;
    setReadReplies(false);
    stopReplyRead();
    setNotice(`Read replies off · ${narratorLabelFor(narrator, worldId)} asks first`);
  }, [choice, known, offered]);
  useEffect(() => { if (offered) setNotice(null); }, [offered]);

  const on = choice && offered;
  const onRef = useRef(on);
  onRef.current = on;
  const newest = useRef<{ conversationId: string; id: string | null } | null>(null);
  const [autoRead, setAutoRead] = useState<string | null>(null);
  const studio = (workspace?.messages ?? []).filter((message) => message.role === "studio" && message.benchOutcome === undefined && message.frameRunOutcome === undefined);
  const last = studio.at(-1)?.id ?? null;
  useEffect(() => {
    if (workspace === null) return;
    const seen = newest.current;
    newest.current = { conversationId: workspace.conversationId, id: last };
    // The first window of a conversation is history, not a reply that has just finished.
    if (seen === null || seen.conversationId !== workspace.conversationId) { setAutoRead(null); return; }
    if (last !== null && last !== seen.id && onRef.current) setAutoRead(last);
  }, [workspace?.conversationId, last]);

  return {
    composer: {
      offered,
      on,
      notice,
      onToggle: () => {
        setNotice(null);
        if (on) stopReplyRead();
        setReadReplies(!on);
      },
    },
    autoRead,
  };
}
