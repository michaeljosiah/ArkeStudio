import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureProviderClient } from "../src/capture.js";
import { ProviderTransportError } from "../src/transport.js";
import type {
  CommandRunner,
  ProviderCallCapture,
  ProviderClient,
  ProviderTransport,
  ProviderTransportScope,
} from "../src/types.js";

function fetchFailed(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

function recorder() {
  const started: Parameters<ProviderCallCapture["start"]>[0][] = [];
  const responded: Parameters<ProviderCallCapture["respond"]>[1][] = [];
  const finished: Parameters<ProviderCallCapture["finish"]>[1][] = [];
  const failed: Array<{ error: unknown; diagnostic: Parameters<ProviderCallCapture["fail"]>[2] }> = [];
  const tracked = new Set<Promise<void>>();
  const capture: ProviderCallCapture = {
    track(task) {
      tracked.add(task);
      void task.finally(() => tracked.delete(task)).catch(() => {});
    },
    async start(input) {
      started.push(input);
      return `pc_${"0".repeat(26)}`;
    },
    async finish(_id, input) {
      finished.push(input);
    },
    async respond(_id, input) {
      responded.push(input);
    },
    async fail(_id, error, diagnostic) {
      failed.push({ error, diagnostic });
    },
  };
  return { capture, started, responded, finished, failed, drain: () => Promise.allSettled(tracked) };
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
    await seen.drain();
    assert.equal(seen.started[0]?.operation, "submit");
    assert.equal(seen.started[0]?.endpoint, "https://api.openai.com/v1/images/edits");
    assert.deepEqual(seen.started[0]?.headers, {});
    const request = seen.started[0]?.body as { multipart: Array<Record<string, unknown>> };
    assert.equal(request.multipart[1]?.value, "portrait");
    assert.equal(request.multipart[2]?.sizeBytes, 3);
    assert.match(String(request.multipart[2]?.sha256), /^sha256:/);
    assert.equal(seen.responded[0]?.status, 200);
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
    assert.equal(seen.failed[0]?.diagnostic?.category, "connection-reset");
    assert.equal(seen.failed[0]?.diagnostic?.code, "ECONNRESET");
  });

  it("records that response headers were witnessed when the body transport then fails", async () => {
    const seen = recorder();
    const bodyFailure = fetchFailed("UND_ERR_BODY_TIMEOUT");
    const wrapped = captureProviderClient(
      "openai",
      (observed) => client(observed),
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(bodyFailure);
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      seen.capture,
    );
    await wrapped.submit("secret", { model: "gpt-image-2", capability: "image", params: { prompt: "portrait" } });
    await seen.drain();
    assert.equal(seen.responded[0]?.status, 200);
    assert.equal(seen.failed[0]?.diagnostic?.category, "body-timeout");
  });

  it("records an operation deadline after diagnostic capture gives up", async () => {
    const seen = recorder();
    const bodyFailure = fetchFailed("UND_ERR_BODY_TIMEOUT");
    const delayedFetch: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(() => controller.error(bodyFailure), 5_200);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const transport: ProviderTransport = {
      run(_scope, operation) {
        const running = operation(delayedFetch);
        return Promise.race([
          running,
          new Promise<never>((_resolve, reject) => {
            setTimeout(
              () =>
                reject(
                  new ProviderTransportError(new Error("deadline"), {
                    category: "configured-deadline",
                    deadline: { kind: "operation", ms: 5_100 },
                  }),
                ),
              5_100,
            );
          }),
        ]);
      },
    };
    const wrapped = captureProviderClient(
      "openai",
      (observed) => {
        const base = client(observed);
        return {
          ...base,
          submit: async () => {
            const response = await observed("https://api.openai.com/v1/images/generations");
            await response.text();
            throw new Error("unreachable");
          },
        };
      },
      async () => {
        throw new Error("the host transport was bypassed");
      },
      seen.capture,
      undefined,
      transport,
    );
    await assert.rejects(() =>
      wrapped.submit("secret", { model: "gpt-image-2", capability: "image", params: { prompt: "portrait" } }),
    );
    await seen.drain();
    assert.equal(seen.finished.length, 0);
    assert.equal(seen.failed[0]?.diagnostic?.category, "configured-deadline");
  });

  it("exposes operation and capability to host policy even when payload capture is disabled", async () => {
    const scopes: ProviderTransportScope[] = [];
    const transport: ProviderTransport = {
      run(scope, operation) {
        scopes.push(scope);
        return operation(async () => new Response("", { status: 200 }));
      },
    };
    const wrapped = captureProviderClient(
      "openai",
      (observed) => client(observed),
      async () => {
        throw new Error("the host transport was bypassed");
      },
      undefined,
      undefined,
      transport,
    );
    await wrapped.submit("secret", { model: "gpt-image-2", capability: "image", params: { prompt: "portrait" } });
    assert.deepEqual(scopes, [{ provider: "openai", operation: "submit", model: "gpt-image-2", capability: "image" }]);
  });

  it("keeps diagnostic persistence off the public provider result path", async () => {
    let tracked = false;
    const capture: ProviderCallCapture = {
      track() {
        tracked = true;
      },
      start: async () => `pc_${"0".repeat(26)}`,
      respond: () => new Promise<void>(() => {}),
      finish: async () => {},
      fail: async () => {},
    };
    const wrapped = captureProviderClient(
      "openai",
      (observed) => client(observed),
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      capture,
    );
    const result = await wrapped.submit("secret", {
      model: "gpt-image-2",
      capability: "image",
      params: { prompt: "portrait" },
    });
    assert.equal(result.remoteId, "remote");
    assert.equal(tracked, true);
  });
});

/**
 * A provider driven as a subprocess (issue 137). Without this the payload history has no rows
 * for Higgsfield at all: submit and poll leave no trace, and the only calls that would ever
 * appear are the artifact downloads at the very end of a job.
 */
describe("subprocess calls are captured like HTTP ones", () => {
  const cliClient = (run: CommandRunner): ProviderClient => ({
    id: "higgsfield",
    declarations: {
      supportsIdempotencyKey: false,
      supportsLookupByKey: false,
      supportsListRecent: false,
      reportsCost: false,
    },
    validateKey: async () => [],
    submit: async (_key, request) => {
      await run(["generate", "create", request.model, "--prompt", String(request.params["prompt"]), "--json"]);
      return { remoteId: "job-1", acceptedAt: "2026-08-07T00:00:00.000Z" };
    },
    poll: async () => ({ state: "running" }),
    fetchArtifacts: async () => [],
    cancel: async () => {},
  });

  it("records the subcommand path, the arguments, and the exit code", async () => {
    const seen = recorder();
    const wrapped = captureProviderClient(
      "higgsfield",
      (_fetch, run) => cliClient(run),
      async () => new Response("{}", { status: 200 }),
      seen.capture,
      async () => ({ code: 0, stdout: JSON.stringify({ id: "job-1", status: "queued" }), stderr: "" }),
    );
    await wrapped.submit("", {
      model: "text2image_soul_v2",
      capability: "image",
      params: { prompt: "a quiet beach" },
    });
    assert.equal(seen.started[0]?.method, "EXEC");
    // The path stops at the first flag; the values belong in the body, as with a URL and its
    // payload.
    assert.equal(seen.started[0]?.endpoint, "generate create text2image_soul_v2");
    assert.deepEqual((seen.started[0]!.body as { args: string[] }).args.slice(0, 3), [
      "generate",
      "create",
      "text2image_soul_v2",
    ]);
    assert.equal(seen.started[0]?.operation, "submit");
    // An exit code, never a synthetic HTTP status: 0 is not 200.
    assert.equal(seen.finished[0]?.exitCode, 0);
    assert.equal(seen.finished[0]?.status, undefined);
    // JSON stdout is parsed so the store's sanitiser can walk it rather than meeting one
    // opaque string.
    assert.deepEqual((seen.finished[0]!.body as { stdout: unknown }).stdout, { id: "job-1", status: "queued" });
  });

  it("keeps a non-zero exit apart from a process that never ran", async () => {
    const rejected = recorder();
    await captureProviderClient(
      "higgsfield",
      (_fetch, run) => cliClient(run),
      async () => new Response("{}", { status: 200 }),
      rejected.capture,
      async () => ({ code: 1, stdout: "", stderr: "Session expired" }),
    ).submit("", { model: "m", capability: "image", params: { prompt: "x" } });
    // The provider answered, and its answer was no: that is a finished call with a reason.
    assert.equal(rejected.finished[0]?.exitCode, 1);
    assert.equal((rejected.finished[0]!.body as { stderr?: string }).stderr, "Session expired");
    assert.equal(rejected.failed.length, 0);

    const unspawnable = recorder();
    await captureProviderClient(
      "higgsfield",
      (_fetch, run) => cliClient(run),
      async () => new Response("{}", { status: 200 }),
      unspawnable.capture,
      async () => ({ code: null, stdout: "", stderr: "the Higgsfield CLI is not installed on this machine" }),
    ).submit("", { model: "m", capability: "image", params: { prompt: "x" } });
    // No exit status means nothing was rejected — the call never happened, which is a
    // transport failure and must not be filed as the provider refusing the work.
    assert.equal(unspawnable.finished.length, 0);
    assert.equal(unspawnable.failed.length, 1);
  });
});

it("summarizes JSON media arrays and nested data URIs without changing provider bytes", async () => {
  const seen = recorder();
  const data = Buffer.from([1, 2, 3, 4]);
  const uri = `data:audio/wav;base64,${data.toString("base64")}`;
  const payload = JSON.stringify({ prompt: "Speak the new line", audio_urls: [uri], nested: { arbitrary: uri },
    image: `data:image/png;base64,${data.toString("base64")}`, video: `data:video/mp4;base64,${data.toString("base64")}` });
  let physical = "";
  const wrapped = captureProviderClient("openai", observed => ({ ...client(observed),
    async submit() { await observed("https://example.com/generate", { method: "POST", body: payload });
      return { remoteId: "one", acceptedAt: new Date().toISOString() }; } }),
    async (_url, init) => { physical = String(init?.body); return new Response(payload, { headers: { "content-type": "application/json" } }); }, seen.capture);
  await wrapped.submit("key", { model: "test", capability: "video", params: {} });
  await seen.drain();
  assert.equal(physical, payload);
  const captured = seen.started[0]!.body as { audio_urls: Array<{ contentType: string; sizeBytes: number; sha256: string }> };
  assert.equal(captured.audio_urls[0]!.contentType, "audio/wav");
  assert.equal(captured.audio_urls[0]!.sizeBytes, 4);
  assert.equal(captured.audio_urls[0]!.sha256, "sha256:9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a");
  assert.ok(!JSON.stringify([seen.started, seen.finished]).includes(uri));
  assert.ok(JSON.stringify(seen.started).includes("Speak the new line"));
});

it("capture storage failure cannot block or repeat physical submission", async () => {
  const seen = recorder();
  seen.capture.start = async () => { throw new Error("capture too large"); };
  let submitted = 0;
  const wrapped = captureProviderClient("openai", observed => client(observed), async () => { submitted++; return new Response("{}"); }, seen.capture);
  await wrapped.submit("key", { model: "test", capability: "image", params: { prompt: "portrait" } });
  assert.equal(submitted, 1);
});
