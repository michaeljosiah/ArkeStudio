import assert from "node:assert/strict";
import { it } from "node:test";
import { DomainEventSchema } from "@arke-studio/contracts";
import { CHAPTER, LEDGER, WORLD_ID, withHarness } from "./picture-harness.js";

const requestId = "01J00000000000000000000001";
const tallId = "01J00000000000000000000002";

for (const target of [
  { name: "no open world", openWorld: false, reason: /world.*not open/i },
  { name: "another world", worldId: "01J00000000000000000000003", reason: /world.*not open/i },
  { name: "a missing production", productionId: "missing-production", reason: /chapter.*unavailable/i },
  { name: "a missing chapter file", chapterFile: "chapters/missing.md", reason: /chapter.*unavailable/i },
]) {
  it(`rejects a picture and its Tall for ${target.name} before any generation (#1812)`, () =>
    withHarness(async h => {
      await h.send({
        kind: "make-audiobook-picture", worldId: target.worldId ?? WORLD_ID,
        productionId: target.productionId ?? LEDGER, chapterFile: target.chapterFile ?? CHAPTER,
        block: "p0.0", prompt: "The rail at dawn.", who: [], confirmedMicroUsd: 45_000,
        requestId, tall: { requestId: tallId, confirmedMicroUsd: 45_000 },
      });
      const failures = h.events.filter(event => event.type === "command.failed");
      assert.equal(failures.length, 2);
      assert.deepEqual(failures.map(event => event.requestId), [requestId, tallId]);
      for (const event of failures) {
        assert.equal(event.command, "make-audiobook-picture");
        assert.match(event.reason, target.reason);
        assert.match(event.reason, /No generation was started/);
        assert.ok(DomainEventSchema.safeParse(event).success, "a real transport accepts the rejection");
      }
      assert.equal(h.events.some(event => event.type === "audiobook.picture-made"), false);
      assert.equal(h.enqueued.length, 0, "no provider work was submitted");
      assert.equal(h.seen.length, 0, "no writing model was asked");
    }, { openWorld: target.openWorld }));
}
