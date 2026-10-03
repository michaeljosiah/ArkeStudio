import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { GenesisBlueprintSchema, newId, type DomainEvent } from "@arke-studio/contracts";
import { NewWorldScreen } from "../src/screens/shell.js";
import { __applyEventForTest, __setStateForTest, __setBridgeForTest, __stateForTest, genesisChat, reviewGenesisReadiness, useGenesis } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("holds the founding composer immediately and keeps review failures separate from the turn", () => {
  const sent: string[] = [];
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest({ send: (message: string) => sent.push(message) } as unknown as ArkeBridge);
  try {
    assert.equal(genesisChat("gen-race", "First", "ollama/chosen"), true);
    assert.equal(genesisChat("gen-race", "Again"), false);
    reviewGenesisReadiness("gen-race");
    assert.equal(sent.length, 1);
    assert.equal(JSON.parse(sent[0]!).modelId, "ollama/chosen");
    __applyEventForTest({ type: "genesis.status", at: "2026-10-03T10:00:00.000Z", genesisId: "gen-race", status: "running" });
    __applyEventForTest({ type: "genesis.review-error", at: "2026-10-03T10:00:01.000Z", genesisId: "gen-race", area: "voices", detail: "Wait for this turn." });
    assert.equal(__stateForTest().genesis["gen-race"]?.status, "running");
    assert.equal(__stateForTest().genesis["gen-race"]?.voiceError, "Wait for this turn.");
    __applyEventForTest({ type: "genesis.status", at: "2026-10-03T10:00:02.000Z", genesisId: "gen-race", status: "completed" });
    assert.equal(genesisChat("gen-race", "Next"), true);
  } finally { __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE); }
});

it("offers a writing model without empty review sections on the founding front door", async () => {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, health: { ...FIXTURE_STATE.app.health, harness: { status: "healthy" } },
    harnessModelStatus: { status: "ready" }, harnessModels: [{ id: "writing", provider: "ollama", displayName: "Writing" }] } });
  const container = dom.document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={["/new?draft=gen-empty"]}><NewWorldScreen /></MemoryRouter>));
    assert.ok(container.querySelector('select[aria-label="Writing model"]'));
    assert.match(container.textContent ?? "", /What is this world/);
    assert.doesNotMatch(container.textContent ?? "", /Review world content|Review the world|Available voices/);
  } finally { await act(async () => root.unmount()); __setStateForTest(FIXTURE_STATE); }
});

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
