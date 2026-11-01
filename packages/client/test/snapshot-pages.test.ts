import assert from "node:assert/strict";
import { it } from "node:test";
import { SnapshotPageBuffer } from "../src/lib/snapshot-pages.js";
import { __handleFrameForTest, __stateForTest, __connectionStatusForTest, __setBridgeForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("commits complete provenance and history atomically, preserving duplicate job receipts and row order", () => {
  const buffer = new SnapshotPageBuffer(), state = structuredClone(FIXTURE_STATE);
  const ledger = [state.app.ledger[0]!, state.app.ledger[0]!];
  buffer.append(1, { collection: "artifacts", offset: 0, length: state.world!.artifacts.length, rows: state.world!.artifacts, reset: true }, null);
  buffer.append(1, { collection: "jobs", offset: 0, length: state.app.jobs.length, rows: state.app.jobs, reset: true }, null);
  buffer.append(1, { collection: "ledger", offset: 0, length: 2, rows: [ledger[0]!], reset: true }, null);
  buffer.append(1, { collection: "ledger", offset: 1, length: 2, rows: [ledger[1]!], reset: false }, null);
  assert(buffer.finish(1, state)); assert.deepEqual(state.app.ledger, ledger);
  const previous = structuredClone(state), job = { ...state.app.jobs[0]!, status: "failed" as const };
  buffer.append(2, { collection: "artifacts", offset: 0, length: 0, rows: [], reset: true }, state);
  buffer.append(2, { collection: "jobs", offset: 0, length: 1, rows: [job], reset: false }, state);
  buffer.append(2, { collection: "ledger", offset: 2, length: 3, rows: [ledger[0]!], reset: false }, state);
  assert.deepEqual(state, previous, "staging does not mutate visible state");
  const next = structuredClone(state); next.world = null;
  assert(buffer.finish(2, next)); assert.equal(next.app.jobs.length, 1); assert.equal(next.app.jobs[0]!.status, "failed"); assert.equal(next.app.ledger.length, 3);
  for (const collection of ["artifacts", "jobs", "ledger"] as const) buffer.append(3, { collection, offset: 0, length: collection === "artifacts" ? 0 : next.app[collection].length, rows: [], reset: false }, next);
  assert(buffer.finish(3, structuredClone(next)), "empty Studio artifact lists can be retained");
  assert(buffer.finish(4, structuredClone(next), next), "a refresh with no pages retains the complete base");
});

it("rejects incomplete pages and never borrows pre-reconnect cached history", () => {
  const buffer = new SnapshotPageBuffer();
  assert.throws(() => buffer.append(1, { collection: "jobs", offset: 0, length: 0, rows: [], reset: false }, null));
  buffer.append(2, { collection: "jobs", offset: 1, length: 2, rows: [FIXTURE_STATE.app.jobs[0]!], reset: true }, null);
  buffer.append(2, { collection: "artifacts", offset: 0, length: 0, rows: [], reset: true }, null);
  buffer.append(2, { collection: "ledger", offset: 0, length: 0, rows: [], reset: true }, null);
  assert.equal(buffer.finish(2, structuredClone(FIXTURE_STATE)), false);
  assert.equal(buffer.finish(3, structuredClone(FIXTURE_STATE)), false);
});

it("the socket path restores paged snapshots on reconnect and replaces old cached history", () => {
  const sent: unknown[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "browser", send: text => sent.push(JSON.parse(text)), connect() {}, subscribe() {} });
  try {
    __handleFrameForTest({ kind: "snapshot", seq: 1, state: structuredClone(FIXTURE_STATE) });
    __connectionStatusForTest("open");
    assert.equal((sent.at(-1) as { pagedSnapshots: boolean }).pagedSnapshots, true);
    for (const [index, collection] of (["artifacts", "jobs", "ledger"] as const).entries()) __handleFrameForTest({ kind: "snapshot-page", seq: index + 2, snapshot: 1,
      page: { collection, offset: 0, length: 0, rows: [], reset: true } });
    assert.equal(__stateForTest().state!.app.jobs.length, FIXTURE_STATE.app.jobs.length, "no partial publication");
    __handleFrameForTest({ kind: "snapshot", seq: 5, collectionSnapshot: 1, state: { ...FIXTURE_STATE, world: null, app: { ...FIXTURE_STATE.app, jobs: [], ledger: [] } } });
    assert.equal(__stateForTest().state!.world, null); assert.deepEqual(__stateForTest().state!.app.jobs, []); assert.deepEqual(__stateForTest().state!.app.ledger, []);
  } finally { __setBridgeForTest(null); }
});
