import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useEffectReviewPosition, type EffectReviewPositionOwner } from "../src/screens/editor-effect-review-position.js";
import type { EffectReviewPosition } from "../src/lib/editor-effect-review-state.js";
import type { CutSelection } from "../src/screens/editor-inspector.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); });
type Active = NonNullable<EffectReviewPositionOwner["active"]>;
function active(owner: string, versionId: string, activationSerial: number, position: EffectReviewPosition | null): Active {
  return { ref: { familyId: `req_${owner}`, versionId, candidateHash: "0".repeat(64), decisionRevision: 0 },
    activationSerial, comparison: "suggested", position };
}
function harness() {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  const seeks: Array<{ owner: string; seconds: number }> = [], saves: Array<{ owner: string; position: EffectReviewPosition }> = [];
  let latest!: { time: number; selected: CutSelection | null; canvas: HTMLDivElement | null;
    move: (time: number) => void; select: (selection: CutSelection | null) => void };
  function Probe({ ownerKey, review }: { ownerKey: string; review: Active | null }) {
    const canvas = useRef<HTMLDivElement>(null), timeRef = useRef(0);
    const [time, setTime] = useState(0), [selected, setSelected] = useState<CutSelection | null>(null);
    const move = (seconds: number) => { timeRef.current = seconds; setTime(seconds); };
    useEffectReviewPosition({ active: review, rememberPosition: position => saves.push({ owner: ownerKey, position }) }, {
      ownerKey, frameRate: 24, transport: { time, timeRef, seek: seconds => { seeks.push({ owner: ownerKey, seconds }); move(seconds); } },
      canvas, selected, onSelect: setSelected,
    });
    latest = { time, selected, canvas: canvas.current, move, select: setSelected };
    return <div ref={canvas} data-testid="canvas" />;
  }
  return { root, container, seeks, saves, latest: () => ({ ...latest, canvas: container.querySelector<HTMLDivElement>("div")! }),
    render: (ownerKey: string, review: Active | null) => act(async () => root.render(<Probe ownerKey={ownerKey} review={review} />)) };
}

describe("review position restoration (SPEC-053 R-31, R-38)", () => {
  it("restores a retained review's seek, selection and scroll exactly once", async () => {
    const h = harness(), saved = active("A", "v1", 3, { playheadFrame: 144, selectedEffectId: "cl_A", scrollLeft: 70 });
    await h.render("world/A", saved);
    assert.deepEqual(h.seeks, [{ owner: "world/A", seconds: 6 }]);
    assert.deepEqual(h.latest().selected, { kind: "effect", id: "cl_A" }); assert.equal(h.latest().canvas.scrollLeft, 70);
    await h.render("world/A", { ...saved, position: { playheadFrame: 24, selectedEffectId: "cl_old", scrollLeft: 1 } });
    assert.equal(h.seeks.length, 1); assert.equal(h.latest().time, 6); assert.equal(h.latest().canvas.scrollLeft, 70);
    await act(async () => { h.latest().move(8); h.latest().canvas.scrollLeft = 92; h.latest().canvas.dispatchEvent(new Event("scroll")); });
    assert.equal(h.saves.at(-1)!.position.playheadFrame, 192); assert.equal(h.saves.at(-1)!.position.scrollLeft, 92);
  });
  it("does not seek for an explicit first Review while Cut is already open", async () => {
    const h = harness(); await h.render("world/A", null);
    await act(async () => { h.latest().move(17); h.latest().select({ kind: "effect", id: "cl_current" }); h.latest().canvas.scrollLeft = 110; });
    await h.render("world/A", active("A", "v1", 1, { playheadFrame: 24, selectedEffectId: "cl_old", scrollLeft: 3 }));
    assert.deepEqual(h.seeks, []); assert.equal(h.latest().time, 17);
    assert.deepEqual(h.latest().selected, { kind: "effect", id: "cl_current" }); assert.equal(h.latest().canvas.scrollLeft, 110);
    assert.equal(h.saves.at(-1)!.position.playheadFrame, 408);
  });
  it("restores a reload whose retained reference arrives after the initial render", async () => {
    const h = harness(); await h.render("world/A", null);
    await h.render("world/A", active("A", "v1", 0, { playheadFrame: 216, selectedEffectId: "cl_A", scrollLeft: 45 }));
    assert.deepEqual(h.seeks, [{ owner: "world/A", seconds: 9 }]); assert.equal(h.latest().canvas.scrollLeft, 45);
  });
  it("switches directly from production A to B without copying A's clock or selection into B", async () => {
    const h = harness(); await h.render("world/A", active("A", "v1", 1, { playheadFrame: 72, selectedEffectId: "cl_A", scrollLeft: 15 }));
    await act(async () => { h.latest().move(19); h.latest().canvas.scrollLeft = 160; h.latest().canvas.dispatchEvent(new Event("scroll")); });
    const marker = h.saves.length;
    await h.render("world/B", active("B", "v1", 2, { playheadFrame: 264, selectedEffectId: "cl_B", scrollLeft: 55 }));
    assert.equal(h.latest().time, 11); assert.deepEqual(h.latest().selected, { kind: "effect", id: "cl_B" }); assert.equal(h.latest().canvas.scrollLeft, 55);
    assert.deepEqual(h.seeks.at(-1), { owner: "world/B", seconds: 11 });
    assert.ok(h.saves.slice(marker).every(row => row.owner === "world/B" && row.position.playheadFrame === 264 && row.position.selectedEffectId === "cl_B"),
      "old effect cleanup must not save A's view into B");
    await act(async () => { h.latest().canvas.scrollLeft = 66; h.latest().canvas.dispatchEvent(new Event("scroll")); });
    assert.equal(h.saves.at(-1)!.owner, "world/B"); assert.equal(h.saves.at(-1)!.position.scrollLeft, 66);
  });
  it("clears A's selection when B explicitly retained no effect selection", async () => {
    const h = harness(); await h.render("world/A", active("A", "v1", 1, { playheadFrame: 72, selectedEffectId: "cl_A" }));
    await h.render("world/B", active("B", "v1", 2, { playheadFrame: 240, scrollLeft: 0 }));
    assert.equal(h.latest().selected, null); assert.equal(h.latest().time, 10);
    // Restoration need not rewrite the already retained B position. The next actual save must
    // carry B's cleared selection, never the preceding production's selection.
    await act(async () => h.latest().canvas.dispatchEvent(new Event("scroll")));
    assert.equal(h.saves.at(-1)!.owner, "world/B");
    assert.equal(h.saves.at(-1)!.position.selectedEffectId, undefined);
  });
  it("never rewinds for pending edits, incoming cards, comparison changes or another explicit Review", async () => {
    const h = harness(), initial = active("A", "v1", 1, { playheadFrame: 120, selectedEffectId: "cl_A", scrollLeft: 50 });
    await h.render("world/A", initial); await act(async () => h.latest().move(13));
    const seeks = h.seeks.length;
    for (const value of [initial, { ...initial, comparison: "current" as const }, active("A", "v2", 1, initial.position), active("A", "v3", 2, initial.position)])
      await h.render("world/A", value);
    assert.equal(h.seeks.length, seeks); assert.equal(h.latest().time, 13);
    assert.equal(h.saves.at(-1)!.position.playheadFrame, 312);
  });
});
