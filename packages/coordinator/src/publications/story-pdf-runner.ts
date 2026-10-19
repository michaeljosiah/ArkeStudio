import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { renderStoryPdf } from "./story-pdf.js";

type Render = typeof renderStoryPdf;
type Result = Awaited<ReturnType<Render>>;
type Control = NonNullable<Parameters<Render>[2]>;
export const STORY_PDF_WORKER_LIMITS = Object.freeze({ timeoutMs: 120_000, memoryBytes: 512 * 1024 ** 2 });

/** A hung layout or parser must not hold the world coordinator or survive cancellation. */
export function createStoryPdfRunner(host: { workerPath?: string | URL; timeoutMs?: number } = {}): Render {
  return async (document, options, control = {}) => {
    if (control.signal?.aborted) throw new Error("PDF preparation cancelled.");
    const source = import.meta.url.endsWith(".ts");
    // Node's ESM worker loader reads real files. Electron keeps the adjacent worker/fonts
    // unpacked; do not depend on its main-thread virtual asar filesystem patches.
    const base = import.meta.url.replace(/\/app\.asar\//, "/app.asar.unpacked/");
    const path = host.workerPath ?? new URL(source ? "./story-pdf-worker.ts" : "./story-pdf-worker.mjs", base);
    // Register inside the worker: inheriting the main thread's --import tsx does not register
    // TypeScript loading for a worker entry on every supported Node release.
    const bootstrap = source && !host.workerPath
      ? `require(${JSON.stringify(createRequire(import.meta.url).resolve("tsx/cjs"))}); require(${JSON.stringify(fileURLToPath(new URL(path)))});`
      : undefined;
    let worker: Worker;
    try {
      worker = new Worker(bootstrap ?? path, { ...(bootstrap ? { eval: true } : {}),
        workerData: { document, options }, execArgv: [], stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 } });
    } catch { throw new Error("The PDF renderer is unavailable. Repair the application installation and prepare a new preview."); }
    // Optional parser diagnostics can contain module paths. Only the structured, user-facing
    // result crosses this boundary; drain both streams to keep warnings from blocking work.
    worker.stdout?.resume(); worker.stderr?.resume();
    return await new Promise<Result>((resolve, reject) => {
      let settled = false;
      let received = false;
      let progress = Promise.resolve();
      const finish = (error?: Error, result?: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        control.signal?.removeEventListener("abort", abort);
        // Resolve only after termination so callers can safely drain jobs during shutdown.
        void worker.terminate().then(() => error ? reject(error) : resolve(result!), () => reject(error ?? new Error("The PDF renderer could not stop.")));
      };
      const abort = () => finish(new Error("PDF preparation cancelled."));
      const timeout = Math.max(1, Math.min(STORY_PDF_WORKER_LIMITS.timeoutMs, host.timeoutMs ?? STORY_PDF_WORKER_LIMITS.timeoutMs));
      const timer = setTimeout(() => finish(new Error("PDF formatting exceeded its 120-second resource limit. Choose fewer chapters and prepare a new preview.")), timeout);
      worker.on("message", (message: { kind: string; phase?: Parameters<NonNullable<Control["onPhase"]>>[0]; result?: Result; error?: string; bytes?: number }) => {
        if (settled) return;
        if (message.kind === "phase" && message.phase) {
          progress = progress.then(async () => { if (!settled) await control.onPhase?.(message.phase!); });
          void progress.catch(() => finish(new Error(control.signal?.aborted ? "PDF preparation cancelled." : "PDF preparation could not report progress.")));
        } else if (message.kind === "memory" && typeof message.bytes === "number") {
          if (message.bytes > STORY_PDF_WORKER_LIMITS.memoryBytes) finish(new Error("PDF formatting exceeded its 512 MiB memory budget. Choose fewer chapters and prepare a new preview."));
        } else if (message.kind === "result" && message.result) {
          received = true;
          const result = { ...message.result, bytes: Buffer.from(message.result.bytes) };
          void progress.then(() => finish(undefined, result), () => {});
        } else if (message.kind === "error") finish(new Error(message.error ?? "The PDF could not be formatted."));
        else finish(new Error("The PDF renderer returned a damaged response."));
      });
      worker.on("error", (error: NodeJS.ErrnoException) => finish(new Error(error.code === "ERR_WORKER_OUT_OF_MEMORY"
        ? "PDF formatting exceeded its memory budget. Choose fewer chapters and prepare a new preview."
        : "The PDF renderer stopped unexpectedly. Repair the application installation and retry.")));
      worker.on("exit", () => { if (!settled && !received) finish(new Error("The PDF renderer stopped before completing validation.")); });
      control.signal?.addEventListener("abort", abort, { once: true });
      if (control.signal?.aborted) abort();
    });
  };
}

export const renderStoryPdfBounded = createStoryPdfRunner();
