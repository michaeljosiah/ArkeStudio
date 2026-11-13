import { parentPort, workerData } from "node:worker_threads";
import { decodePng, encodePng } from "./png.js";
import { composeLocationSheet } from "./location-sheet.js";
import type { PngRequest } from "./png-runner.js";

const request = workerData as PngRequest;
try {
  const result = request.kind === "decode" ? decodePng(request.bytes, request.maxPixels)
    : request.kind === "encode" ? encodePng(request.image, request.options)
    : composeLocationSheet(request.panels);
  parentPort!.postMessage({ result });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : "PNG processing failed" });
}
