import assert from "node:assert/strict";
import { it } from "node:test";
import { GENERIC_ERROR_COPY, describeError } from "../src/error-copy.js";

it("gives a Node system-error code its own plain sentence", () => {
  const err = Object.assign(new Error("ENOENT: no such file or directory, open 'x'"), { code: "ENOENT" });
  assert.equal(describeError(err), "That file no longer exists.");
  const busy = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  assert.equal(describeError(busy), "That file is in use by something else.");
});

it("trusts a hand-authored Error message as already being the sentence", () => {
  assert.equal(describeError(new Error("a world needs a name")), "a world needs a name");
});

it("falls back to the generic line for the engine's own error types", () => {
  assert.equal(describeError(new SyntaxError("Unexpected token < in JSON at position 0")), GENERIC_ERROR_COPY);
  assert.equal(describeError(new TypeError("Cannot read properties of undefined")), GENERIC_ERROR_COPY);
  assert.equal(describeError(new RangeError("Invalid array length")), GENERIC_ERROR_COPY);
});

it("falls back to the generic line for anything that isn't an Error at all", () => {
  assert.equal(describeError("a bare string"), GENERIC_ERROR_COPY);
  assert.equal(describeError(null), GENERIC_ERROR_COPY);
  assert.equal(describeError(undefined), GENERIC_ERROR_COPY);
  assert.equal(describeError(new Error("")), GENERIC_ERROR_COPY);
});
