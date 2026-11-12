import assert from "node:assert/strict";
import { it } from "node:test";
import { VoxaClient, VoxaCancelledError, encodePcm16Wav, wordTimingRefusalReason } from "../src/index.js";

it("shares only exact static word-timing refusals with other local readers", () => {
  const known = "the recognizer grouped multiple words under one timestamp";
  assert.equal(wordTimingRefusalReason(new Error(known)), known);
  for (const error of [new Error(known + " private transcript"), new Error("voxa: word timing failed (HTTP 422)"),
    new Error("x".repeat(10000)), { message: known }, known, null]) assert.equal(wordTimingRefusalReason(error), undefined);
});

it("requests acoustic words from saved WAV audio and rejects sentence-only answers", async () => {
  const heard = {
    text: "A lamp.",
    seconds: 1,
    engine: { id: "whisper", version: "1", model: "base" },
    words: [
      { text: "A", startSec: 0.1, endSec: 0.3, probability: 0.9 },
      { text: "lamp.", startSec: 0.4, endSec: 0.8, probability: 0.9 },
    ],
  };
  let answer: unknown = heard;
  const client = new VoxaClient(async (url, init) => {
    assert.equal(url, "http://127.0.0.1:5555/stt/words");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Content-Type"), "audio/wav");
    return new Response(JSON.stringify(answer), { status: 200 });
  }, "http://127.0.0.1:5555");
  const wav = encodePcm16Wav(new Float32Array(16000), 16000);
  assert.deepEqual(await client.transcribeWords(wav), heard);
  answer = { text: heard.text };
  await assert.rejects(client.transcribeWords(wav));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(client.transcribeWords(wav, { signal: cancelled.signal }), VoxaCancelledError);
  client.dispose();
});

const silentWav = encodePcm16Wav(new Float32Array(16000), 16000);
const refusal = (detail: unknown, status = 422) => new Response(JSON.stringify({ status, detail }), {
  status, headers: { "content-type": "application/problem+json; charset=utf-8" },
});

it("explains only known timing refusals without copying runtime detail", async () => {
  const cases = [
    ["Word timing requires at least 0.2 seconds of audio.", "word timing needs at least 0.2 seconds of audio"],
    ["The recognizer returned text without usable word timings.", "the recognizer returned no usable word timing"],
    ["Long audio requires a measurable silent pause within each 28-second alignment window.", "word timing needs a silent pause within each 28-second section"],
    ["Invalid audio duration.", "word timing could not read the recording’s duration"],
    ["The recognizer returned multiple words under one timestamp.", "the recognizer grouped multiple words under one timestamp"],
    ["The recognizer returned out-of-order tokens.", "word timing contains out-of-order words"],
    ["A word has no usable acoustic interval or an unresolved pause.", "a word has no usable timing or an unresolved pause"],
    ["The recognizer returned ambiguous or overlapping word bounds at word 31 (2.4–2.4 seconds).", "word timing contains overlapping or ambiguous words"],
    ["The recognizer returned invalid token bounds or confidence (-1–3 seconds, probability 0.9, duration 2).", "word timing contains invalid word bounds or confidence"],
  ];
  for (const [detail, expected] of cases) {
    const client = new VoxaClient(async () => refusal(detail), "http://127.0.0.1:5555");
    try { await assert.rejects(client.transcribeWords(silentWav), { message: expected }); }
    finally { client.dispose(); }
  }
});

it("keeps generic errors for unknown, malformed, oversized and non-422 answers", async () => {
  const responses = [
    refusal("private path or recognized text"), refusal({ detail: "unexpected object" }),
    new Response('{"detail":', { status: 422, headers: { "content-type": "application/problem+json" } }),
    new Response(JSON.stringify({ detail: "Invalid audio duration." }), { status: 422 }),
    refusal("x".repeat(513)), refusal("Invalid audio duration.", 503),
    new Response(JSON.stringify({ detail: "Invalid audio duration.", extra: "x".repeat(2048) }), {
      status: 422, headers: { "content-type": "application/problem+json", "content-length": "1" },
    }),
    new Response(JSON.stringify({ detail: "Invalid audio duration.\nprivate detail" }), {
      status: 422, headers: { "content-type": "application/problem+json" },
    }),
  ];
  for (const response of responses) {
    const client = new VoxaClient(async () => response, "http://127.0.0.1:5555");
    try { await assert.rejects(client.transcribeWords(silentWav), { message: `voxa: word timing failed (HTTP ${response.status})` }); }
    finally { client.dispose(); }
  }
});

it("bounds streamed refusal bytes and cancels the unread remainder", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1025).fill(32)); },
    cancel() { cancelled = true; },
  });
  const client = new VoxaClient(async () => new Response(body, {
    status: 422, headers: { "content-type": "application/problem+json" },
  }), "http://127.0.0.1:5555");
  try {
    await assert.rejects(client.transcribeWords(silentWav), { message: "voxa: word timing failed (HTTP 422)" });
    assert.equal(cancelled, true);
  } finally { client.dispose(); }
});

it("cancels a stalled diagnostic body for caller and runtime cancellation", async () => {
  for (const kind of ["caller", "runtime"] as const) {
    let started!: () => void, cancelled = false;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const body = new ReadableStream<Uint8Array>({
      pull() { started(); return new Promise(() => {}); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const client = new VoxaClient(async () => new Response(body, {
      status: 422, headers: { "content-type": "application/problem+json" },
    }), "http://127.0.0.1:5555");
    try {
      const pending = client.transcribeWords(silentWav, { signal: controller.signal });
      const rejected = assert.rejects(pending, VoxaCancelledError);
      await reading;
      if (kind === "caller") controller.abort(); else client.cancelPending();
      await rejected;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(cancelled, true);
    } finally { client.dispose(); }
  }
});

it("falls back promptly when a refusal body never finishes", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; },
  });
  const client = new VoxaClient(async () => new Response(body, {
    status: 422, headers: { "content-type": "application/problem+json" },
  }), "http://127.0.0.1:5555");
  try {
    await assert.rejects(client.transcribeWords(silentWav), { message: "voxa: word timing failed (HTTP 422)" });
    assert.equal(cancelled, true);
  } finally { client.dispose(); }
});
