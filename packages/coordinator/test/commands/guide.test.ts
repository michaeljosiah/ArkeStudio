import assert from "node:assert/strict";
import { it } from "node:test";
import { ulid, type DomainEvent } from "@arke-studio/contracts";
import { GuideDraftRuns, guideCommands } from "../../src/commands/guide.js";
import type { CommandContext } from "../../src/commands/context.js";
import { setGuideEntry } from "../../src/productions/world-guide.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-11-09T12:00:00.000Z";

/** The Guide's module alone over a real world, with a writer the test holds (SPEC-059 R-40). */
async function harness(answer: ((brief: string) => Promise<string | null>) | null) {
  const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
  const events: DomainEvent[] = [], logged: unknown[] = [], runs = new GuideDraftRuns();
  const ctx: CommandContext = { stopping: () => false, openStore: () => store, emit: event => { events.push(event); }, nowIso: CLOCK,
    refreshWorldSnapshot: async () => {}, fail: () => { throw new Error("not routed here"); } };
  const commands = guideCommands(ctx, { runs, ask: () => answer, logDrafted: entry => { logged.push(entry); } });
  const draft = (requestId = ulid()) => commands["draft-guide-description"].handle({ kind: "draft-guide-description", worldId: store.worldId, requestId }, store);
  const drafting = () => events.filter((event): event is Extract<DomainEvent, { type: "guide.drafting" }> => event.type === "guide.drafting");
  return { store, events, logged, runs, commands, draft, drafting };
}

it("ends a Draft at once, saying why, while the writing harness is not running", async () => {
  const h = await harness(null);
  try {
    await h.draft();
    assert.deepEqual(h.drafting().map(({ of, finished, reason }) => ({ of, finished, reason })), [{ of: 0, finished: true, reason: "The writing harness is not running" }]);
    assert.equal(h.runs.stops.size, 0);
  } finally {
    await h.store.close();
  }
});

it("drafts each entry in turn, tells a joining window where the run is, and Stop ends it", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const briefs: string[] = [];
  const h = await harness(async brief => { briefs.push(brief); await held; return "Tide-caller on the night crew."; });
  try {
    for (const id of ["maren-kest", "bray-half-hitch"]) await setGuideEntry(h.store, { entryKind: "characters", id, entry: { public: true } }, "editor");
    const requestId = ulid();
    const run = h.draft(requestId);
    while (briefs.length === 0) await new Promise(resolve => setImmediate(resolve));
    // A second press while one goes is not a second run.
    await h.draft();
    assert.equal(h.runs.stops.size, 1);
    const [joined] = h.runs.replay("2026-11-09T12:00:05.000Z");
    assert.equal(joined?.requestId, requestId);
    assert.equal(joined?.finished, false);
    assert.equal(joined?.at, "2026-11-09T12:00:05.000Z");
    h.commands["stop-guide-drafting"].handle({ kind: "stop-guide-drafting", worldId: h.store.worldId });
    release();
    await run;
    const last = h.drafting().at(-1)!;
    assert.deepEqual({ requestId: last.requestId, of: last.of, done: last.done, finished: last.finished, reason: last.reason }, { requestId, of: 2, done: 0, finished: true, reason: "Stopped" });
    assert.equal(briefs.length, 1, "the second entry is never asked for");
    assert.deepEqual(h.runs.replay(CLOCK()), [], "a finished run is not told to a joining window");
    assert.equal(h.runs.stops.size, 0);
    assert.deepEqual(h.logged, [{ worldId: h.store.worldId, done: 0, failed: 0, reason: "Stopped" }]);
  } finally {
    release();
    await h.store.close();
  }
});
