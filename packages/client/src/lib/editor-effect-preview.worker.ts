import { PreviewReactionBank, type PreviewAnalysisInstall, type PreviewAnalysisResult, type PreviewFrameRequest, type PreviewFrameResult } from "./editor-preview-frame.js";

// This entry is bundled as a same-origin module worker; no eval, blob script or media access.
const worker = globalThis as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent<PreviewFrameRequest | PreviewAnalysisInstall>) => void) => void;
  postMessage: (message: PreviewFrameResult | PreviewAnalysisResult, transfer: Transferable[]) => void;
};
const reactions = new PreviewReactionBank();
worker.addEventListener("message", ({ data }) => {
  if ("kind" in data && data.kind === "analysis") {
    try { reactions.install(data); worker.postMessage({ kind: "analysis-ready", analysisEpoch: data.analysisEpoch }, []); }
    catch (error) { worker.postMessage({ kind: "analysis-ready", analysisEpoch: data.analysisEpoch, error: error instanceof Error ? error.message : "The reaction could not be prepared." }, []); }
    return;
  }
  const request = data as PreviewFrameRequest;
  const identity = { id: request.id, generation: request.generation, absoluteFrame: request.absoluteFrame, width: request.width, height: request.height, analysisEpoch: request.analysisEpoch };
  try {
    const pixels = reactions.render(request);
    worker.postMessage({ ...identity, pixels }, [pixels.buffer as ArrayBuffer]);
  } catch (error) {
    worker.postMessage({ ...identity, error: error instanceof Error ? error.message : "The effect frame could not be rendered." }, []);
  }
});
