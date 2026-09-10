import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToString } from "react-dom/server";
import { TakeDialogueFeedbackPanel } from "../src/components/take-dialogue-feedback.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("shows unavailable historical diagnostics without inventing evidence", () => {
  const world = FIXTURE_STATE.world!, production = world.productions[0]!, take = production.takes[0]!;
  const review = renderToString(<TakeDialogueFeedbackPanel worldId={world.meta.worldId} production={production} take={take} shotId={take.coversShots[0]!} />);
  assert.match(review, /no frozen dialogue assessment/);
  assert.doesNotMatch(review, /audio ignored|start frame not respected/);
  assert.match(review, /shipped guidance unchanged/);
});
