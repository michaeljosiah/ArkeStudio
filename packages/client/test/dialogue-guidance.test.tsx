import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToString } from "react-dom/server";
import { DialogueGuidance } from "../src/components/dialogue-guidance.js";
import { TakeDialogueFeedbackPanel } from "../src/components/take-dialogue-feedback.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("requires explicit authored facts and shows unavailable historical diagnostics without inventing evidence", () => {
  const world = FIXTURE_STATE.world!, production = world.productions[0]!, scene = production.scenes[0]!;
  const html = renderToString(<DialogueGuidance world={world} production={production} scene={scene} plan={null} model={null} manifest={null} acknowledged={[]} onAcknowledge={() => {}} />);
  assert.match(html, /No authored visual facts/);
  assert.match(html, /Review visual facts proposal/);
  assert.match(html, /Draft isolated speaker/);
  assert.doesNotMatch(html, /detected faces|safe shot|start required/i);
  const take = production.takes[0]!;
  const review = renderToString(<TakeDialogueFeedbackPanel worldId={world.meta.worldId} production={production} take={take} shotId={take.coversShots[0]!} />);
  assert.match(review, /no frozen dialogue assessment/);
  assert.doesNotMatch(review, /audio ignored|start frame not respected/);
  assert.match(review, /shipped guidance unchanged/);
});
