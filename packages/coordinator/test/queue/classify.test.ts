import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyError, type FailureClass } from "../../src/queue/classify.js";

/**
 * The shape Undici throws: a bare `TypeError: fetch failed` carrying everything that identifies
 * the failure on `.cause`. `classifyError` reads only the outer message, so nothing built this
 * way can pass on a string match against the code it is testing for — the first case below pins
 * that outer message to `offline` on its own, which is what every other answer here moves off.
 */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}

/** An error the way Node and Undici hand them over: the code is a property, not the text. */
function coded(name: string, code: string, message: string): Error & { code: string } {
  const err = new Error(message);
  err.name = name;
  return Object.assign(err, { code });
}

/** Codes that mean a connection was made and then broke, or that a clock ran out. */
const TRANSIENT_CODES: ReadonlyArray<readonly [string, string]> = [
  ["ECONNRESET", "read ECONNRESET"],
  ["EPIPE", "write EPIPE"],
  ["ETIMEDOUT", "connect ETIMEDOUT 104.18.7.192:443"],
  ["UND_ERR_SOCKET", "other side closed"],
  ["UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"],
  ["UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error"],
  ["UND_ERR_BODY_TIMEOUT", "Body Timeout Error"],
  ["UND_ERR_ABORTED", "Request aborted"],
];

/** Codes that mean nothing answered, and nothing will until the network comes back. */
const OFFLINE_CODES: ReadonlyArray<readonly [string, string]> = [
  ["ENOTFOUND", "getaddrinfo ENOTFOUND api.openai.com"],
  ["EAI_AGAIN", "getaddrinfo EAI_AGAIN api.openai.com"],
  ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8188"],
  ["ENETUNREACH", "connect ENETUNREACH"],
  ["EHOSTUNREACH", "connect EHOSTUNREACH"],
  ["ENETDOWN", "connect ENETDOWN"],
  ["EHOSTDOWN", "connect EHOSTDOWN"],
];

describe("classifyError: transport codes on the cause chain", () => {
  it("reads a bare fetch failure as offline — the answer every case below has to move off", () => {
    assert.equal(classifyError(new TypeError("fetch failed")), "offline");
  });

  for (const [code, message] of TRANSIENT_CODES) {
    it(`classifies ${code} as transient`, () => {
      assert.equal(classifyError(fetchFailed(coded("Error", code, message))), "transient");
    });
  }

  for (const [code, message] of OFFLINE_CODES) {
    it(`classifies ${code} as offline`, () => {
      assert.equal(classifyError(fetchFailed(coded("Error", code, message))), "offline");
    });
  }

  it("never reports a deadline as offline, which is what #93 saw", () => {
    // The whole point of reading the chain. Each of these paused the lane on "offline — jobs stay
    // queued and resume with connectivity" for a failure that had nothing to do with connectivity,
    // and a deadline Arke sets itself would land in the same place.
    for (const [code, message] of TRANSIENT_CODES) {
      assert.notEqual(classifyError(fetchFailed(coded("Error", code, message))), "offline", code);
    }
  });
});

describe("classifyError: the shape of the chain", () => {
  it("reaches a code two causes down", () => {
    const socket = coded("SocketError", "UND_ERR_SOCKET", "other side closed");
    assert.equal(classifyError(fetchFailed(new Error("connection failure", { cause: socket }))), "transient");
  });

  it("walks past a code it does not know to one it does", () => {
    const reset = coded("Error", "ECONNRESET", "read ECONNRESET");
    const wrapper = coded("WrapperError", "UND_ERR_NOT_A_REAL_CODE", "wrapped");
    assert.equal(classifyError(fetchFailed(Object.assign(wrapper, { cause: reset }))), "transient");
  });

  it("reads AggregateError members, where a dual-stack host puts its codes", () => {
    // Modelled on a refused local port, which fails once per address family with the outer error
    // carrying no code at all. The members here say ECONNRESET rather than ECONNREFUSED because
    // a refusal is what the outer message resolves to anyway — only a code that disagrees with
    // the message can show the members were read.
    const members = [
      coded("Error", "ECONNRESET", "read ECONNRESET"),
      coded("Error", "ECONNRESET", "read ECONNRESET"),
    ];
    assert.equal(classifyError(fetchFailed(new AggregateError(members, ""))), "transient");
  });

  it("terminates on a cause that points back at itself", () => {
    const loop: { code: string; cause?: unknown } = { code: "UND_ERR_NOT_A_REAL_CODE" };
    loop.cause = loop;
    assert.equal(classifyError(fetchFailed(loop)), "offline");
  });

  it("falls back to the message when the chain names no code it knows", () => {
    // A certificate failure is the live example: #95's taxonomy gives TLS its own category, but
    // this classifier has never had one, so it still answers offline. Recorded rather than fixed
    // here — inventing a class for it is a decision about retry behaviour, not about reading.
    const cert = coded("Error", "CERT_HAS_EXPIRED", "certificate has expired");
    assert.equal(classifyError(fetchFailed(cert)), "offline");
  });

  it("survives values that are not errors at all", () => {
    assert.equal(classifyError("something went wrong"), "terminal");
    assert.equal(classifyError(null), "terminal");
    assert.equal(classifyError(fetchFailed(null)), "offline");
  });
});

describe("classifyError: what the chain does not get to override", () => {
  it("keeps a witnessed credential rejection ahead of any transport code under it", () => {
    // Backing off a bad key instead of pausing the lane is a lane that never says why it stopped.
    const err = new Error("openai: the credential was rejected (HTTP 401)", {
      cause: coded("Error", "ECONNRESET", "read ECONNRESET"),
    });
    assert.equal(classifyError(err), "provider-fault");
  });

  const MESSAGE_ONLY: ReadonlyArray<readonly [string, FailureClass]> = [
    ["openai: submit failed (HTTP 401)", "provider-fault"],
    ["fal: quota exhausted", "provider-fault"],
    ["openai: submit failed (HTTP 429)", "transient"],
    ["openai: submit failed (HTTP 503)", "transient"],
    ["socket hang up", "transient"],
    ["openai: the request was rejected by the content policy", "terminal"],
    ["fal: no endpoint mapping for model", "terminal"],
  ];

  for (const [message, expected] of MESSAGE_ONLY) {
    it(`still reads "${message}" as ${expected}`, () => {
      assert.equal(classifyError(new Error(message)), expected);
    });
  }

  it("still reads a caller abort as transient", () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    assert.equal(classifyError(abort), "transient");
  });
});

describe("classifyError: a class the client declared on the error", () => {
  const BUSY = "comfyui: Draft Image needs 5.9 GB of free graphics memory and this machine has 2.0 GB free. Close other programs using the graphics card, then try again.";

  it("believes an error that names its own class, where the message alone would be terminal", () => {
    // A card without room for a recipe (#692): no status, no transport code, and not a word a
    // pattern could tell from a refusal. D5's default made it terminal, the message told the
    // user to try again, and nothing on screen let them.
    assert.equal(classifyError(new Error(BUSY)), "terminal", "the message on its own is the D5 default");
    assert.equal(classifyError(Object.assign(new Error(BUSY), { failureClass: "transient" })), "transient");
  });

  it("keeps a declared class ahead of the chain and the message alike", () => {
    const refused = fetchFailed(coded("Error", "ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8188"));
    assert.equal(classifyError(refused), "offline", "the chain on its own says offline");
    assert.equal(classifyError(Object.assign(refused, { failureClass: "transient" })), "transient");
  });

  it("ignores a declaration that names no class it knows", () => {
    assert.equal(classifyError(Object.assign(new Error("HTTP 503"), { failureClass: "retryable" })), "transient");
    assert.equal(classifyError(Object.assign(new Error("HTTP 503"), { failureClass: 7 })), "transient");
    assert.equal(classifyError(Object.assign(new Error("inscrutable"), { failureClass: "" })), "terminal");
  });
});

describe("classifyError: a witnessed 4xx is the provider's verdict, not the transport's", () => {
  it("does not read `result fetch failed (HTTP 422)` as the network being down (#630)", () => {
    assert.equal(classifyError(new Error("fal: result fetch failed (HTTP 422)")), "terminal");
    assert.equal(classifyError(new Error("fal: result fetch failed (HTTP 400)")), "terminal");
  });

  it("keeps 429 transient and the credential statuses on the fault side", () => {
    assert.equal(classifyError(new Error("fal: result fetch failed (HTTP 429)")), "transient");
    assert.equal(classifyError(new Error("fal: result fetch failed (HTTP 401)")), "provider-fault");
  });
});
