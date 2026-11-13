import assert from "node:assert/strict";
import { it } from "node:test";
import { VoxaClient, VoxaTimeoutError } from "../src/index.js";

const capability = "a".repeat(43);

it("honors the authenticated health caller's longer budget and still bounds the request", async (test) => {
  test.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  const client = new VoxaClient(async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${capability}`);
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }, "http://127.0.0.1:5555", { capability: () => capability, timeouts: { health: 3_000 } });
  const pending = client.health({ timeoutMs: 10_000 });
  const rejected = assert.rejects(pending, error => error instanceof VoxaTimeoutError && error.timeoutMs === 10_000);
  test.mock.timers.tick(3_001);
  assert.equal(signal?.aborted, false);
  test.mock.timers.tick(6_999);
  await rejected;
  assert.equal(signal?.aborted, true);
  client.dispose();
});

it("authenticates private local speech without allowing redirects", async () => {
  let calls = 0;
  const client = new VoxaClient(async (url, init) => {
    calls++;
    assert.equal(url, "http://127.0.0.1:5555/stt");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${capability}`);
    assert.equal(new Headers(init?.headers).get("X-Voxa-Prompt"), Buffer.from("Maren").toString("base64"));
    return Response.json({ text: "Maren" });
  }, "http://127.0.0.1:5555", { capability: () => capability });
  assert.equal(await client.transcribe(new Uint8Array([1]), "audio/webm", { prompt: "Maren" }), "Maren");
  assert.equal(calls, 1);
  client.dispose();
});

it("never sends a speech capability to a substituted endpoint", async () => {
  let calls = 0;
  for (const endpoint of ["https://example.com", "http://127.0.0.1:5555/another", "http://user@127.0.0.1:5555", "http://127.0.0.1:5555?token=x"]) {
    const client = new VoxaClient(async () => { calls++; return Response.json({ text: "wrong" }); }, endpoint, { capability: () => capability });
    await assert.rejects(client.transcribe(new Uint8Array([1]), "audio/webm"), /Private local speech route/);
    client.dispose();
  }
  assert.equal(calls, 0);
});

it("refuses unavailable or malformed private authentication before dispatch", async () => {
  let calls = 0;
  for (const token of [null, "", "short", "secret\r\nheader"]) {
    const client = new VoxaClient(async () => { calls++; return Response.json({ text: "wrong" }); }, "http://127.0.0.1:5555", { capability: () => token });
    await assert.rejects(client.transcribe(new Uint8Array([1]), "audio/webm"), { message: "Local speech authentication is not ready." });
    client.dispose();
  }
  assert.equal(calls, 0);
});

it("switches explicit legacy/private authentication after host runtime fencing", async () => {
  let token: string | null | undefined;
  const observed: Array<string | null> = [];
  const client = new VoxaClient(async (_url, init) => {
    observed.push(new Headers(init?.headers).get("Authorization")); return Response.json({ text: "heard" });
  }, "http://127.0.0.1:5555", { capability: () => token });
  await client.transcribe(new Uint8Array([1]), "audio/pcm");
  client.cancelPending(); token = capability;
  await client.transcribe(new Uint8Array([1]), "audio/pcm");
  client.cancelPending(); token = null;
  await assert.rejects(client.transcribe(new Uint8Array([1]), "audio/pcm"), /authentication is not ready/);
  assert.deepEqual(observed, [null, `Bearer ${capability}`]); client.dispose();
});
