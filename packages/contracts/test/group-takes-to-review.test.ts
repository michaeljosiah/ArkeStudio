import { strict as assert } from "node:assert";
import { it } from "node:test";
import { groupTakesToReview, type NeedsYouEntry } from "../src/activity.js";

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
