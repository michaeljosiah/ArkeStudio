import assert from "node:assert/strict";
import { it } from "node:test";
import { VoxaClient, VoxaCancelledError, VoxaRecoveryHeldError, encodePcm16Wav } from "../src/index.js";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const health = { ok: true, version: "fixture", protocolVersion: 1, architecture: "x64", engines: ["kokoro", "whisper"], engineStatus: { kokoro: { ready: true }, whisper: { ready: true } } };
it("drains admitted synthesis, queued synthesis and transcription bodies while refusing new inference", async () => {
  const speechBody = deferred<void>(), transcriptBody = deferred<void>(), firstEntered = deferred<void>(), recognitionEntered = deferred<void>();
  let speech = 0, recognition = 0;
  const client = new VoxaClient(async url => {
    if (url.endsWith("/health")) return Response.json(health);
    if (url.endsWith("/tts")) {
      speech++; if (speech === 1) { firstEntered.resolve(); return { status: 200, arrayBuffer: async () => { await speechBody.promise; return new Uint8Array([1, 2]).buffer; } } as Response; }
      return new Response(new Uint8Array([3, 4]));
    }
    recognition++; recognitionEntered.resolve(); return { status: 200, json: async () => { await transcriptBody.promise; return { text: "fixture transcript" }; } } as Response;
  }, "http://127.0.0.1:1234");
  try {
    const first = client.synthesize({ voiceId: "fixture", text: "first" }), second = client.synthesize({ voiceId: "fixture", text: "second" });
    const transcript = client.transcribe(new Uint8Array([1]), "application/octet-stream"); await firstEntered.promise; await recognitionEntered.promise;
    let reserved = false; const reserving = client.reserveRuntime(new AbortController().signal).then(release => { reserved = true; return release; });
    await assert.rejects(client.synthesize({ voiceId: "fixture", text: "new" }), VoxaRecoveryHeldError);
    await assert.rejects(client.transcribe(new Uint8Array([1]), "application/octet-stream"), VoxaRecoveryHeldError);
    assert.equal((await client.health())?.version, "fixture", "metadata probes remain available");
    assert(!reserved); speechBody.resolve(); await first; await second; assert.equal(speech, 2); assert(!reserved);
    transcriptBody.resolve(); assert.equal(await transcript, "fixture transcript"); const release = await reserving; assert(reserved); assert.equal(recognition, 1);
    await assert.rejects(client.synthesize({ voiceId: "fixture", text: "still held" }), VoxaRecoveryHeldError);
    release(); release(); assert.deepEqual(await client.synthesize({ voiceId: "fixture", text: "after release" }), new Uint8Array([3, 4]));
    assert.equal(speech, 3, "only the three explicitly submitted requests ran");
  } finally { speechBody.resolve(); transcriptBody.resolve(); client.dispose(); }
});

it("cancels a waiting recovery reservation independently from inference and drains client disposal", async () => {
  const client = new VoxaClient(async () => new Promise<Response>(() => {}), "http://127.0.0.1:1234");
  const pending = assert.rejects(client.transcribe(new Uint8Array([1]), "application/octet-stream"), VoxaCancelledError);
  const cancellation = new AbortController(), reserving = client.reserveRuntime(cancellation.signal);
  cancellation.abort(new Error("owner stopped")); await assert.rejects(reserving, /owner stopped/);
  const next = client.reserveRuntime(new AbortController().signal); client.dispose(); await assert.rejects(next, VoxaCancelledError); await pending;
});

it("keeps pre-conversion transcription bound to the cancelled runtime generation", async () => {
  const wav = encodePcm16Wav(new Float32Array(1600), 16000);
  for (const wordTiming of [false, true]) {
    let fetches = 0; const client = new VoxaClient(async () => { fetches++; return Response.json({ text: "must not be sent" }); }, "http://127.0.0.1:1234");
    const pending = assert.rejects(wordTiming ? client.transcribeWords(wav) : client.transcribe(wav, "audio/wav"), VoxaCancelledError);
    client.cancelPending(); await pending; assert.equal(fetches, 0);
    const release = await client.reserveRuntime(new AbortController().signal); release(); client.dispose();
  }
});
