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
  /** The gain last asked for, so a frame that changes nothing schedules nothing. */
  gainAt: number;
  /** When this voice left its window, for the release below; null while it is inside one. */
  releasedAt: number | null;
  /** When `play()` was last asked for, in frame-clock milliseconds; see {@link PLAY_RETRY_MS}. */
  playedAt: number;
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

/*
 * The monitor's anti-click ramp.
 *
 * Assigning `gain.value` steps the signal: a clip entering its window went from silence to full
 * level between one sample and the next, which is a click at every edge, and the ducking envelope
 * moving in sixty steps a second zippers on top of it. Eight milliseconds is under the threshold
 * of an audible level change and over the one that makes the discontinuity audible, so the
 * monitor smooths what the plan decides without deciding anything itself — the FFmpeg expression
 * is untouched and the two still agree on every level they state.
 */
const RAMP_SEC = 0.008;
/** Five time constants: near enough to silence that pausing the element there is inaudible. */
const RELEASE_SEC = RAMP_SEC * 5;

/**
 * A rejected `play()` — or a context autoplay left suspended — is asked again on this interval.
 *
 * Wall milliseconds, from the frame clock, and deliberately not `AudioContext.currentTime`: that
 * clock does not advance while the context is suspended, which is precisely the state a blocked
 * autoplay leaves it in. A retry paced by it would never come due in the one case it exists for.
 * `playback-engine.ts` uses the same 500ms on the video path.
 */
const PLAY_RETRY_MS = 500;

/** Film seconds to source seconds for an item: the mapping a retained voice is playing under. */
function sourceOffset(item: Pick<RenderAudioItem, "startSec" | "sourceInSec">): number {
  return item.sourceInSec - item.startSec;
}

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
    /*
     * Keyed by what the element is, not by where the clip sits.
     *
     * `startSec` used to be part of this, so nudging a bed half a second along the lane made a
     * key nothing matched: the voice was torn down and a fresh `<audio>` refetched the same file
     * from the coordinator, which is a hole in the monitor for as long as the load takes. Where
     * a clip is, is the window the tick already reads off `item` every frame — updated in place
     * below — and the only change the element itself cannot absorb is a change of file.
     */
    const wanted = new Map<string, RenderAudioItem>((plan?.audio ?? []).map((item, index) => [`${item.clipId ?? index}:${item.path}`, item]));
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
        /*
         * A retained voice whose window moved is re-seeked, not left to drift.
         *
         * Keeping the element across a move is what stops the file being refetched, but the
         * element is still playing the old mapping from film seconds to source seconds, and the
         * loop only corrects past half a second. An edit smaller than that — which is most of
         * them — would leave the monitor quietly playing the wrong part of the file until
         * playback stopped. Asking for the activation seek again costs one seek and no reload.
         */
        if (sourceOffset(existing.item) !== sourceOffset(item)) existing.started = false;
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
      graph.set(key, { element, source, gain, item, started: false, gainAt: 0, releasedAt: null, playedAt: 0 });
    }
  }, [plan, urlFor]);

  /*
   * The loop reads the plan through a ref, and restarts only when the transport does.
   *
   * The Cut screen rebuilds its render plan on every render and the transport reports four times
   * a second, so the hook was handed a structurally identical plan under a fresh identity four
   * times a second for the whole length of a film. This effect depended on that identity, and its
   * cleanup pauses every element — so one dragged-in bed was four pause/play cycles per second of
   * playback. That is what "choppy" was: not decoding, not the network, the monitor stopping and
   * starting itself. Nothing about the sound changed across those rebuilds, so nothing here needs
   * to hear about them; the tick reads whatever plan is current when it runs.
   */
  const planRef = useRef(plan);
  planRef.current = plan;

  // The frame loop: each voice plays inside its window at the plan's gain and is silent outside it.
  useEffect(() => {
    const ctx = context.current;
    const graph = voices.current;
    if (ctx === null) return;
    if (!playing) {
      // A person pressing stop expects it now, so this one does not ride the release below.
      for (const voice of graph.values()) {
        if (!voice.element.paused) voice.element.pause();
        voice.started = false;
        voice.releasedAt = null;
        silence(voice, ctx.currentTime);
      }
      return;
    }
    void ctx.resume().catch(() => {});
    let frame = 0;
    let resumedAt = 0;
    const tick = (nowMs: number) => {
      const plan = planRef.current;
      const at = timeRef.current;
      /*
       * A context autoplay left suspended is asked again too.
       *
       * `resume()` above is one request, and it is refused when the page has not been gestured at
       * yet. Every element can then be playing perfectly while the graph they feed produces
       * nothing, and retrying `play()` alone would never recover it — the elements are not the
       * thing that is stopped.
       */
      if (ctx.state === "suspended" && nowMs - resumedAt > PLAY_RETRY_MS) {
        resumedAt = nowMs;
        void ctx.resume().catch(() => {});
      }
      for (const voice of graph.values()) {
        const { item, element } = voice;
        const inside = plan !== null && at >= item.startSec && at < item.endSec;
        if (!inside) {
          /*
           * Fade, then pause. Stopping an element mid-waveform is a click of its own, so the
           * gain leaves first and the element stops once the ramp has taken it to silence.
           */
          if (voice.releasedAt === null) voice.releasedAt = ctx.currentTime;
          rampGain(voice, 0, ctx.currentTime);
          if (!element.paused && ctx.currentTime - voice.releasedAt >= RELEASE_SEC) {
            element.pause();
            voice.started = false;
          }
          continue;
        }
        voice.releasedAt = null;
        rampGain(voice, linearGain(audioGainDbAt(plan, item, at)), ctx.currentTime);
        const target = itemSourceSec(item, at);
        if (!voice.started) {
          if (Math.abs(element.currentTime - target) > ACTIVATION_TOLERANCE_SEC) element.currentTime = target;
          voice.started = true;
          voice.playedAt = nowMs;
          void element.play().catch(() => {});
          continue;
        }
        if (Math.abs(element.currentTime - target) > DRIFT_SEC) element.currentTime = target;
        /*
         * A rejected `play()` is asked again.
         *
         * `started` says the voice has been told to play, not that it is playing: the promise can
         * reject on a transient media or autoplay interruption, and the element stays paused. The
         * churn this loop used to suffer retried it by accident every quarter second; now that the
         * loop survives a render, a single rejection would leave that clip silent for the rest of
         * the session. The video path has always retried on an interval, and this is that.
         */
        if (element.paused && nowMs - voice.playedAt > PLAY_RETRY_MS) {
          voice.playedAt = nowMs;
          void element.play().catch(() => {});
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      const now = context.current?.currentTime ?? 0;
      for (const voice of graph.values()) {
        if (!voice.element.paused) voice.element.pause();
        voice.started = false;
        voice.releasedAt = null;
        silence(voice, now);
      }
    };
  }, [playing, timeRef]);
}

/**
 * Ask a voice for a level, over {@link RAMP_SEC} rather than between two samples.
 *
 * A frame that changes nothing schedules nothing: the envelope moves every frame while ducking
 * and not at all the rest of the time, and sixty redundant automation events a second is a cost
 * with no sound to show for it.
 */
function rampGain(voice: Voice, target: number, nowSec: number): void {
  if (Math.abs(voice.gainAt - target) < 1e-4) return;
  voice.gainAt = target;
  // `setTargetAtTime` and not `value`: once a param is automated an assignment to `value` is
  // ignored, so the two cannot be mixed and the ramp is the only way the level is ever set.
  voice.gain.gain.setTargetAtTime(target, nowSec, RAMP_SEC);
}

/** Down to nothing at once, for a stop that has already happened. */
function silence(voice: Voice, nowSec: number): void {
  voice.gainAt = 0;
  voice.gain.gain.cancelScheduledValues(nowSec);
  voice.gain.gain.setValueAtTime(0, nowSec);
}
