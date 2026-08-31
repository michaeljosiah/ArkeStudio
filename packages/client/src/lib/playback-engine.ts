/*
 * The transport, and the rules for keeping a media element in step with it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Portions of this file are derived from LTX-Desktop
 *   https://github.com/Lightricks/LTX-Desktop  (commit 7ec86f3, 2026-08-19)
 *   Copyright (c) Lightricks Ltd.
 *   Licensed under the Apache License, Version 2.0 — see licenses/LICENSE.LTX-Desktop.txt
 *
 * Derived from `frontend/views/editor/usePlaybackEngine.ts` (the rAF transport, the 250ms state
 * throttle, and the layout-effect flush on stop) and `frontend/views/editor/usePlaybackAudioSync.ts`
 * (activation seek tolerance, drift correction, throttled play() retry, the readyState gate, and
 * the intended-source guard).
 *
 * Changes made, as Apache-2.0 §4(b) requires:
 *   - The transport read six values off a Zustand store and called three store actions. It takes
 *     plain parameters and callbacks here, because Arke's cut is derived rather than a store.
 *   - Shuttle speed and in/out looping are dropped: neither is drawn in 80a or 81a, and the one
 *     authored edit the cut offers is trim. `speed` and `reversed` go with them — Arke's takes
 *     have no rate, so `playbackRate` is never set and the reverse branch has nothing to select.
 *   - The audio sync walked every clip on every tick, retaining, preloading and muting a whole
 *     track model with solo/mute state. It is reduced to one element against one span, since the
 *     derived cut plays exactly one piece of picture at a time and audio is a separate track.
 *   - `pathToFileUrl` became the caller's `src`: Arke serves world media over the coordinator's
 *     HTTP side, never `file://`.
 *   - The per-element bookkeeping upstream kept in `__`-prefixed expandos is a WeakMap here, so
 *     the DOM node is not mutated and a detached element cannot leak its state.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";

/** Upstream's throttle: the transport advances every frame, React hears about it four times a second. */
export const STATE_UPDATE_INTERVAL_MS = 250;

/** On activation, seek only if the element is further off than this. */
export const ACTIVATION_SEEK_TOLERANCE_SEC = 0.12;

/**
 * While playing, leave `currentTime` alone until it drifts further than this.
 *
 * The number is upstream's and it is the whole trick: an element that is corrected every frame
 * stutters, because each assignment restarts its decode. Letting it run and pulling it back only
 * when it is properly lost is what makes playback smooth.
 */
export const DRIFT_CORRECTION_SEC = 1.5;

/** A rejected `play()` is retried, but not on every frame. */
export const PLAY_RETRY_INTERVAL_MS = 500;

/**
 * Advance `timeRef` in real time while `playing`, and report it at {@link STATE_UPDATE_INTERVAL_MS}.
 *
 * The ref is the hot path and the callback is the render path — the same split upstream uses, and
 * the reason a preview can run at 60fps without re-rendering the screen sixty times a second.
 */
export function useTransport(opts: {
  playing: boolean;
  durationSec: number;
  timeRef: MutableRefObject<number>;
  onTime: (seconds: number) => void;
  onEnded?: () => void;
}): (seconds: number) => void {
  const { playing, durationSec, timeRef, onTime, onEnded } = opts;
  const lastReport = useRef(0);
  const wasPlaying = useRef(playing);
  const started = useRef<{ atMs: number; positionSec: number } | null>(null);
  const latest = useRef({ onTime, onEnded });
  latest.current = { onTime, onEnded };
  const setPosition = useCallback((seconds: number) => {
    const positionSec = Math.min(Math.max(0, seconds), durationSec);
    timeRef.current = positionSec;
    if (playing) started.current = { atMs: Date.now(), positionSec };
  }, [playing, durationSec, timeRef]);

  // Flush on stop before paint, or the paused UI shows a stale time for one frame.
  useLayoutEffect(() => {
    const stopping = wasPlaying.current && !playing;
    wasPlaying.current = playing;
    if (stopping) {
      const origin = started.current;
      if (origin !== null) timeRef.current = transportPosition(origin.positionSec, origin.atMs, Date.now(), durationSec);
      started.current = null;
      latest.current.onTime(timeRef.current);
    }
  }, [playing, durationSec, timeRef]);

  useEffect(() => {
    if (!playing || typeof requestAnimationFrame !== "function") return;
    let frame = 0;
    lastReport.current = 0;
    started.current = { atMs: Date.now(), positionSec: timeRef.current };

    const tick = (timestamp: number) => {
      if (lastReport.current === 0) lastReport.current = timestamp;
      const origin = started.current;
      if (origin === null) return;
      const next = transportPosition(origin.positionSec, origin.atMs, Date.now(), durationSec);

      if (next >= durationSec) {
        timeRef.current = durationSec;
        latest.current.onTime(durationSec);
        latest.current.onEnded?.();
        return;
      }
      timeRef.current = next;
      if (timestamp - lastReport.current >= STATE_UPDATE_INTERVAL_MS) {
        lastReport.current = timestamp;
        latest.current.onTime(next);
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      const origin = started.current;
      if (origin !== null) timeRef.current = transportPosition(origin.positionSec, origin.atMs, Date.now(), durationSec);
      started.current = null;
      latest.current.onTime(timeRef.current);
    };
  }, [playing, durationSec, timeRef]);
  return setPosition;
}

/** Position from one playback epoch; delayed frames cannot slow this clock down. */
export function transportPosition(positionSec: number, startedAtMs: number, nowMs: number, durationSec: number): number {
  return Math.min(durationSec, Math.max(0, positionSec + (nowMs - startedAtMs) / 1000));
}

/** Per-element bookkeeping, off the DOM node so a detached element takes its state with it. */
const bookkeeping = new WeakMap<
  HTMLMediaElement,
  { src: string | null; started: boolean; lastRetry: number; awaiting: boolean }
>();

/**
 * Put one media element where the transport says it should be.
 *
 * Call it whenever the target moves. It is deliberately cheap and idempotent: the common case is
 * "already playing the right thing at roughly the right time", and that path touches nothing.
 */
export function syncMediaElement(
  el: HTMLMediaElement,
  opts: { src: string | null; targetSec: number; playing: boolean; nowMs: number },
): void {
  const { src, targetSec, playing, nowMs } = opts;
  let state = bookkeeping.get(el);
  if (state === undefined) {
    state = { src: null, started: false, lastRetry: 0, awaiting: false };
    bookkeeping.set(el, state);
  }

  if (src === null) {
    if (!el.paused) el.pause();
    state.started = false;
    return;
  }

  // Only reset the source when it actually changes: assigning `src` reloads, and a reload on
  // every tick is an element that never gets as far as showing a frame.
  if (state.src !== src) {
    state.src = src;
    state.started = false;
    el.src = src;
  }

  /*
   * Nothing can be seeked or played before there is media to seek. HAVE_CURRENT_DATA is upstream's
   * gate — but a gate alone drops the request: a source assigned this tick is never ready this
   * tick, and if nothing moves afterwards (a seek while paused is exactly that) the element sits
   * at zero showing the wrong frame. Upstream re-ran the sync from `canplay`; so does this.
   */
  if (el.readyState < 2) {
    if (!state.awaiting) {
      state.awaiting = true;
      const onReady = () => {
        el.removeEventListener("loadeddata", onReady);
        const pending = bookkeeping.get(el);
        if (pending !== undefined) pending.awaiting = false;
        // Re-ask rather than replaying the old target: by now the transport has moved on.
        onReadyAgain.get(el)?.();
      };
      el.addEventListener("loadeddata", onReady);
    }
    return;
  }
  state.awaiting = false;

  if (!state.started) {
    if (Math.abs(el.currentTime - targetSec) > ACTIVATION_SEEK_TOLERANCE_SEC) el.currentTime = targetSec;
    if (playing) {
      void el.play().catch(() => {});
      state.started = true;
      state.lastRetry = nowMs;
    }
    return;
  }

  if (!playing) {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - targetSec) > ACTIVATION_SEEK_TOLERANCE_SEC) el.currentTime = targetSec;
    return;
  }

  if (Math.abs(el.currentTime - targetSec) > DRIFT_CORRECTION_SEC) el.currentTime = targetSec;
  if (el.paused && nowMs - state.lastRetry > PLAY_RETRY_INTERVAL_MS) {
    state.lastRetry = nowMs;
    void el.play().catch(() => {});
  }
}

/**
 * What to re-run when an element finally has data.
 *
 * The caller owns the current target — the transport has kept moving while the file loaded — so
 * the element asks for a fresh sync rather than replaying the one it could not serve.
 */
const onReadyAgain = new WeakMap<HTMLMediaElement, () => void>();

/** Register the re-sync an element should ask for once it can be seeked. */
export function onMediaReady(el: HTMLMediaElement, resync: () => void): void {
  onReadyAgain.set(el, resync);
}

/** Forget an element's bookkeeping — for tests, which reuse one fake across cases. */
export function resetMediaElement(el: HTMLMediaElement): void {
  bookkeeping.delete(el);
  onReadyAgain.delete(el);
}
