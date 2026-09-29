import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { VoiceSampleFlow } from "../src/components/character-voice-sample.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A production take is always reviewed as a range: a clip is a whole shot, and the sample wants the
 * seconds where one voice speaks alone. A mutation sample found the branch untested — with the
 * `take` test inverted, a take with a range that ends before it starts went to the coordinator
 * as if it were a whole artifact. The flow is mounted and the take pressed, twice.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const open: Root[] = [];
afterEach(async () => {
  for (const root of open.splice(0)) await act(async () => root.unmount());
  dom.document.body.replaceChildren();
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});

it("reviews a take as a range, and refuses a range that ends before it starts", async () => {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } } as unknown as ArkeBridge);
  __setStateForTest(FIXTURE_STATE);
  const world = FIXTURE_STATE.world!;
  const sheet = world.sheets.find((candidate) => candidate.type === "character")!;
  const clip = world.productions.flatMap((production) => production.takes.map((take) => ({ production, take }))).find(({ take }) => take.kind === "clip" && take.media)!;
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(host);
  const root = createRoot(host);
  open.push(root);
  await act(async () => root.render(<VoiceSampleFlow world={world} sheet={sheet} onClose={() => {}} />));
  const row = host.querySelector<HTMLElement>(`[data-source="take:${clip.production.meta.id}:${clip.take.id}"]`)!;
  assert.ok(row, "the clip take is offered as a source");
  const review = () => [...row.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Review")!;
  const prepared = () => sent.filter((message): message is Extract<ClientMessage, { kind: "prepare-character-voice-sample" }> => message.kind === "prepare-character-voice-sample");

  await act(async () => review().click());
  assert.equal(prepared().length, 1, "the default range is a real one, so the take goes");
  const first = prepared()[0]!;
  assert.equal(first.source.kind, "production-take");
  assert.deepEqual(first.source.kind === "production-take" ? first.source.range : null, { inSec: 0, outSec: 8 }, "as a range, never whole");

  // The coordinator answers, the flow is free again, and the end is dragged before the start.
  await act(async () => __applyEventForTest({ type: "voice.sample-result", at: "2026-09-12T08:00:00.000Z", requestId: first.requestId, worldId: FIXTURE_WORLD_ID, sheetId: sheet.id, status: "refused", reason: "No speech in that range." }));
  assert.equal(review().disabled, false);
  const end = host.querySelector<HTMLInputElement>('input[aria-label="End seconds"]')!;
  assert.ok(end, "a take shows its range controls without asking for a trim");
  const props = (end as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[Object.keys(end).find((k) => k.startsWith("__reactProps$"))!]!;
  await act(async () => props.onChange({ target: { value: "0" } }));
  await act(async () => review().click());
  assert.equal(prepared().length, 1, "a range that ends before it starts is refused here, not sent");
  assert.match(host.textContent ?? "", /Give a range that ends after it starts\./);
});
