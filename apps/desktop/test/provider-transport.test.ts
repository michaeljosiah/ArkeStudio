import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderTransportPolicy } from "@arke-studio/contracts";
import {
  captureProviderClient,
  ProviderTransportError,
  type FetchLike,
  type ProviderCallCapture,
  type ProviderClient,
  type ProviderTransportScope,
} from "@arke-studio/providers";
import { Agent } from "undici";
import {
  CloudProviderTransport,
  PROVIDER_HTTP_DEADLINES,
  providerHttpProfile,
  type ProviderHttpDeadlines,
} from "../src/provider-transport.js";

const scope = (over: Partial<ProviderTransportScope> = {}): ProviderTransportScope => ({
  provider: "openai",
  operation: "submit",
  capability: "image",
  model: "gpt-image-2",
  ...over,
});

function waitsForAbort(): FetchLike {
  return async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

describe("desktop cloud provider HTTP policy (issue 95)", () => {
  it("selects distinct validation, control, enqueue, synchronous, and artifact profiles", () => {
    assert.equal(providerHttpProfile(scope({ operation: "validate" })), "validation");
    assert.equal(providerHttpProfile(scope({ operation: "poll" })), "control");
    assert.equal(providerHttpProfile(scope({ provider: "fal", operation: "submit" })), "enqueue");
    assert.equal(providerHttpProfile(scope()), "synchronous");
    assert.equal(providerHttpProfile(scope({ operation: "fetch-artifacts" })), "artifact");
    assert.ok(PROVIDER_HTTP_DEADLINES.synchronous.headersMs > PROVIDER_HTTP_DEADLINES.validation.headersMs);
    assert.ok(PROVIDER_HTTP_DEADLINES.artifact.bodyMs > PROVIDER_HTTP_DEADLINES.validation.bodyMs);
  });

  it("uses a direct Node/Undici dispatcher carrying every explicit deadline", async () => {
    const policies: ProviderTransportPolicy[] = [];
    let requestInit: RequestInit | undefined;
    const dispatcher = { close: async () => {} };
    const transport = new CloudProviderTransport({
      runtime: "v22.test",
      dispatcher: (policy) => {
        policies.push(policy);
        return dispatcher;
      },
      fetch: async (_url, init) => {
        requestInit = init;
        return new Response("{}", { status: 200 });
      },
    });
    await transport.run(scope(), (fetch) => fetch("https://api.openai.com/v1/images/generations"));
    assert.deepEqual(policies, [
      {
        implementation: "node-undici",
        runtime: "v22.test",
        proxyMode: "direct",
        ...PROVIDER_HTTP_DEADLINES.synchronous,
      },
    ]);
    assert.equal((requestInit as RequestInit & { dispatcher?: unknown }).dispatcher, dispatcher);
    assert.ok(requestInit?.signal);
    await transport.close();
  });

  it("tags the configured whole-operation deadline and caller cancellation separately", async () => {
    const deadlines: ProviderHttpDeadlines = {
      ...PROVIDER_HTTP_DEADLINES,
      synchronous: { ...PROVIDER_HTTP_DEADLINES.synchronous, operationMs: 5 },
    };
    const deadlineTransport = new CloudProviderTransport({
      deadlines,
      dispatcher: () => ({ close: async () => {} }),
      fetch: waitsForAbort(),
    });
    await assert.rejects(
      deadlineTransport.run(scope(), () => new Promise<never>(() => {})),
      (error: unknown) => error instanceof ProviderTransportError && error.diagnostic.category === "configured-deadline",
      "the whole-operation clock starts before the first fetch",
    );
    await assert.rejects(
      deadlineTransport.run(scope(), (fetch) => fetch("https://api.openai.com/v1/images/generations")),
      (error: unknown) => {
        assert.ok(error instanceof ProviderTransportError);
        assert.equal(error.diagnostic.category, "configured-deadline");
        assert.deepEqual(error.diagnostic.deadline, { kind: "operation", ms: 5 });
        return true;
      },
    );
    await deadlineTransport.close();

    const caller = new AbortController();
    const callerTransport = new CloudProviderTransport({
      dispatcher: () => ({ close: async () => {} }),
      fetch: waitsForAbort(),
    });
    const pending = callerTransport.run(scope(), (fetch) =>
      fetch("https://api.openai.com/v1/images/generations", { signal: caller.signal }),
    );
    caller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.diagnostic.category, "caller-abort");
      return true;
    });
    await callerTransport.close();

    const delayedCaller = new AbortController();
    const delayedTransport = new CloudProviderTransport({
      deadlines,
      dispatcher: () => ({ close: async () => {} }),
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => setTimeout(() => reject(init.signal?.reason), 20), { once: true });
        }),
    });
    const delayed = delayedTransport.run(scope(), (fetch) =>
      fetch("https://api.openai.com/v1/images/generations", { signal: delayedCaller.signal }),
    );
    delayedCaller.abort();
    await assert.rejects(delayed, (error: unknown) => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.diagnostic.category, "caller-abort", "the first abort source remains authoritative");
      return true;
    });
    await delayedTransport.close();
  });

  it("keeps policy and witnessed status on a response-body timeout", async () => {
    const bodyError = new TypeError("terminated", {
      cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT", syscall: "read" }),
    });
    const transport = new CloudProviderTransport({
      dispatcher: () => ({ close: async () => {} }),
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(bodyError);
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    await assert.rejects(
      transport.run(scope(), async (fetch) => (await fetch("https://api.openai.com/v1/images/generations")).text()),
      (error: unknown) => {
        assert.ok(error instanceof ProviderTransportError);
        assert.equal(error.diagnostic.category, "body-timeout");
        assert.deepEqual(error.diagnostic.deadline, {
          kind: "body",
          ms: PROVIDER_HTTP_DEADLINES.synchronous.bodyMs,
        });
        assert.equal(error.diagnostic.policy?.proxyMode, "direct");
        assert.equal(error.responseStatus, 400);
        assert.equal(error.submissionRejected, true);
        assert.equal(error.failureClass, "terminal");
        return true;
      },
    );
    await transport.close();
  });

  it("keeps host policy when detached response capture sees the body failure", async () => {
    const bodyError = new TypeError("terminated", {
      cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT", syscall: "read" }),
    });
    const transport = new CloudProviderTransport({
      dispatcher: () => ({ close: async () => {} }),
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(bodyError);
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    const tracked: Promise<void>[] = [];
    const diagnostics: Array<Parameters<ProviderCallCapture["fail"]>[2]> = [];
    const capture: ProviderCallCapture = {
      track(task) {
        tracked.push(task);
      },
      start: async () => `pc_${"0".repeat(26)}`,
      respond: async () => {},
      finish: async () => {},
      fail: async (_id, _error, diagnostic) => {
        diagnostics.push(diagnostic);
      },
    };
    const wrapped = captureProviderClient(
      "openai",
      (fetch): ProviderClient => ({
        id: "openai",
        declarations: {
          supportsIdempotencyKey: false,
          supportsLookupByKey: false,
          supportsListRecent: false,
          reportsCost: false,
        },
        validateKey: async () => [],
        submit: async () => {
          const response = await fetch("https://api.openai.com/v1/images/generations");
          await response.text();
          throw new Error("unreachable");
        },
        poll: async () => ({ state: "succeeded" }),
        fetchArtifacts: async () => [],
        cancel: async () => {},
      }),
      async () => {
        throw new Error("the host transport was bypassed");
      },
      capture,
      undefined,
      transport,
    );
    await assert.rejects(() =>
      wrapped.submit("k", { model: "gpt-image-2", capability: "image", params: { prompt: "x" } }),
    );
    await Promise.allSettled(tracked);
    assert.equal(diagnostics[0]?.category, "body-timeout");
    assert.deepEqual(diagnostics[0]?.deadline, {
      kind: "body",
      ms: PROVIDER_HTTP_DEADLINES.synchronous.bodyMs,
    });
    assert.equal(diagnostics[0]?.policy?.proxyMode, "direct");
    await transport.close();
  });

  it("reuses one dispatcher per profile and closes it", async () => {
    let created = 0;
    let closed = 0;
    const transport = new CloudProviderTransport({
      dispatcher: () => {
        created += 1;
        return { close: async () => { closed += 1; } };
      },
      fetch: async () => new Response("{}", { status: 200 }),
    });
    await transport.run(scope(), (fetch) => fetch("https://api.openai.com/one"));
    await transport.run(scope(), (fetch) => fetch("https://api.openai.com/two"));
    assert.equal(created, 1);
    await transport.close();
    assert.equal(closed, 1);
    await assert.rejects(() => transport.run(scope(), async () => null), /provider transport is closed/);
  });

  it("constructs an Undici 7 Agent in the default path", async () => {
    let dispatcher: unknown;
    const transport = new CloudProviderTransport({
      fetch: async (_url, init) => {
        dispatcher = (init as RequestInit & { dispatcher?: unknown }).dispatcher;
        return new Response("{}", { status: 200 });
      },
    });
    await transport.run(scope(), (fetch) => fetch("https://api.openai.com/test"));
    assert.ok(dispatcher instanceof Agent);
    await transport.close();
  });
});
