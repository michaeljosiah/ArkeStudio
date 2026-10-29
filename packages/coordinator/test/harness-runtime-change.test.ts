import assert from "node:assert/strict";
import { it } from "node:test";
import type { HarnessAdapter } from "@arke-studio/contracts";
import { HarnessRuntimeChanges } from "../src/harness/runtime-change.js";
import { until } from "./wait.js";

it("a private send error keeps settings/recovery admission held until native turn settlement", async () => {
  const gate = new HarnessRuntimeChanges(); let complete!: () => void, sent = 0;
  const native = new Promise<void>(resolve => { complete = resolve; });
  const raw = { createSession: async () => ({ sessionId: "private", privateTurnSettled: native }),
    sendMessage: async () => { sent++; throw new Error("native outcome unknown"); } } as unknown as HarnessAdapter;
  const adapter = gate.wrap(raw); await adapter.createSession({ purpose: "ask", agent: "studio-assistant", visibility: "private" });
  const turn = assert.rejects(adapter.sendMessage({ sessionId: "private", parts: [] }), /native outcome unknown/);
  await until(() => sent === 1, "the private send reaches its native owner");
  await assert.rejects(gate.run(async () => {}), /Finish or cancel writing/);
  let reserved = false; const recovery = gate.reserveRecovery(new AbortController().signal).then(release => { reserved = true; return release; });
  await Promise.resolve(); assert.equal(reserved, false);
  await assert.rejects(adapter.sendMessage({ sessionId: "other", parts: [] }), /recovering/);
  complete(); await turn; const release = await recovery; assert(reserved); release();
  await gate.run(async () => {}); assert.equal(sent, 1, "only a newly authorized turn can dispatch again");
});

it("a rejected private final fence retires without waiting for an unstarted native turn", async () => {
  const gate = new HarnessRuntimeChanges(); let sent = 0;
  const raw = { createSession: async () => ({ sessionId: "private", privateTurnSettled: new Promise<void>(() => {}) }),
    sendMessage: async () => { sent++; return { sessionId: "private", correlationId: "private" }; } } as unknown as HarnessAdapter;
  const adapter = gate.wrap(raw); await adapter.createSession({ purpose: "ask", visibility: "private", agent: "studio-assistant" });
  await assert.rejects(adapter.sendMessageWithFence!({ sessionId: "private", parts: [] }, () => { throw new Error("route changed"); }), /route changed/);
  await gate.run(async () => {}); assert.equal(sent, 0);
});

it("keeps guarded dispatch inside runtime admission and lets a rejected final fence prevent the send", async () => {
  const gate = new HarnessRuntimeChanges(); let sent = 0, checked = 0, finish!: () => void;
  const raw = { sendMessage: async () => { sent++; return { sessionId: "studio", correlationId: "studio" }; } } as unknown as HarnessAdapter;
  const adapter = gate.wrap(raw), input = { sessionId: "studio", parts: [] };
  const change = gate.run(async () => { await new Promise<void>(resolve => { finish = resolve; }); });
  await assert.rejects(adapter.sendMessageWithFence!(input, () => { checked++; }), /settings are changing/);
  assert.equal(checked, 0); assert.equal(sent, 0); finish(); await change;
  await assert.rejects(adapter.sendMessageWithFence!(input, () => { checked++; throw new Error("approved route changed"); }), /route changed/);
  assert.equal(checked, 1); assert.equal(sent, 0);
  const release = await gate.reserveRecovery(new AbortController().signal);
  await assert.rejects(adapter.sendMessageWithFence!(input, () => { checked++; }), /recovering/);
  assert.equal(checked, 1); release();
  await adapter.sendMessageWithFence!(input, () => { checked++; }); assert.equal(sent, 1); assert.equal(checked, 2);
});

it("refuses reconfiguration during cloud turns and prevents new turns during a reserved change", async () => {
  const gate = new HarnessRuntimeChanges();
  let endTurn!: () => void, endChange!: () => void;
  const raw: HarnessAdapter = {
    id: "test", capabilities: () => new Set(), readiness: () => ({ ready: true }),
    createSession: async () => ({ sessionId: "cloud" }),
    streamEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    dispatchAsync: async () => { throw new Error("Coordinator owns async dispatch through sendMessage"); },
    sendMessage: async () => {
      await new Promise<void>(resolve => { endTurn = resolve; });
      return { sessionId: "cloud", correlationId: "turn" };
    },
  };
  const adapter = gate.wrap(raw);
  const turn = adapter.sendMessage({ sessionId: "cloud", parts: [] });
  let applied = false;
  await assert.rejects(gate.run(async () => { applied = true; }), /Finish or cancel writing/);
  assert.equal(applied, false);
  endTurn(); await turn;
  const change = gate.run(async () => { applied = true; await new Promise<void>(resolve => { endChange = resolve; }); });
  await assert.rejects(adapter.sendMessage({ sessionId: "cloud", parts: [] }), /settings are changing/);
  endChange(); await change;
  assert.equal(applied, true);
});

it("recovery waits for admitted turns, closes new turn/change admission and releases once", async () => {
  const gate = new HarnessRuntimeChanges(); let finish!: () => void, sent = 0;
  const raw = { sendMessage: async () => { sent++; await new Promise<void>(resolve => { finish = resolve; }); return { sessionId: "cloud", correlationId: "turn" }; } } as unknown as HarnessAdapter;
  const adapter = gate.wrap(raw), turn = adapter.sendMessage({ sessionId: "cloud", parts: [] });
  let reserved = false; const acquiring = gate.reserveRecovery(new AbortController().signal).then(release => { reserved = true; return release; });
  await Promise.resolve(); assert(!reserved); assert.equal(sent, 1);
  await assert.rejects(adapter.sendMessage({ sessionId: "other", parts: [] }), /recovering/);
  await assert.rejects(gate.run(async () => {}), /Finish or cancel/);
  finish(); await turn; const release = await acquiring; assert(reserved);
  await assert.rejects(gate.reserveRecovery(new AbortController().signal), /already reserved/);
  release(); release(); let changed = false; await gate.run(async () => { changed = true; }); assert(changed); assert.equal(sent, 1, "recovery never replayed the turn");
});

it("cancelled recovery waiting behind a change restores admission without running or replaying a turn", async () => {
  const gate = new HarnessRuntimeChanges(); let finish!: () => void;
  const changing = gate.run(async () => new Promise<void>(resolve => { finish = resolve; }));
  const cancellation = new AbortController(), acquiring = gate.reserveRecovery(cancellation.signal);
  cancellation.abort(new Error("shutdown")); await assert.rejects(acquiring, /shutdown/); finish(); await changing;
  const release = await gate.reserveRecovery(new AbortController().signal); release();
  await gate.run(async () => {});
});
