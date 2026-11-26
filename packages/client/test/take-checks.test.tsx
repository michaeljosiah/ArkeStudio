import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage, ProductionBundle, Take, TakeChecksRecord } from "@arke-studio/contracts";
import { TakeChecks } from "../src/components/take-checks.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * A take's checks on the Generate bench (design turn 288c): the count beside its verdicts, the list
 * it opens, and Check for a take that has none of its media now.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  dom.document.body.innerHTML = "";
});

const SALTLIGHT = FIXTURE_STATE.world!.productions.find((production) => production.meta.id === "saltlight")!;
const base = SALTLIGHT.takes.find((take) => take.kind === "clip")!;
const CLIP: Take = { ...base, coversShots: [base.coversShots[0]!], media: "clip.mp4", mediaHash: "sha256:0123456789abcdef" };
const RECORD: TakeChecksRecord = {
  schemaVersion: 1, kind: "after-take", ts: "2026-11-25T12:00:00.000Z", takeId: CLIP.id, shotId: CLIP.coversShots[0]!, sourceHash: CLIP.mediaHash!,
  items: [
    { id: "words", result: "pass", says: "as written" },
    { id: "unwritten-voice", result: "fix", says: "at 7.6 s", endAtSec: 7.5 },
    { id: "cuts-inside", result: "pass", says: "none" },
    { id: "camera", result: "pass", says: "handheld · 7 px" },
  ],
  skipped: [{ id: "lip-sync", reason: "no-voice-sent" }],
};

async function mount(production: ProductionBundle, take: Take) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (json: string) => { sent.push(JSON.parse(json)); } } satisfies ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    __setStateForTest(FIXTURE_STATE, { connection: "open" });
    root!.render(<TakeChecks worldId={FIXTURE_WORLD_ID} production={production} take={take} />);
  });
  return { container, sent };
}

const click = async (element: Element | null) => {
  assert.ok(element, "present");
  await act(async () => element.dispatchEvent(new dom.Event("click", { bubbles: true })));
};

describe("a take's checks on the bench (design turn 288c)", () => {
  it("counts what passed beside the take and opens the list, labels and figures only", async () => {
    const { container } = await mount({ ...SALTLIGHT, takeChecks: { [CLIP.id]: RECORD } }, CLIP);
    const count = container.querySelector(".fy-takechecks__count")!;
    assert.equal(count.textContent, "Checks · 3 of 4");
    assert.ok(count.querySelector(".fy-dot--warn"), "one to fix");
    assert.equal(container.querySelector(".fy-takechecks__panel"), null);
    await click(count);
    const rows = [...container.querySelectorAll(".fy-takechecks__row")].map((row) => [row.querySelector(".fy-takechecks__label")!.textContent, row.querySelector(".fy-takechecks__result")!.textContent, row.getAttribute("data-result")]);
    assert.deepEqual(rows, [["Words", "as written", "pass"], ["Voice nobody wrote", "at 7.6 s", "fix"], ["Cuts inside", "none", "pass"], ["Camera", "handheld · 7 px", "pass"]]);
    assert.equal(container.querySelector(".fy-takechecks__panel small, .fy-takechecks__panel p"), null, "no caption");
  });

  it("counts and lists a check that could not be made, so a take is never all green with one missing (2026-11-26)", async () => {
    const unread: TakeChecksRecord = { ...RECORD, items: [{ id: "cuts-inside", result: "pass", says: "none" }, { id: "camera", result: "pass", says: "handheld · 7 px" }],
      skipped: [{ id: "words", reason: "unavailable" }, { id: "unwritten-voice", reason: "unavailable" }, { id: "lip-sync", reason: "no-voice-sent" }] };
    const { container } = await mount({ ...SALTLIGHT, takeChecks: { [CLIP.id]: unread } }, CLIP);
    const count = container.querySelector(".fy-takechecks__count")!;
    assert.equal(count.textContent, "Checks · 2 of 4", "it read 2 of 2");
    assert.ok(count.querySelector(".fy-dot--warn"));
    await click(count);
    const rows = [...container.querySelectorAll(".fy-takechecks__row")].map((row) => [row.querySelector(".fy-takechecks__label")!.textContent, row.querySelector(".fy-takechecks__result")!.textContent]);
    assert.deepEqual(rows, [["Cuts inside", "none"], ["Camera", "handheld · 7 px"], ["Words", "not checked"], ["Voice nobody wrote", "not checked"]],
      "what the take has nothing for (no read sent) is not listed");
  });

  it("checks a take without checks of its media the first time it is shown, and offers Check if that is refused", async () => {
    const stale = { ...RECORD, sourceHash: "sha256:ffffffffffffffff" };
    const production = { ...SALTLIGHT, takeChecks: { [CLIP.id]: stale } };
    const { container, sent } = await mount(production, CLIP);
    assert.equal(container.querySelector(".fy-takechecks__count"), null, "checks of other media are not this take's");
    const asked = (messages: ClientMessage[]) => messages.filter((message) => message.kind === "check-take");
    assert.deepEqual(asked(sent), [{ kind: "check-take", worldId: FIXTURE_WORLD_ID, productionId: "saltlight", takeId: CLIP.id }], "checked on sight, once");
    assert.equal(container.querySelector("button")!.textContent, "Checking…");
    await act(async () => __applyEventForTest({ at: "2026-11-25T12:00:00.000Z", type: "command.failed", command: "check-take", requestId: null, reason: "No tools." }));
    assert.equal(container.querySelector("button")!.textContent, "Check");
    await click(container.querySelector("button"));
    assert.equal(asked(sent).length, 2, "the press asks again");
    // Shown again later in the same window, a take already asked about is not asked again on its own.
    await act(async () => root!.unmount()); root = null;
    const again = await mount(production, CLIP);
    assert.equal(asked(again.sent).length, 0);
  });

  it("is not on a still or a take of several shots", async () => {
    const still = await mount(SALTLIGHT, { ...CLIP, kind: "frame" });
    assert.equal(still.container.innerHTML, "");
  });
});
