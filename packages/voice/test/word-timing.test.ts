import assert from "node:assert/strict";
import { it } from "node:test";
import { VoxaClient, VoxaCancelledError, encodePcm16Wav } from "../src/index.js";

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
