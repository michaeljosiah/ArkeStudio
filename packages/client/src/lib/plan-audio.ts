import { useEffect, useRef, type MutableRefObject } from "react";
import { audioGainDbAt, type RenderAudioItem, type RenderPlan } from "@arke-studio/contracts";

/**
 * The browser executor's sound (SPEC-038 R-13..R-19, D1; issue 681).
 *
 * One `<audio>` element per plan item, each through its own gain node into one limiter and out.
 * Every animation frame asks the plan what each sound plays at — its own gain after any ducking —
 * so the monitor mix is the same arithmetic the FFmpeg builder spells into its volume expression.
 * Nothing here decides a mix; the plan already did.
 *
 * Absent in tests and in any window without Web Audio: the hook does nothing rather than throw.
 */

interface Voice {
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  item: RenderAudioItem;
  started: boolean;
}

/** Linear gain for a dB figure, the same conversion the FFmpeg expression performs. */
export function linearGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** How far into an item's source the transport is, for a moment inside its window. */
export function itemSourceSec(item: Pick<RenderAudioItem, "startSec" | "sourceInSec">, sec: number): number {
  return item.sourceInSec + Math.max(0, sec - item.startSec);
}

const ACTIVATION_TOLERANCE_SEC = 0.12;
const DRIFT_SEC = 0.5;

export function usePlanAudio(opts: {
  plan: RenderPlan | null;
  playing: boolean;
  timeRef: MutableRefObject<number>;
  urlFor: (path: string) => string | null;
}): void {
  const { plan, playing, timeRef, urlFor } = opts;
  const context = useRef<AudioContext | null>(null);
  const limiter = useRef<DynamicsCompressorNode | null>(null);
  const voices = useRef<Map<string, Voice>>(new Map());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.AudioContext !== "function") return;
    const graph = voices.current;
    const ctx = new window.AudioContext();
    context.current = ctx;
    // A brick-wall stand-in for FFmpeg's alimiter: hard knee, high ratio, fast attack.
    const guard = ctx.createDynamicsCompressor();
    guard.threshold.value = plan?.mix.limiterCeilingDb ?? -1;
    guard.knee.value = 0;
    guard.ratio.value = 20;
    guard.attack.value = 0.001;
    guard.release.value = 0.05;
    guard.connect(ctx.destination);
    limiter.current = guard;
    return () => {
      for (const voice of graph.values()) {
        voice.element.pause();
        voice.source.disconnect();
        voice.gain.disconnect();
        voice.element.removeAttribute("src");
      }
      graph.clear();
      limiter.current = null;
      context.current = null;
      void ctx.close().catch(() => {});
    };
  }, []);

  // Voices follow the plan: one per audio item, created when the item appears and dropped when it goes.
  useEffect(() => {
    const ctx = context.current;
    const guard = limiter.current;
    const graph = voices.current;
    if (ctx === null || guard === null) return;
    guard.threshold.value = plan?.mix.limiterCeilingDb ?? -1;
    const wanted = new Map<string, RenderAudioItem>((plan?.audio ?? []).map((item, index) => [`${item.clipId ?? index}:${item.path}:${item.startSec}`, item]));
    for (const [key, voice] of graph) {
      if (wanted.has(key)) continue;
      voice.element.pause();
      voice.source.disconnect();
      voice.gain.disconnect();
      voice.element.removeAttribute("src");
      graph.delete(key);
    }
    for (const [key, item] of wanted) {
      const existing = graph.get(key);
      if (existing !== undefined) {
        existing.item = item;
        continue;
      }
      const url = urlFor(item.path);
      if (url === null) continue;
      const element = new Audio(url);
      element.preload = "auto";
      element.crossOrigin = "anonymous";
      const source = ctx.createMediaElementSource(element);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(guard);
      graph.set(key, { element, source, gain, item, started: false });
    }
  }, [plan, urlFor]);

  // The frame loop: each voice plays inside its window at the plan's gain and is silent outside it.
  useEffect(() => {
    const ctx = context.current;
    const graph = voices.current;
    if (ctx === null || plan === null) return;
    if (!playing) {
      for (const voice of graph.values()) {
        if (!voice.element.paused) voice.element.pause();
        voice.started = false;
      }
      return;
    }
    void ctx.resume().catch(() => {});
    let frame = 0;
    const tick = () => {
      const at = timeRef.current;
      for (const voice of graph.values()) {
        const { item, element } = voice;
        const inside = at >= item.startSec && at < item.endSec;
        if (!inside) {
          if (!element.paused) element.pause();
          voice.started = false;
          voice.gain.gain.value = 0;
          continue;
        }
        voice.gain.gain.value = linearGain(audioGainDbAt(plan, item, at));
        const target = itemSourceSec(item, at);
        if (!voice.started) {
          if (Math.abs(element.currentTime - target) > ACTIVATION_TOLERANCE_SEC) element.currentTime = target;
          void element.play().catch(() => {});
          voice.started = true;
        } else if (Math.abs(element.currentTime - target) > DRIFT_SEC) {
          element.currentTime = target;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      for (const voice of graph.values()) {
        if (!voice.element.paused) voice.element.pause();
        voice.started = false;
      }
    };
  }, [plan, playing, timeRef]);
}
