import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessEventHub, PreparationTable } from "../src/harness-events.js";

async function take<T>(events: AsyncIterable<T>, count: number): Promise<T[]> {
  const seen: T[] = [];
  for await (const event of events) {
    seen.push(event);
    if (seen.length === count) break;
  }
  return seen;
}

test("a listener hears what was emitted before its first pull, and every listener hears it", async () => {
  const hub = new HarnessEventHub<number>();
  const first = hub.subscribe(), second = hub.subscribe();
  hub.emit(1);
  hub.emit(2);
  assert.deepEqual(await take(first, 2), [1, 2]);
  assert.deepEqual(await take(second, 2), [1, 2]);
});

test("a listener ends when its signal aborts, after what was queued; one already aborted ends at once", async () => {
  const hub = new HarnessEventHub<number>(), stop = new AbortController();
  const events = hub.subscribe(stop.signal);
  hub.emit(1);
  stop.abort();
  hub.emit(2);
  assert.deepEqual(await take(events, 5), [1]);
  assert.deepEqual(await take(hub.subscribe(AbortSignal.abort()), 5), []);
});

test("closing ends every listener and every later one; a listener that stops early is forgotten", async () => {
  const hub = new HarnessEventHub<number>();
  const early = hub.subscribe();
  hub.emit(1);
  assert.deepEqual(await take(early, 1), [1]);
  const open = hub.subscribe();
  hub.emit(2);
  hub.close();
  hub.emit(3);
  assert.deepEqual(await take(open, 5), [2]);
  assert.deepEqual(await take(hub.subscribe(), 5), []);
});

test("a preparation is a copy, used by one session, and its absence is said", () => {
  const table = new PreparationTable<{ model: string }>();
  const input = { model: "anthropic/one" };
  table.prepare("t", input);
  input.model = "changed";
  assert.throws(() => table.prepare("t", { model: "anthropic/two" }), /already in use/);
  assert.deepEqual(table.take("t"), { model: "anthropic/one" });
  assert.throws(() => table.take("t"), /already consumed/);
  assert.deepEqual(table.take(undefined), {}, "no token, no preparation");
  table.prepare("u", { model: "x" });
  table.abandon("u");
  assert.throws(() => table.take("u"), /preparation is missing/);
  table.prepare(undefined, { model: "ignored" });
  table.prepare("v", { model: "x" });
  table.clear();
  assert.throws(() => table.take("v"), /missing/);
});
