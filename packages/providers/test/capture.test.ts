import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureProviderClient } from "../src/capture.js";
import type { ProviderCallCapture, ProviderClient } from "../src/types.js";

function recorder() {
  const started: Parameters<ProviderCallCapture["start"]>[0][] = [];
  const finished: Parameters<ProviderCallCapture["finish"]>[1][] = [];
  const failed: unknown[] = [];
  const capture: ProviderCallCapture = {
    async start(input) {
      started.push(input);
      return `pc_${"0".repeat(26)}`;
    },
    async finish(_id, input) {
      finished.push(input);
    },
    async fail(_id, error) {
      failed.push(error);
    },
  };
  return { capture, started, finished, failed };
}

function client(fetchImpl: typeof fetch): ProviderClient {
  return {
    id: "openai",
    declarations: {
      supportsIdempotencyKey: false,
      supportsLookupByKey: false,
      supportsListRecent: false,
      reportsCost: false,
    },
    validateKey: async () => [],
    submit: async (_key, request) => {
      const form = new FormData();
      form.append("model", request.model);
      form.append("prompt", String(request.params["prompt"]));
      form.append("image[]", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "face.png");
      await fetchImpl("https://api.openai.com/v1/images/edits?secret=signed", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "X-Api-Key": "secret" },
        body: form,
      });
      return { remoteId: "remote", acceptedAt: new Date().toISOString() };
    },
    poll: async () => ({ state: "succeeded" }),
    fetchArtifacts: async () => [],
    cancel: async () => {},
  };
}

describe("provider call capture", () => {
  it("captures effective multipart fields and media metadata without credentials", async () => {
    const seen = recorder();
    const wrapped = captureProviderClient(
      "openai",
      (observed) => client(observed),
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: "A".repeat(5000) }] }), {
          status: 200,
          headers: { "content-type": "application/json", "x-request-id": "req-1", "set-cookie": "secret" },
        }),
      seen.capture,
    );
    await wrapped.submit(
      "secret",
      { model: "gpt-image-2", capability: "image", params: { prompt: "portrait" } },
      { jobId: `jb_${"0".repeat(26)}`, attempt: 2, model: "gpt-image-2" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(seen.started[0]?.operation, "submit");
    assert.equal(seen.started[0]?.endpoint, "https://api.openai.com/v1/images/edits");
    assert.deepEqual(seen.started[0]?.headers, {});
    const request = seen.started[0]?.body as { multipart: Array<Record<string, unknown>> };
    assert.equal(request.multipart[1]?.value, "portrait");
    assert.equal(request.multipart[2]?.sizeBytes, 3);
    assert.match(String(request.multipart[2]?.sha256), /^sha256:/);
    assert.deepEqual(seen.finished[0]?.headers, {
      "content-type": "application/json",
      "x-request-id": "req-1",
    });
    const response = seen.finished[0]?.body as {
      data: Array<{ b64_json: { binary: boolean; sha256: string } }>;
    };
    assert.equal(response.data[0]?.b64_json.binary, true);
    assert.match(response.data[0]!.b64_json.sha256, /^sha256:/);
    assert.equal(seen.failed.length, 0);
  });

  it("records a nested transport failure when no response is witnessed", async () => {
    const seen = recorder();
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const wrapped = captureProviderClient(
      "openai",
      (observed) => client(observed),
      async () => {
        throw new TypeError("fetch failed", { cause });
      },
      seen.capture,
    );
    await assert.rejects(() =>
      wrapped.submit("secret", { model: "gpt-image-2", capability: "image", params: { prompt: "portrait" } }),
    );
    assert.equal(seen.finished.length, 0);
    assert.equal(seen.failed.length, 1);
  });
});
