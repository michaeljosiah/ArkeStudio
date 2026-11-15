import { strict as assert } from "node:assert";
import { it } from "node:test";
import { computeNeedsYou, groupTakesToReview, type NeedsYouEntry } from "../src/activity.js";
import type { ClientState } from "../src/client-state.js";

const take = (ref: string, reviewPath: string, productionTitle: string): NeedsYouEntry => ({
  urgency: 4, kind: "unreviewed-take", title: `Take to review · ${productionTitle}`, productionTitle, detail: `clip ${ref}`,
  at: "2026-11-04T00:00:00.000Z", worldId: "w", actions: ["review"], ref, reviewPath,
});

it("gives each place to review one row with a count, in the order they came (issue 2496)", () => {
  const paused: NeedsYouEntry = { urgency: 2, kind: "provider-paused", title: "Fish Audio paused", detail: "1 job held", at: "2026-11-04T00:00:00.000Z", actions: ["settings"] };
  const rows = groupTakesToReview([
    paused,
    take("a", "/w/w/p/one/generate", "One"),
    take("b", "/w/w/p/two/generate", "Two"),
    take("c", "/w/w/p/one/generate", "One"),
    take("d", "/w/w/p/one/generate?view=stills", "One"),
    take("e", "/w/w/p/one/generate?view=stills", "One"),
  ]);
  assert.deepEqual(rows.map(row => row.title), ["Fish Audio paused", "2 takes to review · One", "Take to review · Two", "2 pictures to review · One"]);
  assert.equal(rows[1]!.detail, "", "a count has no one take's detail");
  assert.equal(rows[2]!.detail, "clip b", "a single take keeps its detail");
});

it("names a group of reference takes after its sheet, not an absent production (issue 3090)", () => {
  const referenceTake = (id: string, sheetId: string) => ({ id, kind: "reference-tile", reference: { sheetId }, completedAt: `2026-11-14T00:00:0${id.length}.000Z`, dispatchedAt: "2026-11-14T00:00:00.000Z" });
  const state = {
    app: { jobs: [], queues: [] },
    worlds: [],
    world: {
      meta: { worldId: "w", name: "Juju", updated: "2026-11-14T00:00:00.000Z" },
      externalEdits: [], productions: [], artifacts: [], proposals: [], conversations: [], referenceReviews: [],
      sheets: [{ id: "ife", name: "Ife" }],
      referenceTakes: [referenceTake("a", "ife"), referenceTake("bb", "ife"), referenceTake("ccc", "ife"), referenceTake("dddd", "gone"), referenceTake("eeeee", "gone")],
    },
  } as unknown as ClientState;
  const rows = groupTakesToReview(computeNeedsYou(state));
  // Newest first: the two takes of a sheet that is gone are the newer ones.
  assert.deepEqual(rows.map(row => row.title), ["2 reference takes to review", "3 reference takes to review · Ife"]);
  assert.ok(rows.every(row => !row.title.includes("undefined")));
});
