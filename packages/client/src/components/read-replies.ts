import { useEffect, useRef, useState } from "react";
import { freeCreditLeft, freePlanAllowance, narratorLabelFor, narratorReadsUnasked, type WorldChatWorkspace } from "@arke-studio/contracts";
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
  const creditLeft = freeCreditLeft(state?.app.ledger ?? []);
  const offered = known && narratorReadsUnasked(narrator, worldId, models ?? [], creditLeft);
  const [notice, setNotice] = useState<string | null>(null);

  // Off for the replies still to come, not for the one being read (codex on PR 1473): the read
  // that spends the last of a free credit lands its ledger line before its audio, and stopping
  // it here would cut off a read that was admitted free.
  useEffect(() => {
    if (!choice || !known || offered) return;
    setReadReplies(false);
    setNotice(`Read replies off · ${narratorLabelFor(narrator, worldId)} asks first`);
  }, [choice, known, offered]);
  useEffect(() => { if (offered) setNotice(null); }, [offered]);

  const on = choice && offered;
  const onRef = useRef(on);
  onRef.current = on;
  const newest = useRef<{ conversationId: string; id: string | null } | null>(null);
  const [autoRead, setAutoRead] = useState<string | null>(null);
  const studio = (workspace?.messages ?? []).filter((message) => message.role === "studio" && message.benchOutcome === undefined && message.frameRunOutcome === undefined);
  const last = studio.at(-1) ?? null;
  // This reply, weighed on its own: a free credit with room for something may not have room for
  // a long reply, and reading it would put a price in front of the author unasked (codex on PR
  // 1473). Such a reply is left for Listen, which asks.
  const unasked = useRef<(text: string) => boolean>(() => false);
  // The same for Google's free day: a reply read with none of it left is left for Listen.
  const ledger = state?.app.ledger ?? [];
  unasked.current = (text) => narratorReadsUnasked(narrator, worldId, models ?? [], creditLeft, text, (model) => freePlanAllowance(ledger, model).left);
  useEffect(() => {
    if (workspace === null) return;
    const seen = newest.current;
    newest.current = { conversationId: workspace.conversationId, id: last?.id ?? null };
    // The first window of a conversation is history, not a reply that has just finished.
    if (seen === null || seen.conversationId !== workspace.conversationId) { setAutoRead(null); return; }
    if (last !== null && last.id !== seen.id && onRef.current && unasked.current(last.text)) setAutoRead(last.id);
  }, [workspace?.conversationId, last?.id]);

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
