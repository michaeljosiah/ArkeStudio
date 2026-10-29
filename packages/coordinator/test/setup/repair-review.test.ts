import assert from "node:assert/strict";
import { it } from "node:test";
import { SetupRepairReviews } from "../../src/setup/repair-review.js";
import { SetupRepairReviewSchema, type SetupComponent } from "@arke-studio/contracts";
import type { CatalogueEntry } from "../../src/setup/catalogue.js";
import { tempDir } from "../tmp.js";

it("a pending repair survives restart, while completed file changes do not replay and prior approval expires", async () => {
  const root = await tempDir("arke-repair-review-"), first = new SetupRepairReviews(root);
  const entry: CatalogueEntry = { id: "fixture", displayName: "Fixture", purpose: "Fixture", optional: true, sizeMb: 1,
    spec: { kind: "files", dir: "fixture", files: [{ file: "model.bin", url: "https://example.test/model", sizeMb: 1 }] } };
  const component: SetupComponent = { id: entry.id, displayName: entry.displayName, purpose: entry.purpose, sizeMb: 1,
    installLocation: root, state: "failed", repairRequired: true, bytesDone: 0, bytesTotal: 0, bytesPerSecond: null, pauseSupported: false };
  const review = SetupRepairReviewSchema.parse(first.review(entry, component, root));
  assert.equal(await first.pending(entry.id), false); await first.record(entry.id, review, "intended");
  const restarted = new SetupRepairReviews(root); assert.equal(await restarted.pending(entry.id), true);
  assert.notEqual(restarted.review(entry, component, root)!.revision, review.revision);
  await restarted.record(entry.id, review, "files-removed");
  assert.equal(await new SetupRepairReviews(root).pending(entry.id), false);
});
