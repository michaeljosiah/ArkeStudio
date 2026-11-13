import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { RgbaImage } from "./png.js";
import type { LocationSheet, LocationSheetPanel } from "./location-sheet.js";

export type PngRequest =
  | { kind: "decode"; bytes: Uint8Array; maxPixels?: number }
  | { kind: "encode"; image: RgbaImage; options: { level?: number } }
  | { kind: "location-sheet"; panels: readonly LocationSheetPanel[] };

/** One CPU task at a time; each worker is terminated before its caller resumes. No idle thread
 * or untracked shutdown work. Keep the synchronous codec for small callers and compatibility. */
export function createPngRunner(host: { workerPath?: string | URL; timeoutMs?: number } = {}) {
  let running = false;
  const waiting: Array<() => void> = [];
  async function run<T>(request: PngRequest, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (running) {
      if (waiting.length >= 32) throw new Error("PNG processing queue is full. Try again shortly.");
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => { waiting.splice(waiting.indexOf(ready), 1); reject(signal!.reason); };
        waiting.push(ready);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    running = true;
    try {
      signal?.throwIfAborted();
      const source = import.meta.url.endsWith(".ts");
      const base = import.meta.url.replace(/\/app\.asar\//, "/app.asar.unpacked/");
      const path = host.workerPath ?? new URL(source ? "./png-worker.ts" : "./png-worker.mjs", base);
      // Match the PDF worker's source loader; shipped builds use the adjacent, unpacked bundle.
      const bootstrap = source && !host.workerPath
        ? `require(${JSON.stringify(createRequire(import.meta.url).resolve("tsx/cjs"))}); require(${JSON.stringify(fileURLToPath(new URL(path)))});`
        : undefined;
      const worker = new Worker(bootstrap ?? path, { ...(bootstrap ? { eval: true } : {}),
        workerData: request, execArgv: [], stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
      worker.stdout?.resume(); worker.stderr?.resume();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        return await new Promise<T>((resolve, reject) => {
          abort = () => reject(signal!.reason);
          signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => reject(new Error("PNG processing exceeded its time limit.")),
            Math.max(1, Math.min(30_000, host.timeoutMs ?? 30_000)));
          worker.once("message", (message: { result: T; error?: string }) => {
            if (message.error !== undefined) reject(new Error(message.error)); else resolve(message.result);
          });
          worker.once("error", reject);
          worker.once("exit", () => reject(new Error("PNG worker stopped before completing its image.")));
          if (signal?.aborted) abort();
        });
      } finally {
        clearTimeout(timer);
        if (abort) signal?.removeEventListener("abort", abort);
        await worker.terminate();
      }
    } finally {
      const next = waiting.shift();
      if (next) next(); else running = false;
    }
  }
  return {
    decode: (bytes: Uint8Array, maxPixels?: number, signal?: AbortSignal) => run<RgbaImage>({ kind: "decode", bytes, ...(maxPixels === undefined ? {} : { maxPixels }) }, signal),
    encode: (image: RgbaImage, options: { level?: number } = {}, signal?: AbortSignal) => run<Uint8Array>({ kind: "encode", image, options }, signal),
    locationSheet: (panels: readonly LocationSheetPanel[], signal?: AbortSignal) => run<LocationSheet>({ kind: "location-sheet", panels }, signal),
  };
}

const png = createPngRunner();
export const decodePngAsync = png.decode;
export const encodePngAsync = png.encode;
export const composeLocationSheetAsync = png.locationSheet;
