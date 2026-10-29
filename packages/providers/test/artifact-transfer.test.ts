import assert from "node:assert/strict";
import { it } from "node:test";
import { ARTIFACT_RESULT_LIMITS, artifactResultReadLimit } from "@arke-studio/contracts";
import { readArtifactBody } from "../src/clients/artifact-body.js";
import { FalClient } from "../src/clients/fal.js";
import { ProviderArtifactLimitError } from "../src/types.js";

function streamed(chunks: number[][], headers?: HeadersInit) {
  let reads = 0, cancels = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { const chunk = chunks[reads++]; if (chunk) controller.enqueue(Uint8Array.from(chunk)); else controller.close(); },
    cancel() { cancels++; },
  }, { highWaterMark: 0 }), { headers });
  return { response, reads: () => reads, cancels: () => cancels };
}

it("refuses an advertised oversized file without reading its body and cancels the original stream", async () => {
  const h = streamed([[1]], { "content-length": "5" });
  await assert.rejects(readArtifactBody(h.response, 4), ProviderArtifactLimitError);
  assert.equal(h.reads(), 0); assert.equal(h.cancels(), 1);
});
it("bounds actual chunks when length is absent or compressed, and applies the aggregate remainder", async () => {
  for (const headers of [undefined, { "content-length": "1", "content-encoding": "gzip" }]) {
    const h = streamed([[1, 2], [3, 4]], headers);
    await assert.rejects(readArtifactBody(h.response, artifactResultReadLimit(ARTIFACT_RESULT_LIMITS.maxTotalBytes - 3)), ProviderArtifactLimitError);
    assert.equal(h.reads(), 2); assert.equal(h.cancels(), 1);
  }
  const exact = streamed([[1], [2, 3]], { "content-length": "3" });
  assert.deepEqual([...await readArtifactBody(exact.response, 3)], [1, 2, 3]);
  assert.deepEqual([...await readArtifactBody(streamed([[4]], { "content-length": "0001" }).response, 1)], [4]);
});
it("refuses malformed, short and understated identity lengths without publishing partial output", async () => {
  for (const [length, chunks] of [["-1", [[1]]], ["3", [[1, 2]]], ["1", [[1, 2]]]] as const) {
    const h = streamed(chunks.map(chunk => [...chunk]), { "content-length": length });
    await assert.rejects(readArtifactBody(h.response, 4), /length/);
  }
});
it("bounds non-advancing stream fragments even though they consume no byte budget", async () => {
  let reads = 0, cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array()); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  await assert.rejects(readArtifactBody(response, 1), ProviderArtifactLimitError);
  assert.equal(reads, ARTIFACT_RESULT_LIMITS.maxReadChunks); assert.equal(cancelled, true);
});
it("abandoning a stalled original read on cancel cannot return its later bytes", async () => {
  const abort = new AbortController(); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const response = new Response(new ReadableStream({ async pull(controller) {
    entered(); await new Promise<void>(resolve => { release = resolve; });
    try { controller.enqueue(new Uint8Array([1])); controller.close(); } catch { /* Original cancellation already closed it. */ }
  } }, { highWaterMark: 0 }));
  const reading = readArtifactBody(response, 1, abort.signal);
  await ready; abort.abort(new Error("stopped")); await assert.rejects(reading, /stopped/); release();
});

const remoteId = "fal-ai/flux-2-pro::accepted-one";
it("FAL bounds remote metadata and rejects too many result files before media requests", async () => {
  for (const metadata of ["oversized", "many", "mixed"] as const) {
    let calls = 0;
    const client = new FalClient(async () => {
      calls++;
      if (metadata === "oversized") return new Response(new Uint8Array(ARTIFACT_RESULT_LIMITS.maxRemoteMetadataBytes + 1));
      const images = Array.from({ length: metadata === "many" ? ARTIFACT_RESULT_LIMITS.maxFiles + 1 : ARTIFACT_RESULT_LIMITS.maxFiles }, () => ({ url: "https://assets.test/file" }));
      return Response.json({ images, ...(metadata === "mixed" ? { audio: { url: "https://assets.test/audio" } } : {}) });
    });
    await assert.rejects(client.fetchArtifacts("private-key", remoteId), ProviderArtifactLimitError); assert.equal(calls, 1);
  }
});
it("FAL rejects HTTP errors and oversized media, cancels the transfer and sends no credential to asset URLs", async () => {
  for (const mode of ["http-error", "large"] as const) {
    let calls = 0, signal: AbortSignal | undefined;
    const client = new FalClient(async (_url, init) => {
      calls++;
      if (calls === 1) return Response.json({ images: [{ url: "https://assets.test/signed-file", content_type: "image/png" }] });
      assert.equal(init?.headers, undefined); signal = init?.signal ?? undefined;
      return mode === "http-error" ? new Response("not an image", { status: 503 }) : streamed([[1]], { "content-length": String(ARTIFACT_RESULT_LIMITS.maxFileBytes + 1) }).response;
    });
    await assert.rejects(client.fetchArtifacts("private-key", remoteId), mode === "large" ? ProviderArtifactLimitError : /HTTP 503/);
    assert.equal(calls, 2); assert.equal(signal?.aborted, true);
  }
});
it("FAL forwards host cancellation to metadata/media, stops after cancellation and preserves completed bytes", async () => {
  const abort = new AbortController(); let calls = 0;
  const client = new FalClient(async (_url, init) => {
    calls++; assert(init?.signal);
    if (calls === 1) return Response.json({ images: [{ url: "https://assets.test/one", content_type: "image/png" }, { url: "https://assets.test/two" }] });
    abort.abort(new Error("stop retrieval")); return new Response(new Uint8Array([1]));
  });
  await assert.rejects(client.fetchArtifacts("key", remoteId, { jobId: "one" }, { signal: abort.signal }), /stop retrieval/);
  assert.equal(calls, 2);
  const successful = new FalClient(async url => url.includes("/requests/")
    ? Response.json({ audio: { url: "https://assets.test/audio", content_type: "audio/wav" } }) : streamed([[1], [2, 3]]).response);
  assert.deepEqual((await successful.fetchArtifacts("key", remoteId))[0], { name: "output-1.wav", contentType: "audio/wav", data: new Uint8Array([1, 2, 3]) });
});
