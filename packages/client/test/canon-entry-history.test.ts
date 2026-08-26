import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClientState, DomainEvent } from "@arke-studio/contracts";
import { __handleFrameForTest, __setStateForTest, __stateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * A canon entry's detail is held by entry id, and canon ids restart at CANON-001 in every world.
 * Since the coordinator reads the change log to answer (issue 289), the answer is computed
 * asynchronously and one for a world just switched away from can still arrive.
 */
const OTHER_WORLD_ID = "01J8F3K2QW9VZX4N7M0RTYB6HD";

let seq = 1;

function refsFor(worldId: string, source: string, canonRevision = 1): DomainEvent {
  return {
    at: "2026-08-26T12:00:00.000Z",
    type: "canon.refs",
    worldId,
    entryId: "CANON-001",
    citedBy: { sheets: [], entries: [], productions: [] },
    history: [{ ts: "2026-08-26T11:00:00.000Z", entity: "canon/CANON-001", source }],
    canonRevision,
    ripples: [],
  } as DomainEvent;
}

function openWorld(worldId: string): ClientState {
  return { ...FIXTURE_STATE, world: { ...FIXTURE_STATE.world!, meta: { ...FIXTURE_STATE.world!.meta, worldId } } };
}

function send(event: DomainEvent): void {
  __handleFrameForTest({ kind: "event", seq: ++seq, event });
}

describe("a canon entry's detail belongs to the world that answered", () => {
  it("drops what it holds when the open world changes", () => {
    __setStateForTest(FIXTURE_STATE);
    send(refsFor(FIXTURE_WORLD_ID, "form"));
    assert.equal(__stateForTest().canonRefs["CANON-001"]?.history[0]?.source, "form");

    __handleFrameForTest({ kind: "snapshot", seq: ++seq, state: openWorld(OTHER_WORLD_ID) });
    assert.equal(
      __stateForTest().canonRefs["CANON-001"],
      undefined,
      "the previous world's CANON-001 must not answer for this world's",
    );
  });

  it("ignores an answer that arrives after the world it was asked of was left", () => {
    __setStateForTest(FIXTURE_STATE);
    __handleFrameForTest({ kind: "snapshot", seq: ++seq, state: openWorld(OTHER_WORLD_ID) });
    send(refsFor(OTHER_WORLD_ID, "chat:sess_2"));
    send(refsFor(FIXTURE_WORLD_ID, "form"));

    assert.equal(
      __stateForTest().canonRefs["CANON-001"]?.history[0]?.source,
      "chat:sess_2",
      "the late answer is about a world nobody is looking at",
    );
  });
});

describe("a canon entry's detail is the latest asked for, not the latest to arrive", () => {
  it("ignores an answer overtaken in flight", () => {
    // Messages are handled concurrently and answering reads the change log, so the request made
    // when canon moved can come back before the one the entry opened with.
    __setStateForTest(FIXTURE_STATE);
    send(refsFor(FIXTURE_WORLD_ID, "after-the-accept", 8));
    send(refsFor(FIXTURE_WORLD_ID, "before-the-accept", 7));

    assert.equal(
      __stateForTest().canonRefs["CANON-001"]?.history[0]?.source,
      "after-the-accept",
      "a late answer must not put the history back as it was",
    );
  });

  it("takes an answer describing a later revision", () => {
    __setStateForTest(FIXTURE_STATE);
    send(refsFor(FIXTURE_WORLD_ID, "before-the-accept", 7));
    send(refsFor(FIXTURE_WORLD_ID, "after-the-accept", 8));

    assert.equal(__stateForTest().canonRefs["CANON-001"]?.history[0]?.source, "after-the-accept");
  });
});
