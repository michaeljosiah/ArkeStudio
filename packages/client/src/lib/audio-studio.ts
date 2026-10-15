import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioArrangementEdit, AudioWaveform, AudioSource, AudioStudioSnapshot } from "@arke-studio/contracts";
import { decideAudioStudioProposal, editAudioStudio, previewAudioStudio, readAudioStudio, readAudioStudioSource, stopAudioStudioPreview, subscribeAudioStudio, subscribeAudiobookMix } from "./store.js";
import { dismissClip, dismissPlayback, playClip, usePlayback } from "./audio.js";
import { claimRead, releaseRead } from "./reply-reads.js";
import { mediaUrl } from "./media.js";

/** Only acknowledged snapshots are displayed; edit drafts and auditions live in the owning UI. */
export function useAudioStudio(input: { worldId: string; productionId: string; chapterId: string; chapterFile: string; connection: string; stamp: unknown }) {
  const { worldId, productionId, chapterId, chapterFile, connection, stamp } = input;
  const [snapshot, setSnapshot] = useState<AudioStudioSnapshot | null>(null);
  const [pending, setPending] = useState(false), [problem, setProblem] = useState<string | null>(null);
  const request = useRef<{ id: string; edit: boolean } | null>(null);
  const sources = useRef(new Map<string, (source: AudioSource | null, problem?: string, waveform?: AudioWaveform) => void>());
  const clear = useCallback(() => {
    request.current = null; setPending(false);
    for (const callback of sources.current.values()) callback(null, "The connection closed; choose the source again");
    sources.current.clear();
  }, []);
  useEffect(() => subscribeAudioStudio(answer => {
    if (answer.worldId !== worldId || answer.productionId !== productionId) return;
    const callback = sources.current.get(answer.requestId);
    if (callback) { sources.current.delete(answer.requestId); callback(answer.source, answer.refused, answer.waveform); return; }
    if (answer.requestId !== request.current?.id) return;
    request.current = null; setPending(false); setProblem(answer.refused ?? null);
    if (answer.studio) setSnapshot(answer.studio);
  }), [worldId, productionId, chapterId]);
  const refresh = useCallback(() => {
    if (connection !== "open" || request.current?.edit) return;
    const id = readAudioStudio(worldId, productionId, chapterFile);
    if (id) { request.current = { id, edit: false }; setPending(true); setProblem(null); }
  }, [worldId, productionId, chapterFile, connection]);
  useEffect(() => { refresh(); }, [refresh, stamp]);
  useEffect(() => { if (connection !== "open") clear(); }, [connection, clear]);
  useEffect(() => () => { request.current = null; sources.current.clear(); }, [worldId, productionId, chapterId]);
  const edit = useCallback((change: AudioArrangementEdit, base = snapshot?.base): boolean => {
    if (!base || connection !== "open" || request.current) return false;
    const id = editAudioStudio(worldId, productionId, chapterFile, base, change);
    if (!id) return false;
    request.current = { id, edit: true }; setPending(true); setProblem(null); return true;
  }, [snapshot, worldId, productionId, chapterFile, connection]);
  const decide = useCallback((id: string, version: number, decision: "keep" | "apply"): boolean => {
    if (connection !== "open" || request.current) return false;
    const requestId = decideAudioStudioProposal(worldId, productionId, chapterFile, id, version, decision);
    if (!requestId) return false;
    request.current = { id: requestId, edit: true }; setPending(true); setProblem(null); return true;
  }, [worldId, productionId, chapterFile, connection]);
  const source = useCallback((file: string, callback: (source: AudioSource | null, problem?: string, waveform?: AudioWaveform) => void, waveform?: boolean, expectedHash?: string) => {
    if (connection !== "open") { callback(null, "Reconnect to prepare this source"); return; }
    const id = readAudioStudioSource(worldId, productionId, chapterFile, file, waveform, expectedHash);
    if (!id) { callback(null, "The request could not be sent"); return; }
    sources.current.set(id, callback);
  }, [worldId, productionId, chapterFile, connection]);
  return { snapshot, pending, problem, setProblem, refresh, edit, source, decide };
}

/** Audition consumes a physical sample-aligned excerpt through the existing single audio player. */
export function useAudioStudioPlayer(input: { worldId: string; productionId: string; chapterId: string; chapterFile: string; slug: string; title: string; connection: string }) {
  const { worldId, productionId, chapterId, chapterFile, slug, title, connection } = input;
  const key = `audio-studio:${worldId}/${productionId}/${chapterId}`;
  const [pending, setPending] = useState(false), [problem, setProblem] = useState<string | null>(null), [issues, setIssues] = useState<string[]>([]), [offset, setOffset] = useState(0);
  const request = useRef<{ id: string; loop: boolean; answered?: boolean } | null>(null);
  const playback = usePlayback();
  const stop = useCallback(() => {
    if (request.current) stopAudioStudioPreview(worldId, request.current.id);
    request.current = null; setPending(false); dismissClip(key); releaseRead(key);
  }, [worldId, key]);
  useEffect(() => subscribeAudiobookMix(answer => {
    if (answer.requestId !== request.current?.id || request.current.answered) return;
    const loop = request.current.loop; request.current.answered = true; setPending(false);
    setIssues(answer.issues ?? []); setProblem(answer.refused ?? null);
    if (!answer.mix) { stop(); return; }
    setOffset(answer.mix.from);
    void playClip({ id: key, url: mediaUrl(slug, answer.mix.file), title, sub: loop ? "Audio Studio · loop audition" : "Audio Studio", loop });
  }), [key, slug, title, stop]);
  useEffect(() => () => stop(), [stop]);
  useEffect(() => { if (connection !== "open") stop(); }, [connection, stop]);
  useEffect(() => { if (pending && playback.clip && playback.clip.id !== key) stop(); }, [pending, playback.clip, key, stop]);
  const play = useCallback((base: string, options: { edit?: AudioArrangementEdit; solo?: string[]; window?: { from: number; to: number }; loop?: boolean } = {}) => {
    stop(); dismissPlayback(); claimRead(key, stop);
    const { loop, ...requestOptions } = options;
    const id = previewAudioStudio(worldId, productionId, chapterFile, base, requestOptions);
    if (!id) { setProblem("Reconnect to audition this chapter"); releaseRead(key); return; }
    request.current = { id, loop: loop === true }; setPending(true); setProblem(null); setIssues([]);
  }, [worldId, productionId, chapterFile, key, stop]);
  const mine = playback.clip?.id === key;
  useEffect(() => { if (mine && playback.status === "ended") stop(); }, [mine, playback.status, stop]);
  const playing = mine && ["playing", "loading", "paused", "blocked"].includes(playback.status);
  return { play, stop, pending, playing, issues, problem: problem ?? (mine ? playback.error : null), at: mine && playback.status !== "ended" ? Math.round((offset + playback.currentTime) * 48000) : null };
}
