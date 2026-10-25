import assert from "node:assert/strict";
import { it } from "node:test";
import type { HarnessAdapter } from "@arke-studio/contracts";
import { HarnessRuntimeChanges } from "../src/harness/runtime-change.js";

it("refuses reconfiguration during cloud turns and prevents new turns during a reserved change", async () => {
  const gate = new HarnessRuntimeChanges();
  let endTurn!: () => void, endChange!: () => void;
  const adapter = gate.wrap({ sendMessage: async () => {
    await new Promise<void>(resolve => { endTurn = resolve; });
    return { sessionId: "cloud", correlationId: "turn" };
  } } as HarnessAdapter);
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
