import assert from "node:assert/strict";
import { it } from "node:test";
import { VoxaClient, WHISPER_PROMPT_MAX_BYTES } from "../src/index.js";

it("encodes Unicode name hints per request and leaves unhinted transcription unchanged (#1670)", async () => {
  const headers: Headers[] = [];
  const client = new VoxaClient(async (_url, init) => {
    headers.push(new Headers(init?.headers));
    assert.deepEqual(new Uint8Array(init!.body as Buffer), new Uint8Array([1, 2]));
    return Response.json({ text: "heard" });
  }, "http://127.0.0.1:5901");
  const prompt = "Tunde, Rónkẹ, Ikoyi";
  assert.equal(await client.transcribe(new Uint8Array([1, 2]), "audio/webm", { prompt }), "heard");
  assert.equal(Buffer.from(headers[0]!.get("X-Voxa-Prompt")!, "base64").toString("utf8"), prompt);
  await client.transcribe(new Uint8Array([1, 2]), "audio/webm");
  assert.equal(headers[1]!.has("X-Voxa-Prompt"), false, "the preceding request's names never leak into dictation");
});

it("bounds hints by UTF-8 bytes and refuses null characters before sending audio (#1670)", async () => {
  let calls = 0;
  const client = new VoxaClient(async () => { calls++; return Response.json({ text: "heard" }); }, "http://127.0.0.1:5901");
  await client.transcribe(new Uint8Array(), "audio/webm", { prompt: "é".repeat(WHISPER_PROMPT_MAX_BYTES / 2) });
  for (const prompt of ["a".repeat(201), "é".repeat(101), "Tunde\0Ronke"]) {
    await assert.rejects(client.transcribe(new Uint8Array(), "audio/webm", { prompt }), /Whisper name hint/);
  }
  assert.equal(calls, 1);
});
