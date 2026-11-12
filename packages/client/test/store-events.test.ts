import assert from "node:assert/strict";
import { it } from "node:test";
import type { DomainEvent } from "@arke-studio/contracts";
import { __handleFrameForTest, __setStateForTest, subscribeBenchTakeDeleted } from "../src/lib/store.js";
import { emitEvent, onEvent, onEvents } from "../src/lib/store/events.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/** The result channels share one bus keyed by event type (issue 2800). */
const AT = "2026-11-09T12:00:00.000Z";
const deleted = (takeId: string): DomainEvent => ({
  at: AT, type: "bench.take-deleted", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD", sessionId: "sess_01J8F3K2QW9VZX4N7M0RTYB6HD",
  takeId: `tk_${takeId}`, requestId: "01J8F3K2QW9VZX4N7M0RTYB6HE", deleted: true,
} as DomainEvent);
const heard = { at: AT, type: "story.editions" } as DomainEvent;

it("a listener hears its own event type and nothing else, until it stops", () => {
  const got: string[] = [];
  const stop = onEvent("bench.take-deleted", event => got.push(event.takeId));
  emitEvent(heard);
  emitEvent(deleted("01J8F3K2QW9VZX4N7M0RTYB6HF"));
  stop();
  emitEvent(deleted("01J8F3K2QW9VZX4N7M0RTYB6HG"));
  assert.deepEqual(got, ["tk_01J8F3K2QW9VZX4N7M0RTYB6HF"]);
});

it("one listener on several types hears each, and one stop removes it from all", () => {
  const got: string[] = [];
  const stop = onEvents(["bench.take-deleted", "story.editions"], event => got.push(event.type));
  emitEvent(deleted("01J8F3K2QW9VZX4N7M0RTYB6HF"));
  emitEvent(heard);
  stop();
  emitEvent(heard);
  assert.deepEqual(got, ["bench.take-deleted", "story.editions"]);
});

it("a listener that stops while it is heard does not keep the next from hearing", () => {
  const got: string[] = [];
  const stop = onEvent("story.editions", () => { got.push("first"); stop(); });
  const other = onEvent("story.editions", () => got.push("second"));
  emitEvent(heard);
  emitEvent(heard);
  other();
  assert.deepEqual(got, ["first", "second", "second"]);
});

it("an event frame reaches a channel's subscribers through the store", () => {
  __setStateForTest(FIXTURE_STATE);
  const got: string[] = [];
  const stop = subscribeBenchTakeDeleted(answer => got.push(answer.takeId));
  __handleFrameForTest({ kind: "event", seq: 2, event: deleted("01J8F3K2QW9VZX4N7M0RTYB6HF") });
  stop();
  assert.deepEqual(got, ["tk_01J8F3K2QW9VZX4N7M0RTYB6HF"]);
});
