import assert from "node:assert/strict";
import { it } from "node:test";
import { parseIncomingFrame, shareSnapshot } from "../src/lib/frame-parser.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("keeps bulk collections without a validation clone while validating the snapshot envelope and controls", () => {
  const input = { kind: "snapshot", seq: 1, state: structuredClone(FIXTURE_STATE) };
  const parsed = parseIncomingFrame(input); assert.equal(parsed.kind, "snapshot");
  if (parsed.kind !== "snapshot") return;
  assert.equal(parsed.state.app.jobs, input.state.app.jobs);
  assert.equal(parsed.state.app.ledger, input.state.app.ledger);
  assert.equal(parsed.state.world!.artifacts, input.state.world!.artifacts);
  assert.throws(() => parseIncomingFrame({ ...input, seq: -1 }));
  assert.throws(() => parseIncomingFrame({ ...input, extra: true }));
  assert.throws(() => parseIncomingFrame({ ...input, state: { ...input.state, app: { ...input.state.app, jobs: {} } } }));
  assert.throws(() => parseIncomingFrame({ kind: "studio-assistant", seq: 1, requestId: "bad", response: {} }));
});

it("shares unchanged branches, replaces changed or removed rows and never mutates the old snapshot", () => {
  const previous = structuredClone(FIXTURE_STATE), next = structuredClone(previous);
  assert.equal(shareSnapshot(previous, next), previous);
  const changed = structuredClone(previous); changed.app.version = "changed";
  const shared = shareSnapshot(previous, changed);
  assert.notEqual(shared, previous); assert.notEqual(shared.app, previous.app);
  assert.equal(shared.world, previous.world); assert.equal(shared.app.jobs, previous.app.jobs);
  assert.notEqual(previous.app.version, "changed");
  assert.deepEqual(shareSnapshot({ rows: [{ id: "a" }, { id: "b" }] }, { rows: [{ id: "b" }] }), { rows: [{ id: "b" }] });
  assert.deepEqual(shareSnapshot({ a: 1, b: undefined }, { a: 1 }), { a: 1 });
});
