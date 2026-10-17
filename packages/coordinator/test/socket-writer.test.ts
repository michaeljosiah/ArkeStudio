import assert from "node:assert/strict";
import { it } from "node:test";
import type { WebSocket } from "ws";
import { SocketWriter } from "../src/socket-writer.js";

function fixture(options: { maxQueuedBytes?: number; maxQueuedFrames?: number; maxFrameBytes?: number; sendTimeoutMs?: number; closeTimeoutMs?: number } = {}) {
  const sent: string[] = [], callbacks: ((error?: Error) => void)[] = [], closed: unknown[] = [], logs: Record<string, unknown>[] = [], busy: boolean[] = [];
  let terminated = false;
  const socket = { readyState: 1, bufferedAmount: 0,
    send(text: string, callback: (error?: Error) => void) { sent.push(text); callbacks.push(callback); },
    close(code: number, reason: string) { closed.push([code, reason]); socket.readyState = 2; },
    terminate() { terminated = true; },
  };
  const writer = new SocketWriter(socket as unknown as WebSocket, { label: "test", trace: detail => logs.push(detail), busy: value => busy.push(value), ...options });
  return { writer, sent, callbacks, closed, logs, busy, terminated: () => terminated };
}

it("waits for each write and delivers snapshots and transient events in their original order", () => {
  const f = fixture();
  f.writer.send("snapshot 1"); f.writer.send("permission 2"); f.writer.send("snapshot 3");
  assert.deepEqual(f.sent, ["snapshot 1"]);
  f.callbacks.shift()!(); assert.deepEqual(f.sent, ["snapshot 1", "permission 2"]);
  f.callbacks.shift()!(); f.callbacks.shift()!();
  assert.deepEqual(f.sent, ["snapshot 1", "permission 2", "snapshot 3"]);
  assert.equal(f.busy.at(-1), false);
  assert.equal(f.writer.stats().queuedBytes, 0);
  f.writer.dispose();
});

it("bounds UTF-8 waiting bytes and logs metadata before gracefully closing, without leaking content", () => {
  const f = fixture({ maxQueuedBytes: 4 });
  f.writer.send("private snapshot"); f.writer.send("éé"); f.writer.send("x");
  assert.equal(f.closed.length, 1); assert.equal((f.closed[0] as unknown[])[0], 1013);
  assert.equal(f.logs[0]!.queuedBytes, 4); assert.equal(f.logs[0]!.rejectedFrameBytes, 1);
  assert.equal(f.logs[0]!.localCloseReason, "outbound queue limit");
  assert.ok(!JSON.stringify(f.logs).includes("private"));
  f.callbacks.shift()!(); f.writer.send("late"); assert.equal(f.sent.length, 1);
  f.writer.dispose();
});

it("bounds tiny event bursts as well as byte volume", () => {
  const f = fixture({ maxQueuedFrames: 2 });
  for (let i = 0; i < 4; i++) f.writer.send("x");
  assert.equal(f.closed.length, 1); f.writer.dispose();
});

it("refuses a single frame larger than the receiver's payload limit before writing it", () => {
  const f = fixture({ maxFrameBytes: 4 });
  f.writer.send("ééé"); assert.deepEqual(f.sent, []);
  assert.equal(f.logs[0]!.localCloseReason, "outbound frame limit"); f.writer.dispose();
});

it("records a stalled sender, bounds the close wait and cancels timers during disposal", async () => {
  const f = fixture({ sendTimeoutMs: 10, closeTimeoutMs: 10 });
  f.writer.send("stalled");
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.logs[0]!.localCloseReason, "outbound send timeout");
  assert.equal(f.terminated(), true); f.writer.dispose();
  const g = fixture({ sendTimeoutMs: 10 });
  g.writer.send("stop"); g.writer.dispose(); g.callbacks.shift()!();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(g.logs, []); assert.deepEqual(g.closed, []);
});

it("handles failed sends without pumping queued frames", () => {
  const f = fixture(); f.writer.send("first"); f.writer.send("second");
  f.callbacks.shift()!(new Error("private network detail"));
  assert.equal(f.sent.length, 1); assert.equal(f.logs[0]!.localCloseReason, "outbound send failed");
  assert.ok(!JSON.stringify(f.logs).includes("private")); f.writer.dispose();
});

it("preserves the bounded forced close while the coordinator drains a stalled peer", async () => {
  const f = fixture({ maxFrameBytes: 1, closeTimeoutMs: 10 });
  f.writer.send("oversized");
  f.writer.dispose({ preserveCloseTimeout: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.terminated(), true, "shutdown must not cancel the forced-close deadline");
  f.writer.dispose();
  const g = fixture({ maxFrameBytes: 1, closeTimeoutMs: 10 });
  g.writer.send("oversized");
  g.writer.dispose({ preserveCloseTimeout: true });
  g.writer.dispose(); // Peer completed its close handshake before the deadline.
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(g.terminated(), false, "the close event still cancels the deadline");
});
