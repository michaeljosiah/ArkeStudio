import { parentPort, workerData } from "node:worker_threads";
import { renderEffectLayersRgba, type EffectClip } from "@arke-studio/contracts";

/** Bundled as a separate entry: the worker executes the same pure renderer as browser preview. */
const job = workerData as { effects: EffectClip[]; frameRate: number; width: number; height: number };
parentPort?.on("message", (request: { id: number; absoluteFrame: number }) => {
  try {
    const pixels = renderEffectLayersRgba(job.effects, request.absoluteFrame, job.frameRate, job.width, job.height);
    parentPort!.postMessage({ id: request.id, pixels: pixels.buffer }, [pixels.buffer as ArrayBuffer]);
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : "effect raster failed" }, []);
  }
});
