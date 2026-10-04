import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { seedStoryPictureTimeline, applyTimelineCommands, type ConversationActionCard } from "@arke-studio/contracts";
import { ProductionCardBody } from "../src/components/production-card-body.js";
import { ProductionExportReceipt } from "../src/components/production-export-card.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const world = FIXTURE_STATE.world!, production = world.productions[0]!;
const action = { worldId: world.meta.worldId, productionId: production.meta.id, authority: { kind: "export", id: "ex_review" } } as ConversationActionCard;
const preview = { kind: "export" as const, preset: "review-cut", durationSec: 60, subtitles: "Burn-in · English", dimensions: "1280 × 720", frameRate: 24, scope: "Complete production" };
afterEach(() => __setStateForTest(FIXTURE_STATE));

it("uses native picture and audio tracks for frozen before and after with removed ghosts and range", () => {
  __setStateForTest(FIXTURE_STATE);
  const before = applyTimelineCommands(seedStoryPictureTimeline(production), [{ kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" },
    { kind: "place", trackId: "tr_music", clip: { id: "cl_music", source: { kind: "take", takeId: production.takes[0]!.id, label: "Score" }, startFrame: 0, sourceInFrames: 0, durationFrames: 24 } }]);
  const after = applyTimelineCommands(before, [{ kind: "delete", clipId: "cl_music" }]);
  const { document } = parseHTML(renderToString(<ProductionCardBody action={action} preview={{ kind: "timeline", before, after, beforeSelections: production.selections, afterSelections: production.selections, range: { startFrame: 0, endFrame: 24 } }} />));
  assert.equal(document.querySelectorAll('[data-track="picture"]').length, 2);
  assert.equal(document.querySelectorAll('[data-track="music"]').length, 2);
  assert.equal(document.querySelector('[data-version="before"] [data-review-change="removed"]')?.textContent?.includes("Score"), true);
  assert.equal(document.querySelector('[data-version="after"] [data-review-change="removed"]'), null);
  assert.equal(document.querySelectorAll('[aria-label="Affected playhead range"]').length, 2);
});
it("shows export settings and progress only from the matching world and export", () => {
  __setStateForTest(FIXTURE_STATE, { exportsState: { ex_review: { worldId: world.meta.worldId, productionId: production.meta.id, status: "running", percent: 68, output: null, error: null } } });
  const { document } = parseHTML(renderToString(<ProductionCardBody action={action} preview={preview} />));
  assert.match(document.toString(), /Burn-in · English/); assert.match(document.toString(), /1280 × 720/);
  assert.equal(document.querySelector("progress")?.getAttribute("value"), "68");
  __setStateForTest(FIXTURE_STATE, { exportsState: { ex_review: { worldId: "other", productionId: production.meta.id, status: "running", percent: 99, output: null, error: null } } });
  assert.equal(parseHTML(renderToString(<ProductionCardBody action={action} preview={preview} />)).document.querySelector("progress"), null);
});
it("plays retained completed exports outside review details and refuses host or mismatched output", () => {
  __setStateForTest(FIXTURE_STATE);
  const completed = { ...action, exportState: { status: "done" as const, percent: 100, output: "exports/review.mp4" } };
  const { document } = parseHTML(renderToString(<ProductionExportReceipt action={completed} />));
  assert.equal(document.querySelector("video")?.hasAttribute("controls"), true);
  assert.match(document.querySelector("video")?.getAttribute("src") ?? "", /exports.*review.mp4/);
  for (const output of ["C:/secret.mp4", "exports/../secret.mp4", "artifacts/video.mp4"]) {
    assert.equal(renderToString(<ProductionExportReceipt action={{ ...completed, exportState: { ...completed.exportState, output } }} />), "");
  }
  assert.equal(renderToString(<ProductionExportReceipt action={{ ...completed, worldId: "other" }} />), "");
});
