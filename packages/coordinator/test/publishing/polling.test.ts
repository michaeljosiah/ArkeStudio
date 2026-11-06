import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { it } from "node:test";
import { form, publishingFixture, settled } from "./helpers.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("does not report a completed upload as interrupted when an earlier receipt read finishes late", async t => {
  const h = await publishingFixture();
  const submission = barrier();
  const submitting = barrier();
  const reading = barrier();
  const read = barrier();
  let pending: ReturnType<typeof h.service.list> | undefined;
  try {
    const request = h.transport.request.bind(h.transport);
    t.mock.method(h.transport, "request", async (...args: Parameters<typeof request>) => {
      if (args[0].endsWith("/submit")) { submitting.resolve(); await submission.promise; }
      return request(...args);
    });
    const preview = (await h.service.prepare(h.store, "story", h.exportId)).preview!;
    await h.service.submit(h.store.worldId, preview.candidateId, form);
    await submitting.promise;

    const receipt = join(h.root, "cloud", "receipts", h.account.actorKey(), preview.candidateId + ".json");
    const readFile = fs.readFile;
    let held = false;
    t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      const result = await readFile(...args);
      if (String(args[0]) === receipt && !held) {
        held = true; reading.resolve(); await read.promise;
      }
      return result;
    });
    syncBuiltinESMExports();
    pending = h.service.list(h.store.worldId);
    await reading.promise;
    submission.resolve();
    assert.equal((await settled(h.service, h.store.worldId)).publications[0]!.transfer, "complete");
    await h.service.control(h.store.worldId, preview.candidateId, "resume");
    read.resolve();
    const earlier = (await pending).publications[0]!;
    assert.equal(earlier.transfer, "uploading");
    assert.equal(earlier.message, null);
    assert.equal((await h.service.list(h.store.worldId)).publications[0]!.transfer, "complete");
  } finally {
    submission.resolve(); read.resolve();
    await pending?.catch(() => {});
    t.mock.restoreAll(); syncBuiltinESMExports();
    await h.service.stop();
  }
});
