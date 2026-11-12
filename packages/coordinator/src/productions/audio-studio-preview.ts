import { AudioArrangementRefusal, type AudioArrangementEdit } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { FfmpegRunner } from "../takes/export.js";
import { prepareAudioStudioPreview } from "./audio-studio.js";
import { audioStudioMixWindow, renderAudioStudioMix } from "./audio-studio-mix.js";

/** Auditions have request-scoped cancellation and drain before their coordinator closes. */
export class AudioStudioPreviews {
  private readonly active = new Map<string, { controller: AbortController; work: Promise<unknown> }>();
  private readonly playing = new Map<string, { controller: AbortController; signal: AbortSignal }>();
  private closed = false;
  cancel(worldId: string, requestId: string): void { const key = `${worldId}/${requestId}`; this.active.get(key)?.controller.abort(); this.playing.get(key)?.controller.abort(); }
  async stop(): Promise<void> { this.closed = true; for (const entry of this.active.values()) entry.controller.abort(); for (const entry of this.playing.values()) entry.controller.abort(); await Promise.allSettled([...this.active.values()].map(entry => entry.work)); }
  async render(store: WorldStore, input: { productionId: string; chapterFile: string; requestId: string; base: string; edit?: AudioArrangementEdit; solo?: string[]; window?: { from: number; to: number } }, ffmpeg?: FfmpegRunner) {
    if (this.closed || store.closingSignal.aborted) throw new AudioArrangementRefusal("The world is closing");
    if (this.active.size >= 4) throw new AudioArrangementRefusal("Other audio previews are still preparing; stop one before trying again");
    if (this.playing.size >= 128) throw new AudioArrangementRefusal("Too many auditions are retained; stop old auditions or reopen their world");
    const key = `${store.worldId}/${input.requestId}`, controller = new AbortController();
    if (this.active.has(key) || this.playing.has(key)) throw new AudioArrangementRefusal("This audition is already preparing or playing");
    const signal = AbortSignal.any([controller.signal, store.closingSignal]);
    const work = (async () => {
      const prepared = await prepareAudioStudioPreview(store, input.productionId, input.chapterFile, input.base, input.edit, { ...(ffmpeg ? { ffmpeg } : {}), signal });
      const rendered = await renderAudioStudioMix(store.dir, prepared.state, prepared.script, { ...(ffmpeg ? { ffmpeg } : {}), signal, retainUntil: signal, unavailable: prepared.unavailable, ...(input.solo ? { solo: input.solo } : {}) });
      const mix = input.window ? await audioStudioMixWindow(store.dir, rendered, input.window.from, input.window.to, signal, signal) : { file: rendered.file, seconds: rendered.seconds, from: 0 };
      await prepared.verify(); signal.throwIfAborted();
      this.playing.set(key, { controller, signal });
      signal.addEventListener("abort", () => this.playing.delete(key), { once: true });
      return { mix, issues: rendered.issues.map(issue => issue.message) };
    })();
    this.active.set(key, { controller, work });
    try { return await work; } catch (error) { controller.abort(); throw error; } finally { this.active.delete(key); }
  }
}
