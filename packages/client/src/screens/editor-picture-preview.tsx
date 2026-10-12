import { useEffect, useRef, useState, type ReactNode } from "react";
import { effectsForPicture, pictureStackAtFrame, pictureTransitionWeight, type EffectRenderProjection } from "@arke-studio/contracts";
import { PreviewMediaPool } from "../lib/editor-preview-media.js";
import { PreviewFrameQueue, previewReactionMappingKey, type PreviewAnalysisInstall, type PreviewAnalysisResult, type PreviewFrameRequest, type PreviewFrameResult, type PreviewReactionSources } from "../lib/editor-preview-frame.js";
import type { Transport } from "./editor-transport.js";

/** Exposed as a pure clock conversion so episode offsets and end-frame holds stay explicit. */
export function previewProductionFrame(projection: Pick<EffectRenderProjection, "startFrame" | "endFrame" | "frameRate">, seconds: number): number {
  return Math.max(projection.startFrame, Math.min(projection.endFrame - 1, projection.startFrame + Math.floor(Math.max(0, seconds) * projection.frameRate + 0.000001)));
}

const EMPTY_REACTIONS: PreviewReactionSources = { manifestsByKey: {}, manifestKeyByEffectId: {} };

export function EditorPicturePreview({ projection, transport, urlFor, resolution = 1, reactions = EMPTY_REACTIONS, children }: {
  projection: EffectRenderProjection;
  transport: Transport;
  urlFor: (path: string) => string | null;
  resolution?: 1 | 0.5;
  reactions?: PreviewReactionSources;
  children?: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(transport);
  live.current = transport;
  const refresh = useRef<(() => void) | null>(null);
  const install = useRef<(() => void) | null>(null);
  const reactionSources = useRef(reactions);
  reactionSources.current = reactions;
  const currentProjection = useRef(projection);
  currentProjection.current = projection;
  const currentUrlFor = useRef(urlFor);
  currentUrlFor.current = urlFor;

  useEffect(() => {
    const viewport = host.current, element = stage.current;
    if (!viewport || !element) return;
    const fit = () => {
      const scale = Math.min(viewport.clientWidth / projection.width, viewport.clientHeight / projection.height);
      const width = projection.width * scale, height = projection.height * scale;
      Object.assign(element.style, { width: `${width}px`, height: `${height}px`, left: `${(viewport.clientWidth - width) / 2}px`, top: `${(viewport.clientHeight - height) / 2}px` });
    };
    fit();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    observer?.observe(viewport);
    window.addEventListener("resize", fit);
    return () => { observer?.disconnect(); window.removeEventListener("resize", fit); };
  }, [projection.width, projection.height]);

  useEffect(() => {
    const output = canvas.current;
    if (!output) return;
    setError(null);
    const width = Math.max(1, Math.round(projection.width * resolution));
    const height = Math.max(1, Math.round(projection.height * resolution));
    output.width = width; output.height = height;
    delete output.dataset.frame;
    const context = output.getContext("2d");
    if (!context) { setError("This device cannot display effect frames."); return; }
    let worker: Worker;
    try { worker = new Worker(new URL("../lib/editor-effect-preview.worker.ts", import.meta.url), { type: "module" }); }
    catch { setError("The effects renderer could not start on this device."); return; }
    let destroyed = false, animation = 0, lastRequested = -1, previousFrame = -1, previousTick = 0, analysisEpoch = 0;
    let installedEpoch = 0, installingEpoch: number | null = null, pendingAnalysis: PreviewAnalysisInstall | null = null;
    let mappingKey: string | null = null, renderedProjection: EffectRenderProjection | null = null;
    let renderedDiscontinuity: number | undefined;
    let renderedUrlFor: typeof urlFor | null = null;
    let sentManifests: PreviewReactionSources["manifestsByKey"] | undefined;
    let pool: PreviewMediaPool;
    const queue = new PreviewFrameQueue(request => {
      try { worker.postMessage(request, request.pictures.map(picture => picture.pixels.buffer as ArrayBuffer)); }
      catch { queue.destroy(); setError("The effect frame could not be sent to the renderer."); }
    }, result => {
      // A new React commit can precede its install effect. Never paint the prior input in that gap.
      if (result.analysisEpoch !== analysisEpoch || renderedProjection !== currentProjection.current || renderedUrlFor !== currentUrlFor.current ||
        renderedDiscontinuity !== live.current.discontinuityRef?.current) return;
      if (result.error !== undefined) { setError(result.error); return; }
      const image = context.createImageData(result.width, result.height);
      image.data.set(result.pixels);
      context.putImageData(image, 0, 0);
      output.dataset.frame = String(result.absoluteFrame);
      output.dataset.generation = String(result.generation);
      output.dataset.renderer = currentProjection.current.rendererVersion;
      output.dataset.analysisEpoch = String(analysisEpoch);
      setError(null);
    });
    const onMessage = (event: MessageEvent<PreviewFrameResult | PreviewAnalysisResult>) => {
      if ("kind" in event.data) {
        if (event.data.analysisEpoch !== installingEpoch) return;
        installingEpoch = null;
        installedEpoch = event.data.analysisEpoch;
        if (event.data.analysisEpoch === analysisEpoch && event.data.error) setError(event.data.error);
        if (pendingAnalysis) flushAnalysis();
        else if (!event.data.error) render(performance.now());
      } else queue.receive(event.data);
    };
    const onError = () => { queue.destroy(); setError("The effects renderer stopped. Reload the preview to retry."); };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    const render = (nowMs: number) => {
      if (destroyed || installedEpoch !== analysisEpoch) return;
      const projection = currentProjection.current;
      const { timeRef } = live.current;
      const discontinuity = live.current.discontinuityRef?.current;
      if (renderedDiscontinuity !== discontinuity) {
        renderedDiscontinuity = discontinuity;
        queue.invalidate(); lastRequested = -1; delete output.dataset.frame;
        pool.discontinue();
      }
      const absoluteFrame = previewProductionFrame(projection, timeRef.current);
      // Playback can skip a display frame. A discontinuous seek invalidates an in-flight image.
      const expectedStep = Math.ceil(Math.max(0, nowMs - previousTick) * projection.frameRate / 1000) + 2;
      if (previousFrame >= 0 && (absoluteFrame < previousFrame || absoluteFrame - previousFrame > expectedStep)) { queue.invalidate(); lastRequested = -1; delete output.dataset.frame; }
      previousFrame = absoluteFrame; previousTick = nowMs;
      if (lastRequested === absoluteFrame) return;
      queue.request(() => {
        if (destroyed) return null;
        const projection = currentProjection.current;
        const at = previewProductionFrame(projection, live.current.timeRef.current);
        const layers = pictureStackAtFrame(projection, at);
        pool.retain(new Set(layers.filter(layer => layer.kind === "media").map(layer => layer.clipId)));
        const pictures: PreviewFrameRequest["pictures"] = [];
        let waiting = false;
        try {
          for (const layer of layers) {
            if (layer.kind === "slate") {
              const captured = pool.captureSlate(layer.label, width, height, resolution);
              if (!captured) { waiting = true; continue; }
              pictures.push({ id: layer.clipId, ...captured, effects: [], trackId: layer.trackId, weight: pictureTransitionWeight(layer, at), blendMode: layer.blendMode, opacity: layer.opacity });
              continue;
            }
            if (!layer.path) throw new Error(`Picture ${layer.label} has no media.`);
            const captured = pool.capture({ id: layer.clipId, path: layer.path, still: layer.still,
              sourceSec: layer.sourceInSec + (at - layer.startFrame) / projection.frameRate,
              ...(layer.sourceOutSec === undefined ? {} : { sourceOutSec: layer.sourceOutSec }),
            }, width, height, live.current.playing, nowMs, projection.frameRate);
            if (!captured) { waiting = true; continue; }
            pictures.push({ id: layer.clipId, ...captured, effects: effectsForPicture(projection, layer, at, true).map(row => row.effect), trackId: layer.trackId, weight: pictureTransitionWeight(layer, at), blendMode: layer.blendMode, opacity: layer.opacity });
          }
        } catch (failure) { setError(failure instanceof Error ? failure.message : "The picture could not be captured."); return null; }
        if (waiting) return null;
        lastRequested = at;
        return { absoluteFrame: at, frameRate: projection.frameRate, width, height, pictures, composition: effectsForPicture(projection, null, at, true).map(row => row.effect), analysisEpoch };
      });
    };
    const flushAnalysis = () => {
      if (destroyed || installingEpoch !== null || !pendingAnalysis) return;
      const input = pendingAnalysis;
      pendingAnalysis = null; installingEpoch = input.analysisEpoch;
      // A slider changes mapping metadata, not the long-song arrays already in this worker.
      const { manifestsByKey, ...mapping } = input;
      try {
        worker.postMessage(manifestsByKey === sentManifests ? mapping : input, []);
        sentManifests = manifestsByKey;
      }
      catch { installingEpoch = null; setError("The reaction could not be sent to the renderer."); }
    };
    pool = new PreviewMediaPool(output.ownerDocument, path => currentUrlFor.current(path), () => { if (!destroyed) { lastRequested = -1; render(performance.now()); } });
    install.current = () => {
      const sources = reactionSources.current;
      const projection = currentProjection.current;
      const nextKey = previewReactionMappingKey(projection.effectLayers.map(row => row.effect), sources, projection);
      if (renderedProjection !== projection || renderedUrlFor !== currentUrlFor.current) {
        renderedProjection = projection;
        renderedUrlFor = currentUrlFor.current;
        queue.invalidate(); lastRequested = -1; delete output.dataset.frame;
      }
      if (nextKey === mappingKey && sources.manifestsByKey === sentManifests) { render(performance.now()); return; }
      mappingKey = nextKey;
      analysisEpoch++; queue.invalidate(); lastRequested = -1; delete output.dataset.frame;
      pendingAnalysis = { kind: "analysis", analysisEpoch, effects: projection.effectLayers.map(row => row.effect),
        startFrame: projection.startFrame, endFrame: projection.endFrame, ...sources };
      flushAnalysis();
    };
    const tick = (nowMs: number) => {
      animation = 0;
      if (!live.current.playing) return;
      render(nowMs);
      animation = requestAnimationFrame(tick);
    };
    refresh.current = () => {
      if (!live.current.playing) { cancelAnimationFrame(animation); animation = 0; pool.pause(); queue.invalidate(); lastRequested = -1; delete output.dataset.frame; }
      render(performance.now());
      if (live.current.playing && !animation) animation = requestAnimationFrame(tick);
    };
    install.current();
    if (live.current.playing) animation = requestAnimationFrame(tick);
    return () => { destroyed = true; refresh.current = null; install.current = null; cancelAnimationFrame(animation); queue.destroy(); worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); worker.terminate(); pool.destroy(); };
  }, [projection.width, projection.height, resolution]);

  useEffect(() => { refresh.current?.(); }, [transport.time, transport.playing]);
  useEffect(() => { install.current?.(); }, [projection, reactions, urlFor]);

  return <div ref={host} className="fy-effectpreview">
    <div ref={stage} className="fy-effectpreview__stage">
      <canvas ref={canvas} className="fy-effectpreview__picture" aria-label="Picture and effects preview" />
      {children}
    </div>
    {error && <span className="fy-effectpreview__error" role="alert">Preview unavailable · {error}</span>}
  </div>;
}
