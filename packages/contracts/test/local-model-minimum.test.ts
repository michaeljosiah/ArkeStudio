import test from "node:test";
import assert from "node:assert/strict";
import { ARKE_CONTEXT_WINDOW, LOCAL_MODEL_MIN_CONTEXT, meetsArkeModelMinimum, meetsLocalModelMinimum } from "../src/index.js";

test("Local admits the window it actually uses, including 128k models", () => {
  assert.equal(ARKE_CONTEXT_WINDOW, 65536);
  for (const contextLength of [65536, 131072, 256000]) assert.equal(meetsArkeModelMinimum({ contextLength }), true);
  for (const contextLength of [16384, 32768, 65535]) assert.equal(meetsArkeModelMinimum({ contextLength }), false);
  assert.equal(meetsArkeModelMinimum({}), false);
});

test("OpenCode offers a local model only when it states a 256k context", () => {
  assert.equal(LOCAL_MODEL_MIN_CONTEXT, 256_000);
  assert.equal(meetsLocalModelMinimum({ contextLength: 256_000 }), true, "published as 256K");
  assert.equal(meetsLocalModelMinimum({ contextLength: 262_144 }), true, "also published as 256K");
  assert.equal(meetsLocalModelMinimum({ contextLength: 131_072 }), false, "128K, like Gemma 4 E2B");
  assert.equal(meetsLocalModelMinimum({}), false, "a window that is not stated — an unread model — is not confirmed");
});
