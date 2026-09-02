import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import {
  applyTimelineCommands,
  orderedTrackClips,
  seedStoryPictureTimeline,
  storyTimelineFingerprint,
  undoTimelineHistory,
  type EditorRequest,
} from "@arke-studio/contracts";
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
  });

  it("keeps an accepted request's status and reports its revision undone (R-36)", () => {
    const accepted = applyTimelineCommands(seeded, [{ kind: "move-adjacent", clipId: clips[1]!.id, direction: "earlier" }], { requestId: REQUEST });
    const record = request({ status: "accepted", baseRevision: null, resultRevision: 1, decidedAt: "2026-09-02T10:01:00Z" });
    const landed = render([record], { status: "ready", timeline: accepted }, accepted);
    assert.match(landed, /data-status="accepted"/);
    assert.match(landed, /r1/);
    assert.doesNotMatch(landed, /undone/);
    assert.doesNotMatch(landed, />Accept</);
    const undone = render([record], { status: "ready", timeline: undoTimelineHistory(accepted) }, undoTimelineHistory(accepted));
    assert.match(undone, /accepted · r1 · undone/);
  });
});
