import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { BenchTake, ClientMessage } from "@arke-studio/contracts";
import { BenchCharacterKit } from "../src/components/bench-character-kit.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("asks for a destination, sends no generation and accepts only its correlated result", async () => {
  const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
  Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0) });
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ connect() {}, subscribe() {}, send: (json: string) => sent.push(JSON.parse(json)) } as unknown as ArkeBridge);
  const root = createRoot(dom.document.getElementById("root")! as unknown as HTMLElement);
  const worldId = FIXTURE_STATE.world!.meta.worldId, sessionId = "sess_01J8Z3X4Y5Z6A7B8C9D0E1F2G1", takeId = "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2G2";
  const query = (selector: string) => dom.document.querySelector(selector) as unknown as HTMLElement;
  const click = async (selector: string) => act(async () => query(selector).click());
  try {
    await act(async () => {
      __setStateForTest(FIXTURE_STATE, { connection: "open" });
      root.render(<BenchCharacterKit worldId={worldId} sessionId={sessionId} take={{ id: takeId, n: 3 } as BenchTake} />);
    });
    await click('[data-testid="bench-use-reference"]');
    assert.equal((query('[data-testid="bench-use-reference-confirm"]') as HTMLButtonElement).disabled, true);
    for (const [label, value] of [["Character", "maren-kest"], ["Use as", "character-sheet"]]) {
      const select = query(`select[aria-label="${label}"]`);
      const props = (select as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[Object.keys(select).find(key => key.startsWith("__reactProps$"))!]!;
      await act(async () => props.onChange({ target: { value: value! } }));
    }
    assert.match(dom.document.body.textContent!, /No new image is generated/);
    await click('[data-testid="bench-use-reference-confirm"]');
    assert.deepEqual(sent.map(message => message.kind), ["bench-use-reference"]);
    const command = sent[0] as Extract<ClientMessage, { kind: "bench-use-reference" }>;
    assert.equal(command.image, "character-sheet");
    assert.equal(command.sheetId, "maren-kest");
    assert.equal(command.takeId, takeId);
    assert.equal((query('[data-testid="bench-use-reference-confirm"]') as HTMLButtonElement).disabled, true);
    const reply = { type: "bench.reference-used" as const, at: "2026-11-03T10:00:00.000Z", worldId, sessionId, takeId, accepted: true };
    await act(async () => __applyEventForTest({ ...reply, requestId: "01J8Z3X4Y5Z6A7B8C9D0E1F2G4" }));
    assert.ok(query('[data-testid="bench-use-reference-confirm"]'));
    await act(async () => __applyEventForTest({ ...reply, requestId: command.requestId }));
    assert.equal(query('[data-testid="bench-use-reference-confirm"]'), null);
    assert.match(dom.document.body.textContent!, /Image added to the character kit/);
  } finally {
    await act(async () => root.unmount());
    __setBridgeForTest(null);
    __setStateForTest(FIXTURE_STATE);
  }
});
