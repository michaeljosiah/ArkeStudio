import assert from "node:assert/strict";
import { it } from "node:test";
import { SceneSchema, deriveRehearsalLines, foldPerformanceBible, recommendPerformanceBible, newId, type PerformanceBibleEvent } from "../src/index.js";
const cover = (id: string) => ({ blockId: id, textDigest: "sha256:12345678" });
it("derives covered dialogue once in authored shot order and keeps legacy VO and invalid speakers visible", () => {
  const scene = SceneSchema.parse({ id: "sc_test", number: 1, slug: "test", title: "Test", status: "draft", version: 1,
    script: { blocks: [{ id: "blk_first", kind: "dialogue", speaker: "maren", text: "First." }, { id: "blk_second", kind: "dialogue", speaker: "maren", text: "Second." }] },
    shots: [{ id: "sh_a", number: 9, title: "A", description: "A", covers: [cover("blk_second"), cover("blk_first")] },
      { id: "sh_b", number: 1, title: "B", description: "B", covers: [cover("blk_first")] },
      { id: "sh_c", number: 2, title: "C", description: "C", audio: { kind: "vo", speaker: "maren", line: "Legacy." } },
      { id: "sh_d", number: 3, title: "D", description: "D", audio: { kind: "dialogue", speaker: "missing", line: "Unresolved." } }] });
  const original = JSON.stringify(scene);
  const lines = deriveRehearsalLines(scene, [{ id: "maren", type: "character" }]);
  assert.deepEqual(lines.map(l => l.text), ["First.", "Second.", "Legacy.", "Unresolved."]);
  assert.deepEqual(lines.map(l => l.shotId), ["sh_a", "sh_a", "sh_c", "sh_d"]);
  assert.match(lines[3]!.reason!, /no available character/);
  assert.equal(JSON.stringify(scene), original);
  assert.notEqual(lines[0]!.id, lines[1]!.id, "two covered lines cannot share selection or note identity");
});
it("folds bible revisions, leaves tied recommendations visible, and rejects nonmonotonic history", () => {
  const event: PerformanceBibleEvent = { action: "designate", slotId: "warm-a", revision: 1, at: "2026-09-05T12:00:00Z", label: "Warm A", delivery: "warm", role: "cadence",
    productionId: "test", performanceId: newId("pf"), performanceHash: `sha256:${"a".repeat(64)}`, acceptedReviewAt: "2026-09-05T11:00:00Z" };
  const events = [event, { ...event, slotId: "warm-b" }];
  assert.deepEqual(recommendPerformanceBible(events, "warm", ["warm-a", "warm-b"]).map(s => s.slotId), ["warm-a", "warm-b"]);
  assert.deepEqual(recommendPerformanceBible(events, undefined, ["warm-a"]), []);
  assert.throws(() => foldPerformanceBible([...events, event]), /conflicting revisions/);
  assert.equal(foldPerformanceBible([...events, { action: "clear", slotId: "warm-a", revision: 2, at: event.at }])[0]!.action, "clear");
});
