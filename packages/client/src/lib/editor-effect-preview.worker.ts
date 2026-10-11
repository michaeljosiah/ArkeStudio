import { renderPreviewFrame, type PreviewFrameRequest, type PreviewFrameResult } from "./editor-preview-frame.js";

// This entry is bundled as a same-origin module worker; no eval, blob script or media access.
const worker = globalThis as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent<PreviewFrameRequest>) => void) => void;
  postMessage: (message: PreviewFrameResult, transfer: Transferable[]) => void;
};
worker.addEventListener("message", ({ data }) => {
  const identity = { id: data.id, generation: data.generation, absoluteFrame: data.absoluteFrame, width: data.width, height: data.height };
  try {
    const pixels = renderPreviewFrame(data);
    worker.postMessage({ ...identity, pixels }, [pixels.buffer as ArrayBuffer]);
  } catch (error) {
    worker.postMessage({ ...identity, error: error instanceof Error ? error.message : "The effect frame could not be rendered." }, []);
  }
});
