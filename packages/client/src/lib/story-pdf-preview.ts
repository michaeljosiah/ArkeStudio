import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export interface StoryPdfPreviewDocument {
  pageCount: number;
  render(page: number, width: number, zoom: number, canvas: HTMLCanvasElement, text: HTMLDivElement, signal: AbortSignal): Promise<void>;
  destroy(): Promise<void>;
}

/** SPEC-058 R-19: only pixels and text are exposed, never PDF actions, attachments or viewer Save. */
export async function loadStoryPdfPreview(url: string, signal: AbortSignal): Promise<StoryPdfPreviewDocument> {
  const response = await fetch(url, { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error("The captured PDF is unavailable. Recheck the edition.");
  const data = await response.arrayBuffer();
  if (data.byteLength > 100 * 1024 * 1024) throw new Error("This PDF exceeds the preview size limit.");
  const task = getDocument({ data, isEvalSupported: false, useSystemFonts: false, enableXfa: false, stopAtErrors: true });
  const abort = () => { void task.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const document = await task.promise;
    if (signal.aborted) { await task.destroy(); throw new DOMException("Cancelled", "AbortError"); }
    let rendering: Promise<void> = Promise.resolve();
    return {
      pageCount: document.numPages,
      render(number, width, zoom, canvas, text, renderSignal) {
        // A cancelled PDF.js render releases its canvas asynchronously. Serializing protects
        // rapid page/zoom changes from drawing a stale page over the newest selection.
        const next = rendering.catch(() => {}).then(async () => {
          if (renderSignal.aborted) return;
          const page = await document.getPage(number);
          if (renderSignal.aborted) return;
          const scale = Math.max(1, width) / page.getViewport({ scale: 1 }).width * zoom;
          const viewport = page.getViewport({ scale });
          const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.ceil(viewport.width * pixelRatio); canvas.height = Math.ceil(viewport.height * pixelRatio);
          canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
          text.replaceChildren(); text.style.setProperty("--total-scale-factor", String(scale));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("PDF drawing is unavailable in this browser.");
          const drawing = page.render({ canvas, canvasContext: context, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0], background: "white" });
          const layer = new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
          const cancel = () => { drawing.cancel(); layer.cancel(); };
          renderSignal.addEventListener("abort", cancel, { once: true });
          try { await Promise.all([drawing.promise, layer.render()]); }
          finally { renderSignal.removeEventListener("abort", cancel); page.cleanup(); }
          });
        rendering = next;
        return next;
      },
      async destroy() { signal.removeEventListener("abort", abort); await task.destroy(); },
    };
  } catch (error) { signal.removeEventListener("abort", abort); await task.destroy(); throw error; }
}
