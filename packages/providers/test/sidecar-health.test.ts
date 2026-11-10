import assert from "node:assert/strict";
import { it } from "node:test";
import { createProviderClients } from "../src/registry.js";

it("uses host-authenticated readiness for both local providers without a raw fetch fallback", async () => {
  const budgets: number[] = [];
  let ready = true;
  const clients = createProviderClients({
    fetch: async () => { throw new Error("Private readiness must not use the general provider transport"); },
    voxa: () => "http://127.0.0.1:7777",
    voxaHealth: async (timeoutMs) => {
      budgets.push(timeoutMs);
      return ready ? { engineStatus: { kokoro: { ready: true }, whisper: { ready: true } } } : null;
    },
  });
  assert.deepEqual(await clients.kokoro!.validateKey(""), [{ capability: "voice-tts", available: true }]);
  assert.deepEqual(await clients.whispercpp!.validateKey(""), [{ capability: "voice-stt", available: true }]);
  ready = false;
  assert.equal((await clients.kokoro!.validateKey(""))[0]!.available, false);
  assert.equal((await clients.whispercpp!.validateKey(""))[0]!.available, false);
  assert.deepEqual(budgets, [3_000, 10_000, 3_000, 10_000]);
});

it("retains only the bounded busy grace for authenticated Whisper timeouts", async () => {
  let timeout = false;
  const clients = createProviderClients({
    fetch: async () => { throw new Error("No raw fallback"); },
    voxa: () => "http://127.0.0.1:7777",
    voxaHealth: async () => {
      if (timeout) { const error = new Error("Health timed out"); error.name = "VoxaTimeoutError"; throw error; }
      return { engineStatus: { whisper: { ready: true } } };
    },
  });
  assert.equal((await clients.whispercpp!.validateKey(""))[0]!.available, true);
  timeout = true;
  assert.equal((await clients.whispercpp!.validateKey(""))[0]!.available, true);
  assert.equal((await clients.whispercpp!.validateKey(""))[0]!.available, true);
  assert.equal((await clients.whispercpp!.validateKey(""))[0]!.available, false);
});
