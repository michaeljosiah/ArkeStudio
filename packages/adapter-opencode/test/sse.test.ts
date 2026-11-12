import assert from "node:assert/strict";
import { it } from "node:test";
import { parseSse, SseFrameLimitError } from "../src/sse.js";

const collect = async (source: AsyncIterable<unknown>) => { const values: unknown[] = []; for await (const value of source) values.push(value); return values; };
function stream(chunks: Uint8Array[]) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close(); }, cancel() { cancelled = true; } });
  return { body, cancelled: () => cancelled };
}
it("parses split UTF-8 and delimiters exactly at the frame byte bound", async () => {
  const frame = 'data: {"text":"🙂"}', bytes = Buffer.from(frame + "\n\n");
  const h = stream(Array.from(bytes, value => Uint8Array.of(value)));
  assert.deepEqual(await collect(parseSse(h.body, undefined, undefined, Buffer.byteLength(frame))), [{ text: "🙂" }]);
});
it("bounds each frame independently when one chunk carries many frames and heartbeats", async () => {
  let pulses = 0;
  const h = stream([Buffer.from(': heartbeat\n\ndata: {"n":1}\n\ndata: malformed\n\ndata: {"n":2}\n\n')]);
  assert.deepEqual(await collect(parseSse(h.body, undefined, () => { pulses++; }, 20)), [{ n: 1 }, { n: 2 }]); assert.equal(pulses, 1);
});
it("refuses terminated and unterminated oversized frames without echoing data, and cancels their source", async () => {
  for (const suffix of ["", "\n\n"]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from("PRIVATE_NATIVE_FRAME_DATA" + "x".repeat(40) + suffix)); }, cancel() { cancelled = true; } });
    await assert.rejects(collect(parseSse(body, undefined, undefined, 32)), error => error instanceof SseFrameLimitError && !error.message.includes("PRIVATE_"));
    assert(cancelled);
  }
});
it("aborts a pending stream read without waiting for an uncooperative cancellation callback", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull() {}, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const stop = new AbortController(), reading = collect(parseSse(body, stop.signal)); stop.abort();
  assert.deepEqual(await reading, []); assert(cancelled);
});
