import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderTransportPolicy } from "@arke-studio/contracts";
import { diagnoseProviderTransportError, ProviderTransportError } from "../src/transport.js";

function fetchFailed(code: string, syscall?: string): TypeError {
  const cause = Object.assign(new Error("private host and request detail"), {
    code,
    ...(syscall ? { syscall } : {}),
    address: "192.0.2.10",
    path: "C:\\Users\\private\\world",
    prompt: "private story prose",
  });
  return new TypeError("fetch failed", { cause });
}

const POLICY: ProviderTransportPolicy = {
  implementation: "node-undici",
  runtime: "v22.test",
  proxyMode: "direct",
  connectMs: 10_000,
  headersMs: 20_000,
  bodyMs: 30_000,
  operationMs: 40_000,
};

describe("sanitized provider transport diagnostics (issue 95)", () => {
  const cases = [
    ["ENOTFOUND", "getaddrinfo", "dns"],
    ["UND_ERR_CONNECT_TIMEOUT", "connect", "connect-timeout"],
    ["CERT_HAS_EXPIRED", "connect", "tls"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "connect", "tls"],
    ["ECONNRESET", "read", "connection-reset"],
    ["UND_ERR_HEADERS_TIMEOUT", "read", "headers-timeout"],
    ["UND_ERR_BODY_TIMEOUT", "read", "body-timeout"],
    ["UND_ERR_PRX", "connect", "proxy"],
  ] as const;

  for (const [code, syscall, category] of cases) {
    it(`maps ${code} to ${category} without retaining arbitrary cause fields`, () => {
      const diagnostic = diagnoseProviderTransportError(fetchFailed(code, syscall), { policy: POLICY });
      assert.equal(diagnostic.category, category);
      assert.equal(diagnostic.code, code);
      assert.equal(diagnostic.syscall, syscall);
      const serialized = JSON.stringify(diagnostic);
      assert.doesNotMatch(serialized, /private host|192\.0\.2\.10|Users|story prose|prompt|address|path/);
    });
  }

  it("walks nested and aggregate causes, bounds cycles, and keeps only safe fields", () => {
    const reset = Object.assign(new Error("secret"), { code: "ECONNRESET", syscall: "read" });
    const loop: { name: string; code: string; cause?: unknown; arbitrary: string } = {
      name: "private.example",
      code: "PRIVATE_PROJECT_TOKEN",
      arbitrary: "omit me",
    };
    loop.cause = loop;
    const error = new AggregateError([loop, new Error("middle", { cause: reset })], "outer secret");
    const diagnostic = diagnoseProviderTransportError(new TypeError("fetch failed", { cause: error }));
    assert.equal(diagnostic.category, "connection-reset");
    assert.equal(diagnostic.code, "ECONNRESET");
    assert.ok(diagnostic.causes.length <= 8);
    assert.doesNotMatch(JSON.stringify(diagnostic), /omit me|outer secret|middle|secret|private\.example|PRIVATE_PROJECT_TOKEN/);
  });

  it("does not trust TLS- or proxy-shaped prefixes as diagnostic codes", () => {
    for (const code of ["ERR_TLS_private.example", "ERR_PROXY_C:\\Users\\private\\world"]) {
      const diagnostic = diagnoseProviderTransportError(fetchFailed(code));
      assert.equal(diagnostic.code, null);
      assert.doesNotMatch(JSON.stringify(diagnostic), /private|Users/);
    }
  });

  it("uses a witnessed status to classify body failures without claiming a 5xx was rejected", () => {
    const bodyTimeout = fetchFailed("UND_ERR_BODY_TIMEOUT", "read");
    const rejected = new ProviderTransportError(bodyTimeout, { policy: POLICY, responseStatus: 400 });
    assert.equal(rejected.failureClass, "terminal");
    assert.equal(rejected.submissionRejected, true);

    const rateLimited = new ProviderTransportError(bodyTimeout, { policy: POLICY, responseStatus: 429 });
    assert.equal(rateLimited.failureClass, "transient");
    assert.equal(rateLimited.submissionRejected, true);

    const ambiguous = new ProviderTransportError(bodyTimeout, { policy: POLICY, responseStatus: 503 });
    assert.equal(ambiguous.failureClass, "transient");
    assert.equal(ambiguous.submissionRejected, undefined);
  });

  it("distinguishes caller abort, a configured whole-operation deadline, and unknown transport", () => {
    const aborted = new Error("This operation was aborted");
    aborted.name = "AbortError";
    assert.equal(diagnoseProviderTransportError(aborted).category, "caller-abort");

    const deadline = new ProviderTransportError(new Error("runtime wording"), {
      category: "configured-deadline",
      code: "ARKE_PROVIDER_OPERATION_TIMEOUT",
      deadline: { kind: "operation", ms: 40_000 },
      policy: POLICY,
    });
    assert.equal(diagnoseProviderTransportError(deadline).category, "configured-deadline");
    assert.deepEqual(diagnoseProviderTransportError(deadline).deadline, { kind: "operation", ms: 40_000 });
    assert.doesNotMatch(deadline.message, /runtime wording/);
    assert.equal(diagnoseProviderTransportError(new TypeError("fetch failed")).category, "unknown-transport");
  });
});
