import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { GenesisContentCards } from "../src/components/genesis-review.js";
import { GenesisContentReviewSchema, type GenesisReviewCard } from "@arke-studio/contracts";

it("shows the approved revision, changes and explicit decisions for the displayed cards", async () => {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const review = GenesisContentReviewSchema.parse({
    selected: { name: "Harbour", characters: [], locations: [], factions: [], threads: [], dropped: [], reviewed: true },
    problems: [],
    cards: [
      { key: "world", digest: "world-version", title: "Harbour", status: "pending",
        previous: { kind: "world", value: { name: "Harbour", bible: "The gate is closed." } },
        content: { kind: "world", value: { name: "Harbour", bible: "The gate is open." } } },
      { key: "canon:question", digest: "question-version", title: "Who made it?", status: "pending",
        content: { kind: "canon", value: { slug: "question", type: "thread", title: "Who made it?", statement: "Who made the gate?" } } },
    ],
  });
  const decisions: Array<{ cards: GenesisReviewCard[]; decision: string }> = [];
  const revisions: string[] = [];
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<GenesisContentCards review={review} busy={false}
      onDecide={(cards, decision) => decisions.push({ cards, decision })} onRevise={title => revisions.push(title)} />));
    assert.equal(container.querySelector("del")?.textContent, "The gate is closed.");
    assert.equal(container.querySelector("ins")?.textContent, "The gate is open.");
    assert.ok(container.textContent?.includes("Open question"));
    const click = async (text: string) => {
      const button = [...container.querySelectorAll("button")].find(node => node.textContent === text)!;
      assert.ok(button, text);
      await act(async () => button.click());
    };
    await click("Approve this version");
    assert.deepEqual(decisions[0]?.cards.map(card => card.digest), ["world-version"]);
    await click("Reject");
    assert.equal(decisions[1]?.decision, "reject");
    await click("Request changes");
    assert.deepEqual(revisions, ["Harbour"]);
    await click("Approve all 2 pending items shown above");
    assert.deepEqual(decisions[2]?.cards.map(card => card.digest), ["world-version", "question-version"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("ignores out-of-order reviews and clears approval cards when the blueprint changes", async () => {
  const store = await import("../src/lib/store.js");
  const { FIXTURE_STATE } = await import("./fixture-state.js");
  const sent: Array<{ requestId: string }> = [];
  store.__setStateForTest(FIXTURE_STATE);
  store.__setBridgeForTest({ send: (message: string) => sent.push(JSON.parse(message)) } as unknown as import("../src/arke-bridge.js").ArkeBridge);
  const selected = { name: "Harbour", characters: [], locations: [], factions: [], threads: [], dropped: [], reviewed: true };
  const review = GenesisContentReviewSchema.parse({ selected, cards: [], problems: [] });
  const event = { type: "genesis.review" as const, at: new Date().toISOString(), genesisId: "gen-review", review };
  try {
    store.reviewGenesisDraft("gen-review"); store.reviewGenesisDraft("gen-review");
    store.__applyEventForTest({ ...event, requestId: sent[1]!.requestId });
    store.__applyEventForTest({ ...event, requestId: sent[0]!.requestId, review: { ...review, problems: ["Old response"] } });
    assert.deepEqual(store.__stateForTest().genesis["gen-review"]?.review?.problems, []);
    store.__applyEventForTest({ type: "genesis.blueprint", at: event.at, genesisId: event.genesisId, blueprint: selected });
    assert.equal(store.__stateForTest().genesis["gen-review"]?.review, undefined);
    store.__applyEventForTest({ ...event, requestId: sent[1]!.requestId });
    assert.equal(store.__stateForTest().genesis["gen-review"]?.review, undefined);
  } finally { store.__setBridgeForTest(null); store.__setStateForTest(FIXTURE_STATE); }
});
it("keeps a content decision pending and invalidates the displayed build until its review arrives", async () => {
  const store = await import("../src/lib/store.js");
  const { FIXTURE_STATE } = await import("./fixture-state.js");
  const sent: Array<{ requestId: string }> = [];
  store.__setStateForTest(FIXTURE_STATE);
  store.__setBridgeForTest({ send: (message: string) => sent.push(JSON.parse(message)) } as unknown as import("../src/arke-bridge.js").ArkeBridge);
  try {
    store.decideGenesisDraft("gen-decision", [{ key: "world", digest: "current" }], "approve");
    assert.equal(store.__stateForTest().genesis["gen-decision"]?.reviewPending, true);
    assert.deepEqual(store.__stateForTest().buildPlans["gen-decision"], {});
    const review = GenesisContentReviewSchema.parse({ selected: { name: "Harbour", characters: [], locations: [], factions: [], threads: [], dropped: [] }, cards: [], problems: [] });
    store.__applyEventForTest({ type: "genesis.review", at: new Date().toISOString(), genesisId: "gen-decision", requestId: "old", review });
    assert.equal(store.__stateForTest().genesis["gen-decision"]?.reviewPending, true);
    store.__applyEventForTest({ type: "genesis.review", at: new Date().toISOString(), genesisId: "gen-decision", requestId: sent[0]!.requestId, review });
    assert.equal(store.__stateForTest().genesis["gen-decision"]?.reviewPending, false);
  } finally { store.__setBridgeForTest(null); store.__setStateForTest(FIXTURE_STATE); }
});
