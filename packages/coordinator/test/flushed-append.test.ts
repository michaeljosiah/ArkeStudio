import assert from "node:assert/strict";
import { it } from "node:test";
import { appendFlushed } from "../src/flushed-append.js";
import { WriteQueue } from "../src/change-log.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("keeps acknowledgement and the next queued append behind sync and close", async () => {
  const events: string[] = [];
  const syncing = deferred();
  const releaseSync = deferred();
  const closing = deferred();
  const releaseClose = deferred();
  const queue = new WriteQueue();
  let acknowledged = false;
  const first = queue.enqueue(() => appendFlushed("journal.jsonl", "{}\n", {
    open: async (_path, flags) => {
      assert.equal(flags, "a");
      return {
        writeFile: async (line, encoding) => {
          assert.equal(line, "{}\n");
          assert.equal(encoding, "utf8");
          events.push("write");
        },
        sync: async () => { events.push("sync"); syncing.resolve(); await releaseSync.promise; },
        close: async () => { events.push("close"); closing.resolve(); await releaseClose.promise; },
      };
    },
  })).then(() => { acknowledged = true; });
  const second = queue.enqueue(async () => { events.push("next"); });
  await syncing.promise;
  assert.equal(acknowledged, false);
  assert.deepEqual(events, ["write", "sync"]);
  releaseSync.resolve();
  await closing.promise;
  assert.equal(acknowledged, false);
  assert.deepEqual(events, ["write", "sync", "close"]);
  releaseClose.resolve();
  await Promise.all([first, second]);
  assert.equal(acknowledged, true);
  assert.deepEqual(events, ["write", "sync", "close", "next"]);
});

for (const stage of ["open", "write", "sync", "close"] as const) {
  it(`rejects ${stage} failure without retrying and leaves the queue usable`, async () => {
    const failure = new Error(stage);
    const events: string[] = [];
    const queue = new WriteQueue();
    const append = queue.enqueue(() => appendFlushed("journal.jsonl", "{}\n", {
      open: async () => {
        events.push("open");
        if (stage === "open") throw failure;
        return {
          writeFile: async () => { events.push("write"); if (stage === "write") throw failure; },
          sync: async () => { events.push("sync"); if (stage === "sync") throw failure; },
          close: async () => { events.push("close"); throw stage === "close" ? failure : new Error("secondary close failure"); },
        };
      },
    }));
    await assert.rejects(append, (error) => error === failure);
    await queue.enqueue(async () => { events.push("next"); });
    const expected = stage === "open" ? ["open", "next"]
      : stage === "write" ? ["open", "write", "close", "next"]
      : ["open", "write", "sync", "close", "next"];
    assert.deepEqual(events, expected);
  });
}
