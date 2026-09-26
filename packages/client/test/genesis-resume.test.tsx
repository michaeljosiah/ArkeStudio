import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { GenesisBlueprintSchema, newId, type DomainEvent } from "@arke-studio/contracts";
import { NewWorldScreen } from "../src/screens/shell.js";
import { __applyEventForTest, __setStateForTest, __stateForTest, useGenesis } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("shows resumable drafts and does not duplicate messages replayed after a load", () => {
  __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, health: { ...FIXTURE_STATE.app.health,
    harness: { ...FIXTURE_STATE.app.health.harness, status: "healthy" } } } });
  const at = "2026-09-25T10:00:00.000Z";
  const messageId = newId("msg");
  const snapshot: Extract<DomainEvent, { type: "genesis.loaded" }> = {
    type: "genesis.loaded", at, revision: 1, genesisId: "gen-one", conversationId: newId("cv"),
    blueprint: GenesisBlueprintSchema.parse({ name: "Harbour", characters: [], locations: [], factions: [], threads: [], dropped: [] }),
    turns: [{ id: messageId, role: "user", text: "Remember the closed gate.", at }],
    attachments: [], status: "completed",
  };
  __applyEventForTest(snapshot);
  __applyEventForTest({ ...snapshot, genesisId: "gen-two", conversationId: newId("cv"),
    turns: [], blueprint: { ...snapshot.blueprint, name: "The Mountain" } });
  __applyEventForTest({ type: "genesis.turn", at, genesisId: "gen-one", role: "user", text: "Remember the closed gate.", messageId });
  const html = renderToString(<MemoryRouter initialEntries={["/new?draft=gen-one"]}><NewWorldScreen /></MemoryRouter>);
  assert.ok(html.includes("Continue a draft"));
  assert.ok(html.includes("The Mountain"));
  function Transcript() { return <div>{useGenesis()["gen-one"]!.turns.map(turn => <p key={turn.id}>{turn.text}</p>)}</div>; }
  assert.equal(renderToString(<Transcript />).match(/Remember the closed gate/g)?.length, 1);
  __applyEventForTest({ type: "genesis.turn", at: "2026-09-25T10:01:00.000Z", genesisId: "gen-one", role: "gate", text: "A newer reply.", messageId: newId("msg") });
  __applyEventForTest(snapshot);
  assert.ok(renderToString(<Transcript />).includes("A newer reply."));
  __applyEventForTest({ type: "genesis.blueprint", at, genesisId: "gen-one", blueprint: { ...snapshot.blueprint, name: "Current world" }, revision: 3 });
  __applyEventForTest(snapshot);
  assert.equal(__stateForTest().genesis["gen-one"]?.blueprint?.name, "Current world");
  __applyEventForTest({ type: "genesis.discarded", at, genesisId: "gen-one" });
  __applyEventForTest({ ...snapshot, revision: 4 });
  assert.equal(__stateForTest().genesis["gen-one"], undefined);
});
