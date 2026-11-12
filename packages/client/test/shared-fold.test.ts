import assert from "node:assert/strict";
import { it } from "node:test";
import { DomainEventSchema, type DomainEvent } from "@arke-studio/contracts";
import { ReadModel } from "../../coordinator/src/read-model.js";
import { __applyForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The coordinator's read model and the client's store fold the same events into `ClientState`
 * (issue 2799). They kept two copies, arm for arm, until the copies drifted; this replays one
 * stream through both and holds them to one answer.
 */
const AT = "2026-11-09T05:00:00Z";
const OTHER_WORLD = "01J8F3K2QW9VZX4N7M0RTYB6ZZ";

it("the read model and the store fold one event stream to the same state (issue 2799)", () => {
  const model = new ReadModel("test");
  model.setWorld(structuredClone(FIXTURE_STATE.world));
  model.seedJobs(structuredClone(FIXTURE_STATE.app.jobs));
  let store = structuredClone(model.getState());
  const world = FIXTURE_STATE.world!, job = FIXTURE_STATE.app.jobs[0]!, production = world.productions.find((p) => p.takes.length > 0)!;
  const events: DomainEvent[] = [
    { at: AT, type: "health.changed", component: "voice", status: "starting" },
    { at: AT, type: "job.updated", job: { ...job, id: "jb_01J8F3K2QW9VZX4N7M0RTYB6NW", status: "running" } },
    { at: AT, type: "job.updated", job: { ...job, status: "failed" } },
    { at: AT, type: "job.deleted", jobId: "jb_01J8F3K2QW9VZX4N7M0RTYB6NW" },
    { at: AT, type: "ledger.appended", entry: FIXTURE_STATE.app.ledger[0]! },
    { at: AT, type: "queue.status", queue: { provider: "fal", paused: true, held: 2 } },
    { at: AT, type: "take.recorded", worldId: world.meta.worldId, productionId: production.meta.id, take: { ...production.takes[0]!, id: "tk_01J8F3K2QW9VZX4N7M0RTYB6NW" } },
    { at: AT, type: "take.recorded", worldId: OTHER_WORLD, productionId: production.meta.id, take: { ...production.takes[0]!, id: "tk_01J8F3K2QW9VZX4N7M0RTYB6NX" } },
  ].map((event) => DomainEventSchema.parse(event));
  for (const event of events) {
    model.apply(event);
    store = __applyForTest(store, event);
  }
  assert.deepEqual(store, model.getState());
  assert.equal(store.app.jobs.find((row) => row.id === job.id)?.status, "failed", "the stream was applied, not ignored");
  assert.equal(store.world!.productions.find((p) => p.meta.id === production.meta.id)!.takes.length, production.takes.length + 1, "another world's take is not this world's");
});

it("a frame run in a world that is not open is left for the snapshot, on both sides (issue 2799)", () => {
  const model = new ReadModel("test");
  model.setWorld(structuredClone(FIXTURE_STATE.world));
  const before = structuredClone(model.getState());
  // The client's copy used to apply this whatever the world; the coordinator's never did.
  const elsewhere = { at: AT, type: "production.frame-run", worldId: OTHER_WORLD, runId: "fr_elsewhere", state: { run: { id: "fr_elsewhere" } } } as unknown as DomainEvent;
  model.apply(elsewhere);
  assert.deepEqual(model.getState().frameRuns, before.frameRuns);
  assert.deepEqual(__applyForTest(before, elsewhere).frameRuns, before.frameRuns);
});
