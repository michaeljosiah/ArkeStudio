import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { DomainEvent } from "@arke-studio/contracts";
import { __connectionStatusForTest, __handleFrameForTest, __setBridgeForTest, __setStateForTest, __stateForTest,
  lastAudiobookTallProgress } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const worldId = FIXTURE_STATE.world!.meta.worldId, productionId = "inkbound", chapterId = "neap";
const ids = { worldId, productionId, chapterId }, at = "2026-11-01T00:00:00Z";
const requestId = "01J8F3K2QW9VZX4N7M0RTYB6H1", key = `${worldId}/${productionId}/${chapterId}`;
const events: DomainEvent[] = [
  { at, type: "permission.pending", permissionId: "p1", actionClass: "future-tool", description: "Pending", rememberable: false },
  { at, type: "continuity.started", ...ids }, { at, type: "voices.started", ...ids },
  { at, type: "direction.started", ...ids }, { at, type: "audiobook.beats", ...ids, outcome: "grouping" },
  { at, type: "illustration.started", ...ids },
  { at, type: "audiobook.started", ...ids, requestId, toMake: 10, blocks: 10 },
  { at, type: "audiobook.book-started", worldId, productionId, requestId, chapters: 2, blocks: 10, done: 0 },
  { at, type: "audiobook.tall-progress", worldId, productionId, state: "making", total: 10, made: 2, failed: [] },
  { at, type: "voice.catalogue-preview", requestId, status: "failed", error: "Not available" },
];
afterEach(() => { __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE); });

it("keeps live permissions and world-keyed runs through refresh/navigation, and resets stale runs on reconnect", () => {
  __setBridgeForTest({ appVersion: "test", platform: "browser", send() {}, connect() {}, subscribe() {} });
  __connectionStatusForTest("open");
  __handleFrameForTest({ kind: "snapshot", seq: 1, state: structuredClone(FIXTURE_STATE) });
  let seq = 1;
  for (const event of events) __handleFrameForTest({ kind: "event", seq: ++seq, event });
  const live = __stateForTest(), tall = lastAudiobookTallProgress(worldId, productionId);
  const slots = ["permissions", "direction", "beats", "illustration", "audiobook", "cataloguePreview"] as const;
  for (const world of [FIXTURE_STATE.world, null, FIXTURE_STATE.world]) {
    __handleFrameForTest({ kind: "snapshot", seq: ++seq, state: { ...structuredClone(FIXTURE_STATE), world } });
    const refreshed = __stateForTest();
    for (const slot of slots) assert.equal(refreshed[slot], live[slot], `${slot} needs no repeated startup event`);
    assert.equal(refreshed.deriving[key]?.state, "deriving");
    assert.equal(refreshed.casting[key]?.state, "casting");
    assert.equal(lastAudiobookTallProgress(worldId, productionId), tall);
    if (world === null) assert.deepEqual(refreshed.audiobookBook, {}, "a production-only book key cannot cross worlds");
  }
  __connectionStatusForTest("open");
  __handleFrameForTest({ kind: "snapshot", seq: 1, state: structuredClone(FIXTURE_STATE) });
  const rejoined = __stateForTest();
  for (const slot of slots.filter(slot => slot !== "cataloguePreview")) assert.deepEqual(rejoined[slot], {}, `${slot} drops work that ended offline`);
  assert.deepEqual(rejoined.deriving, {}); assert.deepEqual(rejoined.casting, {});
  assert.equal(lastAudiobookTallProgress(worldId, productionId), null);
  seq = 1;
  for (const event of events) __handleFrameForTest({ kind: "event", seq: ++seq, event });
  assert.equal(__stateForTest().permissions.p1?.description, "Pending");
  assert.equal(__stateForTest().illustration[key]?.state, "reading");
  assert.equal(lastAudiobookTallProgress(worldId, productionId)?.made, 2);
});

it("does not carry a book run into another world's same-named production", () => {
  __setStateForTest(FIXTURE_STATE);
  __handleFrameForTest({ kind: "event", seq: 1, event: events.find(event => event.type === "audiobook.book-started")! });
  assert.equal(__stateForTest().audiobookBook[productionId]?.state, "reading");
  const world = structuredClone(FIXTURE_STATE.world!);
  world.meta.worldId = "01J8F3K2QW9VZX4N7M0RTYB6HD";
  __handleFrameForTest({ kind: "snapshot", seq: 2, state: { ...FIXTURE_STATE, world } });
  assert.deepEqual(__stateForTest().audiobookBook, {});
});
