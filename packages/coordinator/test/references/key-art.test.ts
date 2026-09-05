import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { adoptKeyArtCandidate } from "../../src/references/key-art.js";
import { CrashSignal } from "../../src/world/commit.js";
import { readChanges } from "../../src/world/change-writer.js";
import { WorldStore } from "../../src/world/store.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";

describe("key-art adoption recovery", () => {
  for (const point of ["staged-written", "committing-marked", "renamed:0", "world-renamed", "changes-appended"]) {
    it(`recovers the image selection and its action marker together after ${point}`, async () => {
      const dir = await makeTempWorld();
      const store = await WorldStore.open(dir);
      closeOnCleanup(() => store.close());
      const chosen = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x80]);
      const previous = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x80]);
      await mkdir(join(dir, "incoming/world-image"), { recursive: true });
      await writeFile(join(dir, "incoming/world-image/candidate.png"), chosen);
      await writeFile(join(dir, "world-art.jpg"), previous);
      const commit = store.commitUnserialised.bind(store);
      store.commitUnserialised = (input) => commit(input, { at: (at) => {
        if (at === point) throw new CrashSignal(point);
      } });
      await assert.rejects(adoptKeyArtCandidate(store, "incoming/world-image/candidate.png", undefined, {
        source: "world-chat:test", requestId: "act-key-art-test",
      }), CrashSignal);
      await store.close();

      const reopened = await WorldStore.open(dir);
      closeOnCleanup(() => reopened.close());
      const changes = (await readChanges(join(dir, "changes.jsonl"))).filter((line) => line["requestId"] === "act-key-art-test");
      if (point === "staged-written") {
        assert.deepEqual(await readFile(join(dir, "world-art.jpg")), previous);
        assert.deepEqual(await readFile(join(dir, "incoming/world-image/candidate.png")), chosen);
        assert.equal(changes.length, 0);
      } else {
        assert.deepEqual(await readFile(join(dir, "world-art.png")), chosen);
        await assert.rejects(readFile(join(dir, "world-art.jpg")), { code: "ENOENT" });
        await assert.rejects(readFile(join(dir, "incoming/world-image/candidate.png")), { code: "ENOENT" });
        assert.equal(new Set(changes.map((line) => line.commitId)).size, 1);
        assert.equal(changes.length, 3);
        assert.equal(await adoptKeyArtCandidate(reopened), false);
      }
    });
  }
});
