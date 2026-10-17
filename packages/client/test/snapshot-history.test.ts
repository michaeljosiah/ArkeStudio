import assert from "node:assert/strict";
import { it } from "node:test";
import { FIXTURE_STATE } from "./fixture-state.js";
import { __handleFrameForTest, __stateForTest, __connectionStatusForTest, __setBridgeForTest } from "../src/lib/store.js";

it("navigation retains job updates and the complete spend ledger; fresh snapshots replace them", () => {
  __handleFrameForTest({ kind: "snapshot", seq: 1, state: structuredClone(FIXTURE_STATE) });
  const job = { ...FIXTURE_STATE.app.jobs[0]!, status: "failed" as const, error: "test failure" };
  __handleFrameForTest({ kind: "event", seq: 2, event: { type: "job.updated", at: job.updatedAt, job } });
  const before = __stateForTest().state!;
  __handleFrameForTest({ kind: "snapshot", seq: 3, retainedHistory: ["jobs", "ledger"],
    state: { ...FIXTURE_STATE, world: null, app: { ...FIXTURE_STATE.app, jobs: [], ledger: [] } } });
  const after = __stateForTest().state!;
  assert.equal(after.world, null);
  assert.equal(after.app.jobs, before.app.jobs); assert.equal(after.app.jobs[0]!.status, "failed");
  assert.equal(after.app.ledger, before.app.ledger);
  __handleFrameForTest({ kind: "snapshot", seq: 4, state: { ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, jobs: [], ledger: [] } } });
  assert.deepEqual(__stateForTest().state!.app.jobs, []); assert.deepEqual(__stateForTest().state!.app.ledger, []);
});

it("requests a full hello instead of retaining stale history across a reconnect", () => {
  const sent: unknown[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "browser", send: text => { sent.push(JSON.parse(text)); }, connect() {}, subscribe() {} });
  try {
    __connectionStatusForTest("open");
    __handleFrameForTest({ kind: "snapshot", seq: 1, retainedHistory: ["jobs"], state: FIXTURE_STATE });
    assert.equal(sent.length, 2);
    assert.equal((sent[1] as { kind: string }).kind, "hello");
    __handleFrameForTest({ kind: "snapshot", seq: 2, state: FIXTURE_STATE });
    assert.equal(__stateForTest().state!.app.jobs.length, FIXTURE_STATE.app.jobs.length);
  } finally { __setBridgeForTest(null); }
});

it("falls back once to a legacy hello when an older strict coordinator silently drops the extension", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: { kind: string; retainHistory?: boolean }[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "browser", send: text => { sent.push(JSON.parse(text)); }, connect() {}, subscribe() {} });
  try {
    __connectionStatusForTest("open");
    assert.equal(sent[0]!.retainHistory, true);
    t.mock.timers.tick(15_000);
    assert.equal(sent.length, 2); assert.equal(sent[1]!.retainHistory, undefined);
    t.mock.timers.tick(30_000); assert.equal(sent.length, 2, "only one fallback");
    __handleFrameForTest({ kind: "snapshot", seq: 1, state: FIXTURE_STATE });
    __connectionStatusForTest("open");
    __handleFrameForTest({ kind: "snapshot", seq: 1, state: FIXTURE_STATE });
    t.mock.timers.tick(15_000); assert.equal(sent.length, 3, "a snapshot cancels fallback");
    __connectionStatusForTest("open"); __connectionStatusForTest("auth-refused");
    t.mock.timers.tick(15_000); assert.equal(sent.length, 4, "a closed connection cancels fallback");
  } finally { __setBridgeForTest(null); }
});
