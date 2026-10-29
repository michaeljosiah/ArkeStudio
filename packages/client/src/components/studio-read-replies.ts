import { useEffect, useRef, useState } from "react";
import { STUDIO_ASSISTANT_LIMITS, KOKORO_VOICE_MODEL, studioLocalNarrator } from "@arke-studio/contracts";
import type { StudioConversationClient, StudioConversationView } from "../lib/studio-assistant.js";
import { useStore, useVoiceSidecar } from "../lib/store.js";
import { claimRead, releaseRead, setReadReplies, stopReplyRead, useReadRepliesChoice } from "../lib/reply-reads.js";
import { dismissPlayback, playbackSnapshot, playClip, usePlayback } from "../lib/audio.js";
import type { ReadRepliesControl } from "./composer.js";

interface Read {
  key: string; messageId: string; threadId: string; voiceId: string; control: AbortController; loading: boolean;
  part: number; parts?: number; previous?: { source: string; voiceId: string }; url?: string; baseline: string | null;
}

/** One transient part at a time through the app's existing player. No world source/cache. */
export function useStudioReadReplies(client: StudioConversationClient, view: StudioConversationView, visible = true) {
  const { state } = useStore(), sidecar = useVoiceSidecar(), playback = usePlayback(), choice = useReadRepliesChoice();
  const voiceId = studioLocalNarrator(state?.app.narrator), offered = voiceId !== null && sidecar?.state === "ready" && !state?.app.models.disabled.includes(KOKORO_VOICE_MODEL);
  const active = useRef<Read | null>(null), latest = useRef<{ threadId: string; messageId: string | null } | null>(null);
  const queued = useRef<string | null>(null);
  const [reading, setReading] = useState<string | null>(null), [trouble, setTrouble] = useState<string | null>(null);
  const thread = view.state?.threads.find(row => row.id === view.selected), last = thread?.messages.findLast(row => row.role === "arke");
  const stop = (update = true) => {
    queued.current = null;
    const read = active.current; if (!read) return; active.current = null; read.control.abort(); releaseRead(read.key);
    if (playbackSnapshot().clip?.id === read.key) dismissPlayback();
    if (read.url) URL.revokeObjectURL(read.url); if (update) setReading(null);
  };
  const next = async (read: Read) => {
    if (active.current !== read || read.loading) return;
    if (read.parts !== undefined && read.part >= read.parts) {
      const waiting = queued.current; stop(); if (waiting) listen(waiting); return;
    }
    read.loading = true;
    const response = await client.readReplyPart(read.threadId, read.messageId, read.part, read.control.signal, read.previous ?? { voiceId: read.voiceId });
    if (active.current !== read || read.control.signal.aborted) return;
    if ((playbackSnapshot().clip?.id ?? null) !== (read.url ? read.key : read.baseline)) { stop(); return; }
    if (!response || response.voiceId !== read.voiceId || read.parts !== undefined && read.parts !== response.parts) {
      stop(); setTrouble("Local reading is unconfirmed or unavailable. Nothing will be sent again automatically."); return;
    }
    try {
      const binary = atob(response.audioBase64);
      if (binary.length > STUDIO_ASSISTANT_LIMITS.speechBytes || btoa(binary) !== response.audioBase64) throw new Error("Invalid audio");
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })), old = read.url;
      read.previous = { source: response.source, voiceId: response.voiceId }; read.parts = response.parts; read.url = url; read.part++;
      await playClip({ id: read.key, url, title: "Arke · Studio assistant", sub: `Part ${read.part} of ${read.parts}` });
      if (old) URL.revokeObjectURL(old); read.loading = false;
    } catch { stop(); setTrouble("Local reply audio could not be played."); }
  };
  const listen = (messageId: string) => {
    if (!view.connected || !view.fresh) { setTrouble("Reconnect to listen to Studio replies."); return; }
    if (!visible || !view.open || !view.connected || !view.fresh || !offered || !voiceId || !thread || thread.archived || !thread.messages.some(row => row.id === messageId && row.role === "arke")) return;
    stopReplyRead(); stop(); setTrouble(null);
    const read: Read = { key: `studio-read-${crypto.randomUUID()}`, messageId, threadId: thread.id, voiceId, control: new AbortController(), loading: false,
      part: 0, baseline: playbackSnapshot().clip?.id ?? null };
    active.current = read; setReading(messageId); claimRead(read.key, () => stop(), true); void next(read);
  };
  useEffect(() => () => stop(false), []);
  useEffect(() => { if (!choice) queued.current = null; }, [choice]);
  useEffect(() => {
    const read = active.current;
    if (!visible || !view.open || !view.connected || !view.fresh || view.submitting || !offered || thread?.archived || read && (thread?.id !== read.threadId || read.voiceId !== voiceId)) stop();
  }, [visible, view.open, view.connected, view.fresh, view.submitting, thread?.id, thread?.archived, offered, voiceId]);
  useEffect(() => {
    const read = active.current; if (!read) return;
    if (read.url && playback.clip?.id !== read.key || !read.url && (playback.clip?.id ?? null) !== read.baseline) { stop(); return; }
    if (playback.clip?.id !== read.key) return;
    if (playback.status === "ended") void next(read);
    else if (playback.status === "error") { stop(); setTrouble("Local reply audio could not be played."); }
  }, [playback]);
  useEffect(() => {
    if (!visible || !view.open || !view.fresh || !view.connected || !thread) { latest.current = null; return; }
    const before = latest.current; latest.current = { threadId: thread.id, messageId: last?.id ?? null };
    if (before?.threadId === thread.id && before.messageId !== last?.id && last && choice && offered) {
      // A new answer is authorized by the toggle, but cannot race a cancelled original
      // producer. Retain one latest, unsent read until the current reply has finished.
      if (active.current) queued.current = last.id; else listen(last.id);
    }
  }, [visible, view.open, view.fresh, view.connected, thread?.id, last?.id]);
  const composer: ReadRepliesControl = { offered, on: choice && offered, onToggle: () => { if (choice) stopReplyRead(); setTrouble(null); setReadReplies(!choice); },
    notice: trouble ?? (choice && !offered ? "Studio reading needs an available local app narrator." : null) };
  return { composer, listen, stop: () => stop(), reading, offered: offered && visible, trouble };
}
