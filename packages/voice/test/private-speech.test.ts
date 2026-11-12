import assert from "node:assert/strict";
import { it } from "node:test";
import { VoxaClient } from "../src/index.js";

it("bounds private streamed audio before assembly, pins loopback and forbids redirects", async () => {
  const seen: RequestInit[] = [], urls: string[] = [];
  const client = new VoxaClient(async (url, init) => {
    urls.push(url); seen.push(init!);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); controller.close(); } }));
  }, "http://127.0.0.1:8765");
  try {
    assert.deepEqual([...await client.synthesize({ voiceId: "bm_george", text: "private" }, { maxAudioBytes: 4 })], [1, 2, 3, 4]);
    assert.equal(seen[0]!.redirect, "error"); assert.equal(urls[0], "http://127.0.0.1:8765/tts");
    assert(!JSON.stringify(seen[0]).includes("maxAudioBytes"), "a host bound is not a model input");
  } finally { client.dispose(); }
});
it("refuses declared and actual oversize audio, excessive fragments and invalid private routes without retry", async () => {
  for (const kind of ["declared", "stream", "fragments"] as const) {
    let calls = 0, cancelled = false;
    const client = new VoxaClient(async () => {
      calls++;
      return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(kind === "fragments" ? 0 : 3)); }, cancel() { cancelled = true; } }),
        { headers: kind === "declared" ? { "content-length": "20" } : {} });
    }, "http://127.0.0.1:8765");
    try { await assert.rejects(client.synthesize({ voiceId: "bm_george", text: "private" }, { maxAudioBytes: 4 }), /audio bound/); assert.equal(calls, 1); assert(cancelled); }
    finally { client.dispose(); }
  }
  for (const base of ["https://example.test", "http://localhost:8765", "http://127.0.0.1:8765/other", "http://user:secret@127.0.0.1:8765", "http://127.0.0.1:8765?secret"]) {
    let calls = 0; const client = new VoxaClient(async () => { calls++; return new Response(); }, base);
    try { await assert.rejects(client.synthesize({ voiceId: "bm_george", text: "private" }, { maxAudioBytes: 4 })); assert.equal(calls, 0); }
    finally { client.dispose(); }
  }
});
it("cancels a pending private body read without replay and refuses invalid audio bounds", async () => {
  let entered!: () => void, cancelled = false, calls = 0; const ready = new Promise<void>(resolve => { entered = resolve; });
  const client = new VoxaClient(async () => { calls++; return new Response(new ReadableStream({ start() { entered(); }, cancel() { cancelled = true; } })); }, "http://127.0.0.1:8765");
  const abort = new AbortController();
  try {
    const pending = client.synthesize({ voiceId: "bm_george", text: "private" }, { maxAudioBytes: 4, signal: abort.signal });
    await ready; abort.abort(); await assert.rejects(pending, /cancelled/); assert(cancelled); assert.equal(calls, 1);
    for (const maxAudioBytes of [0, 0.5, Infinity, 16 * 1024 ** 2 + 1]) await assert.rejects(client.synthesize({ voiceId: "bm_george", text: "private" }, { maxAudioBytes }));
    assert.equal(calls, 1);
  } finally { client.dispose(); }
});

it("keeps private synthesis and runtime ownership while cancelled response cleanup is still pending", async () => {
  let finish!: () => void, entered!: () => void, cancelEntered!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; }), cancelled = new Promise<void>(resolve => { cancelEntered = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  const client = new VoxaClient(async () => { calls++; return new Response(new ReadableStream({ start() { entered(); }, cancel() { cancelEntered(); return held; } })); }, "http://127.0.0.1:8765");
  const abort = new AbortController();
  try {
    const speech = client.synthesize({ voiceId: "bm_george", text: "private" }, { maxAudioBytes: 4, signal: abort.signal });
    await ready; abort.abort(); await assert.rejects(speech, /cancelled/); await cancelled;
    let reserved = false; const reservation = client.reserveRuntime(new AbortController().signal).then(release => { reserved = true; return release; });
    await new Promise(resolve => setImmediate(resolve)); assert(!reserved);
    await assert.rejects(client.synthesize({ voiceId: "bm_george", text: "second" }, { maxAudioBytes: 4 }), /recovering/); assert.equal(calls, 1);
    finish(); (await reservation)(); assert(reserved);
  } finally { finish(); client.dispose(); }
});
