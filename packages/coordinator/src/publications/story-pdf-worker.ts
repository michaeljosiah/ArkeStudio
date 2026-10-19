import { parentPort, workerData } from "node:worker_threads";
import { renderStoryPdf } from "./story-pdf.js";

// The separately bundled PDF.js worker is loaded locally, never by a network URL. This is the
// parser's in-process worker shim, already isolated inside our terminable Node worker.
async function run() {
  const port = parentPort!;
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    port.postMessage({ kind: "memory", bytes: memory.heapUsed + memory.external }, []);
  }, 200);
  try {
    // PDF.js exposes this entry without TypeScript declarations.
    // @ts-expect-error upstream worker entry has no declaration file
    const parser = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = parser;
    const { document, options } = workerData as { document: Parameters<typeof renderStoryPdf>[0]; options: Parameters<typeof renderStoryPdf>[1] };
    const result = await renderStoryPdf(document, options, { onPhase: phase => port.postMessage({ kind: "phase", phase }, []) });
    port.postMessage({ kind: "result", result }, []);
  } catch (error) {
    port.postMessage({ kind: "error", error: error instanceof Error ? error.message : "The PDF could not be formatted." }, []);
  } finally { clearInterval(timer); port.close(); }
}
void run();
