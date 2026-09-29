import assert from "node:assert/strict";
import { it } from "node:test";
import { GENERIC_ERROR_COPY, describeError } from "../src/error-copy.js";

it("gives a Node system-error code its own plain sentence", () => {
  const err = Object.assign(new Error("ENOENT: no such file or directory, open 'x'"), { code: "ENOENT" });
  assert.equal(describeError(err), "That file no longer exists.");
  const busy = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  assert.equal(describeError(busy), "That file is in use by something else.");
});

it("walks a bounded, cycle-safe cause chain for the code undici hangs off .cause", () => {
  // Undici's own shape: a bare `TypeError: fetch failed` whose .cause carries the real code.
  const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8188"), { code: "ECONNREFUSED" });
  const outer = new TypeError("fetch failed");
  (outer as unknown as { cause: unknown }).cause = inner;
  assert.equal(describeError(outer), "Couldn't connect — try again.");
});

it("reads a code from an AggregateError's members when the outer error carries none", () => {
  const member = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
  const outer = new AggregateError([member], "fetch failed");
  assert.equal(describeError(outer), "The connection timed out.");
});

it("does not loop forever on a self-referencing cause", () => {
  const err = new Error("circular") as Error & { cause?: unknown };
  err.cause = err;
  assert.equal(describeError(err), "circular"); // no code anywhere in the chain — falls through safely
});

it("trusts a hand-authored Error message as already being the sentence", () => {
  assert.equal(describeError(new Error("a world needs a name")), "a world needs a name");
});

it("never returns a value keyed off an inherited property name like 'constructor'", () => {
  const err = Object.assign(new Error("bogus"), { code: "constructor" });
  assert.equal(typeof describeError(err), "string");
  assert.equal(describeError(err), "bogus"); // not the known-code branch — no such code is mapped
});

it("bounds a passed-through message to a length every known schema field accepts", () => {
  const err = new Error("x".repeat(2000));
  const copy = describeError(err);
  assert.ok(copy.length <= 300, `expected <= 300 chars, got ${copy.length}`);
});

it("redacts a local filesystem path rather than passing it through", () => {
  const windows = new Error("EIO: i/o error, read 'C:\\Users\\alex\\worlds\\w1\\performance.json'");
  assert.equal(describeError(windows), GENERIC_ERROR_COPY);
  const posix = new Error("EIO: i/o error, read '/home/alex/worlds/w1/performance.json'");
  assert.equal(describeError(posix), GENERIC_ERROR_COPY);
});

it("redacts a UNC path in both its plain and extended-length forms", () => {
  const unc = new Error("EIO: i/o error, read '\\\\studio-nas\\worlds\\w1\\performance.json'");
  assert.equal(describeError(unc), GENERIC_ERROR_COPY);
  const extended = new Error("EIO: i/o error, read '\\\\?\\UNC\\studio-nas\\worlds\\w1\\performance.json'");
  assert.equal(describeError(extended), GENERIC_ERROR_COPY);
});

it("does not mistake an ordinary slash-bearing sentence for a path", () => {
  assert.equal(describeError(new Error("choose either/or, not both")), "choose either/or, not both");
});

it("redacts a shallow absolute path too, not only a deep one", () => {
  const err = new Error("EIO: i/o error, read '/tmp/recording.wav'");
  assert.equal(describeError(err), GENERIC_ERROR_COPY);
});

it("falls back to the generic line for the engine's own error types", () => {
  assert.equal(describeError(new SyntaxError("Unexpected token < in JSON at position 0")), GENERIC_ERROR_COPY);
  assert.equal(describeError(new TypeError("Cannot read properties of undefined")), GENERIC_ERROR_COPY);
  assert.equal(describeError(new RangeError("Invalid array length")), GENERIC_ERROR_COPY);
  assert.equal(describeError(new ReferenceError("foo is not defined")), GENERIC_ERROR_COPY);
  assert.equal(describeError(new URIError("URI malformed")), GENERIC_ERROR_COPY);
  assert.equal(describeError(new EvalError("eval failed")), GENERIC_ERROR_COPY);
  assert.equal(
    describeError(new AggregateError([new Error("a"), new Error("b")], "All promises were rejected")),
    GENERIC_ERROR_COPY,
  );
});

it("falls back to the generic line for anything that isn't an Error at all", () => {
  assert.equal(describeError("a bare string"), GENERIC_ERROR_COPY);
  assert.equal(describeError(null), GENERIC_ERROR_COPY);
  assert.equal(describeError(undefined), GENERIC_ERROR_COPY);
  assert.equal(describeError(new Error("")), GENERIC_ERROR_COPY);
});
