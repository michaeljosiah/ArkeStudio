import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_MODEL_MIN_CONTEXT, meetsLocalModelMinimum } from "../src/index.js";

test("a local model is offered for writing only when it states a 256k context", () => {
  assert.equal(LOCAL_MODEL_MIN_CONTEXT, 256_000);
  assert.equal(meetsLocalModelMinimum({ contextLength: 256_000 }), true, "published as 256K");
  assert.equal(meetsLocalModelMinimum({ contextLength: 262_144 }), true, "also published as 256K");
  assert.equal(meetsLocalModelMinimum({ contextLength: 131_072 }), false, "128K, like Gemma 4 E2B");
  assert.equal(meetsLocalModelMinimum({}), false, "a window that is not stated — an unread model — is not confirmed");
});
