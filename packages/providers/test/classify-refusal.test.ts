import assert from "node:assert/strict";
import { it } from "node:test";
import { classifyRefusal } from "../src/clients/http.js";
import { ProviderAuthError, ProviderBusyError, ProviderRequestRejectedError } from "../src/types.js";

const says = { auth: "auth", busy: "busy", failed: "failed", rejected: "rejected" };

it("decides a refusal's class from its status alone, in each vendor's words (#2824)", () => {
  const auth = classifyRefusal("mistral", 401, says);
  assert.ok(auth instanceof ProviderAuthError && auth.provider === "mistral" && auth.message === "auth");
  const busy = classifyRefusal("mistral", 429, says);
  assert.ok(busy instanceof ProviderBusyError && busy.submissionRejected === true, "a witnessed 429: nothing was taken, so the queue may retry it");
  for (const status of [500, 503]) {
    const failed = classifyRefusal("mistral", status, says);
    assert.equal(failed.constructor, Error, "a 5xx proves nothing about paid work, so it is held, never a rejection or a retry");
    assert.equal(failed.message, "failed");
  }
  for (const status of [400, 402, 403, 404, 422]) {
    const rejected = classifyRefusal("mistral", status, says);
    assert.ok(rejected instanceof ProviderRequestRejectedError && rejected.message === "rejected", `HTTP ${status}`);
  }
  assert.equal(classifyRefusal("mistral", 400, { ...says, rejected: undefined }).message, "failed", "a vendor with one word for both uses it for both");
});
