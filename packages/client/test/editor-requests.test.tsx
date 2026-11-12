import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import {
  applyTimelineCommands,
  orderedTrackClips,
  seedStoryPictureTimeline,
  storyTimelineFingerprint,
  undoTimelineHistory,
  type EditorRequest,
  type TextLook,
  type TimelineClipCommand,
} from "@arke-studio/contracts";
import { ProductionTimelineCard } from "../src/components/production-timeline-card.js";
import { __setStateForTest } from "../src/lib/store.js";
import { EditorRequestCards } from "../src/screens/editor-requests.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The request card (SPEC-039 R-29, R-33, R-34, R-36; issue 684): it states what the request does,
 * carries Accept and Reject only while the request can still land, says why a stale one cannot,
 * and reports an accepted request whose revision was later undone.
 */

const production = FIXTURE_STATE.world!.productions[0]!;
const seeded = seedStoryPictureTimeline(production);
const clips = orderedTrackClips(seeded.tracks[0]!);
const fingerprint = storyTimelineFingerprint(production);
const REQUEST = "req_01J8G0000000000000000000R1";

function request(over: Partial<EditorRequest> = {}): EditorRequest {
  return {
    id: REQUEST,
    productionId: production.meta.id,
    conversationId: "cv_01J8G0000000000000000000C1",
    baseRevision: null,
    sourceFingerprint: fingerprint,
    commands: [{ kind: "move-adjacent", clipId: clips[1]!.id, direction: "earlier" }],
    summary: "Swap the first two shots",
    createdAt: "2026-09-02T10:00:00Z",
    status: "pending",
    ...over,
  };
}

function render(requests: EditorRequest[], timelineState: Parameters<typeof EditorRequestCards>[0]["timelineState"], base = seeded): string {
  return renderToString(
    <EditorRequestCards
      requests={requests}
      base={base}
      timelineState={timelineState}
      currentFingerprint={fingerprint}
      frameRate={seeded.frameRate}
      ghostId={null}
      onGhost={() => {}}
      onDecide={() => {}}
      disabled={false}
    />,
  ).replaceAll("<!-- -->", "");
}

describe("editor request cards (issue 684)", () => {
  it("states what a pending request does and offers exactly Accept, Reject and Preview", () => {
    const html = render([request()], { status: "absent" });
    assert.match(html, /Swap the first two shots/);
    assert.match(html, /data-status="pending"/);
    assert.match(html, /Moves /, "what moves is named");
    assert.match(html, /Story order changes/);
    assert.match(html, />Accept</);
    assert.match(html, />Reject</);
    assert.match(html, />Preview</);
  });

  it("says why a stale request cannot land and offers no Accept", () => {
    const html = render([request({ sourceFingerprint: `story-picture-v1:${"0".repeat(16)}` })], { status: "absent" });
    assert.match(html, /data-status="stale"/);
    assert.match(html, /ask Arke again/);
    assert.doesNotMatch(html, />Accept</);
    assert.doesNotMatch(html, />Preview</);
    assert.match(html, />Reject</, "a stale card can still be dismissed, and the record says stale");
  });

  it("keeps an accepted request's status and reports its revision undone (R-36)", () => {
    const accepted = applyTimelineCommands(seeded, [{ kind: "move-adjacent", clipId: clips[1]!.id, direction: "earlier" }], { requestId: REQUEST });
    const record = request({ status: "accepted", baseRevision: null, resultRevision: 1, decidedAt: "2026-09-02T10:01:00Z" });
    const landed = render([record], { status: "ready", timeline: accepted }, accepted);
    assert.match(landed, /data-status="accepted"/);
    assert.match(landed, /r1/);
    assert.doesNotMatch(landed, /undone/);
    assert.doesNotMatch(landed, />Accept</);
    const undone = render([{ ...record, undoneAt: "2026-09-02T10:02:00Z" }], { status: "ready", timeline: undoTimelineHistory(accepted) }, undoTimelineHistory(accepted));
    assert.match(undone, /accepted · r1 · undone/);
  });
});

describe("text on a request card (SPEC-065 R-36)", () => {
  // The promo's name look: EB Garamond at the Lower third.
  const PROMO: TextLook = { typeface: "eb-garamond", weight: "regular", italic: false, size: 0.071, tracking: 0, leading: 1.2, capitals: false, align: "center",
    x: 0.5, y: 0.75, room: 0.815, fill: { kind: "solid", color: "#f6da94" }, edge: { color: "#1a1208", width: 0.022 } };
  const NAMES = [["cl_ade", "Ade\nthe healer", 24], ["cl_ife", "Ifẹ", 160], ["cl_kemi", "Kemi", 296], ["cl_tunde", "Tunde", 432]] as const;
  // Both a request's commands and the reducer's: an add-track and four places.
  const FOUR: Extract<TimelineClipCommand, { kind: "add-track" | "place" }>[] = [{ kind: "add-track", trackId: "tr_names", trackKind: "picture", name: "Names" },
    ...NAMES.map(([id, text, startFrame]) => ({ kind: "place" as const, trackId: "tr_names" as const, clip: { id, startFrame, durationFrames: 112, sourceInFrames: 0,
      source: { kind: "text" as const, label: text.split("\n")[0]!, text, look: PROMO } } }))];
  const LINES = [
    "Adds text “Ade ⏎ the healer” · Names · frames 24–136 · Lower third",
    "Adds text “Ifẹ” · Names · frames 160–272 · Lower third",
    "Adds text “Kemi” · Names · frames 296–408 · Lower third",
    "Adds text “Tunde” · Names · frames 432–544 · Lower third",
  ];
  const named = applyTimelineCommands(seeded, FOUR);
  const pending = (commands: EditorRequest["commands"], base = seeded, id = REQUEST): EditorRequest =>
    request({ id, commands, baseRevision: base.revision, summary: "Name the four" });
  afterEach(() => __setStateForTest(FIXTURE_STATE));

  it("states four names in full, with their frames, track and place", () => {
    const html = render([pending(FOUR)], { status: "ready", timeline: seeded });
    for (const line of LINES) assert.ok(html.includes(`<li>${line}</li>`), line);
    assert.match(html, />Accept</);
    assert.match(html, />Preview</);
  });

  it("states a text-set's words and values before and after", () => {
    const html = render([
      pending([{ kind: "text-set", clipIds: ["cl_tunde"], text: "Tunde\nthe drummer" }], named),
      pending([{ kind: "text-set", clipIds: NAMES.map(([id]) => id), look: { size: 0.09, edge: null } }], named, "req_01J8G0000000000000000000R2"),
    ], { status: "ready", timeline: named }, named);
    assert.ok(html.includes("Changes text “Tunde” · Words “Tunde” → “Tunde ⏎ the drummer”"));
    for (const words of ["Ade ⏎ the healer", "Ifẹ", "Kemi", "Tunde"]) {
      assert.ok(html.includes(`Changes text “${words}” · Size 7.1% → 9% · Edge #1a1208, width 2.2% → None`), words);
    }
  });

  it("the conversation card's timeline preview lists the same lines, and none when it is not a comparison", () => {
    __setStateForTest(FIXTURE_STATE);
    const world = FIXTURE_STATE.world!;
    const preview = { kind: "timeline" as const, before: seeded, after: named, range: { startFrame: 24, endFrame: 544 },
      beforeSelections: production.selections, afterSelections: production.selections };
    const action = { worldId: world.meta.worldId, productionId: production.meta.id };
    const { document } = parseHTML(renderToString(<ProductionTimelineCard preview={preview} action={action} />));
    assert.deepEqual([...document.querySelectorAll('[aria-label="Text"] li')].map(item => item.textContent), LINES);
    // The Studio's canvas shows one timeline as it stands, not a change: handed the same before and
    // after that state four names above, it states none of them.
    const current = parseHTML(renderToString(<ProductionTimelineCard preview={preview} action={action} comparison={false} />));
    assert.equal(current.document.querySelector('[aria-label="Text"]'), null);
    assert.ok(current.document.querySelector('[aria-label="Timeline change preview"]'), "the card itself is drawn");
  });

  it("two identical text lines render without a key collision", async () => {
    // Two names alike, given one look: two lines that read the same.
    const twins = applyTimelineCommands(seeded, [{ kind: "add-track", trackId: "tr_names", trackKind: "picture", name: "Names" },
      ...(["cl_a", "cl_b"] as const).map((id, index) => ({ kind: "place" as const, trackId: "tr_names" as const, clip: { id, startFrame: index * 200, durationFrames: 112, sourceInFrames: 0,
        source: { kind: "text" as const, label: "Kemi", text: "Kemi", look: PROMO } } }))]);
    const dom = parseHTML("<!doctype html><html><body><div id=\"root\"></div></body></html>");
    const globals = { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true };
    const saved = Object.fromEntries(Object.keys(globals).map(key => [key, Reflect.get(globalThis, key)]));
    Object.assign(globalThis, globals);
    const errors: unknown[][] = [], error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const root = createRoot(dom.document.getElementById("root")!);
      await act(async () => root.render(<EditorRequestCards requests={[pending([{ kind: "text-set", clipIds: ["cl_a", "cl_b"], look: { size: 0.09 } }], twins)]} base={twins}
        timelineState={{ status: "ready", timeline: twins }} currentFingerprint={fingerprint} frameRate={twins.frameRate} ghostId={null} onGhost={() => {}} onDecide={() => {}} disabled={false} />));
      const items = [...dom.document.querySelectorAll(".fy-reqcard__lines li")].map(item => item.textContent).filter(line => line?.startsWith("Changes text"));
      assert.deepEqual(items, ["Changes text “Kemi” · Size 7.1% → 9%", "Changes text “Kemi” · Size 7.1% → 9%"]);
      await act(async () => root.unmount());
    } finally {
      console.error = error;
      Object.assign(globalThis, saved);
    }
    assert.deepEqual(errors.map(args => String(args[0])).filter(message => /same key/.test(message)), [], "no duplicate key");
  });
});
