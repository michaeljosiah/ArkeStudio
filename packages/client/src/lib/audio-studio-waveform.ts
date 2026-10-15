import { useCallback, useEffect, useRef } from "react";
import type { AudioSource, AudioWaveform } from "@arke-studio/contracts";
import type { useAudioStudio } from "./audio-studio.js";

export type WaveformRequest = (source: AudioSource, receive: (waveform: AudioWaveform | null) => void) => () => void;

/** Visible clips share one decode queue and a bounded, exact-hash peak cache. */
export function useAudioStudioWaveforms(read: ReturnType<typeof useAudioStudio>["source"]): WaveformRequest {
  const readRef = useRef(read); readRef.current = read;
  const session = useRef({ active: true, busy: false, cache: new Map<string, AudioWaveform>(),
    queue: new Map<string, { source: AudioSource; receivers: Set<(waveform: AudioWaveform | null) => void> }>() });
  useEffect(() => { session.current.active = true; return () => { session.current.active = false; session.current.queue.clear(); session.current.cache.clear(); }; }, []);
  return useCallback((source, receive) => {
    const held = session.current, key = `${source.file}:${source.hash}`;
    const cached = held.cache.get(key);
    if (cached) { receive(cached); return () => {}; }
    let item = held.queue.get(key);
    if (!item) { item = { source, receivers: new Set() }; held.queue.set(key, item); }
    item.receivers.add(receive);
    const drain = () => {
      if (!held.active || held.busy) return;
      const next = held.queue.entries().next().value;
      if (!next) return;
      const [nextKey, queued] = next;
      if (!queued.receivers.size) { held.queue.delete(nextKey); drain(); return; }
      held.busy = true;
      readRef.current(queued.source.file, (_source, _problem, waveform) => {
        held.busy = false; held.queue.delete(nextKey);
        if (!held.active) return;
        const valid = waveform?.hash === queued.source.hash ? waveform : null;
        if (valid) {
          held.cache.set(nextKey, valid);
          while (held.cache.size > 64) held.cache.delete(held.cache.keys().next().value!);
        }
        for (const callback of queued.receivers) callback(valid);
        queueMicrotask(drain);
      }, true, queued.source.hash);
    };
    drain();
    return () => { item.receivers.delete(receive); };
  }, []);
}
