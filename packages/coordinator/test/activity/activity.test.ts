import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canDeleteJob,
  computeNeedsYou,
  computeRunning,
  jobActions,
  jobOrigin,
  REFERENCE_FINALIZATION_TARGETS,
  spendSummary,
  type ClientState,
  type Job,
  type LedgerEntry,
} from "@arke-studio/contracts";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";

const WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC";

function job(overrides: Partial<Job>): Job {
  return {
    id: "jb_01J8E0000000000000000000J1",
    idempotencyKey: "01J8E1000000000000000000K1",
    worldId: WORLD,
    target: { kind: "shot", id: "sh_12" },
    capability: "video",
    provider: "fal",
    model: "seedance-2.0",
    params: {},
    estimatedMicroUsd: 130000,
    status: "queued",
    providerJobId: null,
    attempt: 0,
    error: null,
    createdAt: "2026-08-01T10:00:00Z",
    updatedAt: "2026-08-01T10:00:00Z",
    ...overrides,
  };
}

function baseState(overrides: Partial<ClientState["app"]> = {}, world: ClientState["world"] = null): ClientState {
  return {
    app: {
      version: "t",
      health: {
        coordinator: { status: "healthy" },
        harness: { status: "unavailable", reason: "x" },
        voice: { status: "unavailable", reason: "x" },
      },
      jobs: [],
      ledger: [],
      providers: [],
      providerTools: [],
      manifest: null,
      routing: { defaults: {}, faults: [] },
      models: { disabled: [] },
        recipes: [],
      spend: null,
      backgroundNotifications: "issues-only",
      appearance: { theme: "system" },
      runtime: null,
      voiceRuntime: null,
      drift: [],
      agents: [],
      harnessModels: [],
      harnessInfo: null,
      queues: [],
      setup: null,
      update: { status: "idle", targetVersion: null, progressPercent: null, flow: null, detail: null },
      env: null,
      sampleWorld: { available: false, installing: false, note: null },
      ...overrides,
    },
    worlds: [],
    world,
    worldChat: null,
    bench: null,
  };
}

describe("needs-you is derived, never appended to (R-3, D1, §3.2)", () => {
  it("surfaces failed reference finalization as a no-charge repair", () => {
    const failed = job({
      status: "succeeded",
      target: { kind: "character-sheet", id: "maren-kest/g1" },
      landedFiles: ["references/maren-kest/incoming/sheet.png"],
      finalization: {
        status: "failed",
        error: "Generation completed, but the review take could not be recorded.",
        updatedAt: "2026-08-01T10:01:00Z",
      },
    });
    const [entry] = computeNeedsYou(baseState({ jobs: [failed] }));
    assert.equal(entry?.kind, "job-finalization-failed");
    assert.deepEqual(entry?.actions, ["retry-finalization"]);
  });

  it("includes unreviewed character reference takes and removes them by decision", () => {
    const take = {
      id: "tk_01J8A0000000000000000000R1",
      coversShots: [],
      kind: "main-photo" as const,
      reference: { sheetId: "maren-kest" },
      provider: "fal",
      model: "flux",
      provenance: { canonRevision: 1, sheets: { "maren-kest": 1 } },
      references: [],
      params: {},
      cost: { estimatedMicroUsd: 40000, actualMicroUsd: null },
      dispatchedAt: "2026-08-03T10:00:00Z",
    };
    const state = baseState(
      {},
      {
        meta: { worldId: WORLD, name: "The Undersong", updated: "2026-08-03T10:00:00Z" },
        externalEdits: [],
        proposals: [],
        productions: [],
        referenceTakes: [take],
        referenceReviews: [],
      } as never,
    );
    const item = computeNeedsYou(state).find((entry) => entry.ref === take.id);
    assert.ok(item);
    assert.equal(item.reviewPath, `/w/${WORLD}/cast/maren-kest/main-photo`);
    state.world!.referenceReviews = [
      { ts: "2026-08-03T10:01:00Z", takeId: take.id, decision: "accept", by: "user" },
    ];
    assert.ok(!computeNeedsYou(state).some((entry) => entry.ref === take.id));
  });

  it("sends a waiting location view to the location, not into the character flow (#243)", () => {
    // Every kind but look and main-photo used to fall through to the character kit, so Review on
    // a location view opened another entity's reference set — a screen with no way to accept the
    // thing that sent you there.
    const take = {
      id: "tk_01J8A0000000000000000000R2",
      coversShots: [],
      kind: "location-view" as const,
      reference: { sheetId: "the-vigil" },
      provider: "openai",
      model: "gpt-image-2",
      provenance: { canonRevision: 1, sheets: { "the-vigil": 1 } },
      references: [],
      params: {},
      cost: { estimatedMicroUsd: 150000, actualMicroUsd: null },
      dispatchedAt: "2026-08-03T10:00:00Z",
    };
    const state = baseState(
      {},
      {
        meta: { worldId: WORLD, name: "The Undersong", updated: "2026-08-03T10:00:00Z" },
        externalEdits: [],
        proposals: [],
        productions: [],
        referenceTakes: [take],
        referenceReviews: [],
      } as never,
    );
    const item = computeNeedsYou(state).find((entry) => entry.ref === take.id);
    assert.ok(item);
    assert.equal(item.reviewPath, `/w/${WORLD}/locations/the-vigil/reference`);
  });

  const worldWithTake = (reviewed: boolean): ClientState["world"] =>
    ({
      meta: { worldId: WORLD, name: "The Undersong", updated: "2026-08-01T09:00:00Z" },
      externalEdits: [],
      proposals: [],
      productions: [
        {
          meta: { id: "saltlight", title: "Saltlight" },
          takes: [
            {
              id: "tk_01J8A0000000000000000000A1",
              kind: "frame",
              coversShots: ["sh_12"],
              dispatchedAt: "2026-08-01T08:00:00Z",
              completedAt: "2026-08-01T08:01:00Z",
            },
          ],
          reviews: reviewed
            ? [{ ts: "2026-08-01T08:30:00Z", takeId: "tk_01J8A0000000000000000000A1", decision: "accept", by: "user" }]
            : [],
        },
      ],
    }) as never;

  it("a take leaves the queue because a decision now exists — no removal call", () => {
    const before = computeNeedsYou(baseState({}, worldWithTake(false)));
    assert.ok(before.some((e) => e.kind === "unreviewed-take"));
    const after = computeNeedsYou(baseState({}, worldWithTake(true)));
    assert.ok(!after.some((e) => e.kind === "unreviewed-take"), "reviewed elsewhere → gone, by derivation");
  });

  it("a resolved reconciliation and an accepted proposal leave the same way", () => {
    const held = computeNeedsYou(baseState({ jobs: [job({ status: "needs-reconciliation", error: "unwitnessed" })] }));
    assert.ok(held.some((e) => e.kind === "job-needs-reconciliation"));
    const resolved = computeNeedsYou(baseState({ jobs: [job({ status: "succeeded" })] }));
    assert.ok(!resolved.some((e) => e.kind === "job-needs-reconciliation"));

    const withProposal = {
      ...worldWithTake(true)!,
      proposals: [{ proposal: { id: "pr_1", kind: "sheet-edit", summary: "S", created: "2026-08-01T07:00:00Z" }, ripple: null }],
    } as never;
    const open = computeNeedsYou(baseState({}, withProposal));
    assert.ok(open.some((e) => e.kind === "open-proposal"));
    const closed = computeNeedsYou(baseState({}, worldWithTake(true)));
    assert.ok(!closed.some((e) => e.kind === "open-proposal"));
  });

  it("ordering: a reconciliation outranks forty unreviewed takes; recency within class (R-5, D2, D3)", () => {
    const world = worldWithTake(false)!;
    const forty = {
      ...world,
      productions: [
        {
          ...(world.productions[0] as object),
          takes: Array.from({ length: 40 }, (_, i) => ({
            id: `tk_01J8A00000000000000000${String(i).padStart(4, "0")}`.slice(0, 29),
            kind: "frame",
            coversShots: ["sh_12"],
            dispatchedAt: `2026-08-01T0${i % 8}:00:00Z`,
          })),
          reviews: [],
        },
      ],
    } as never;
    const queue = computeNeedsYou(
      baseState(
        {
          jobs: [job({ status: "needs-reconciliation", error: "unwitnessed", updatedAt: "2026-07-01T00:00:00Z" })],
          queues: [{ provider: "fal", paused: true, reason: "HTTP 401", held: 40 }],
        },
        forty,
      ),
    );
    assert.equal(queue[0]!.kind, "job-needs-reconciliation", "unresolved money first, even when older");
    assert.equal(queue[1]!.kind, "provider-paused", "blocked work second");
    const takes = queue.filter((e) => e.kind === "unreviewed-take");
    assert.equal(takes.length, 40);
    for (let i = 1; i < takes.length; i++) {
      assert.ok(takes[i - 1]!.at >= takes[i]!.at, "recency within class");
    }
    const again = computeNeedsYou(
      baseState(
        {
          jobs: [job({ status: "needs-reconciliation", error: "unwitnessed", updatedAt: "2026-07-01T00:00:00Z" })],
          queues: [{ provider: "fal", paused: true, reason: "HTTP 401", held: 40 }],
        },
        forty,
      ),
    );
    assert.deepEqual(queue.map((e) => e.ref ?? e.title), again.map((e) => e.ref ?? e.title), "stable across reloads");
  });

  it("closed-world counts are as-of labelled, never presented as current (R-7, D4)", () => {
    const state = baseState({}, null);
    state.worlds = [
      {
        worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD",
        slug: "other",
        name: "Otherworld",
        counts: { characters: 1, locations: 0, factions: 0, canonEntries: 0, productions: 1 },
        attention: { unreviewedTakes: 3, openProposals: 1, asOf: "2026-07-30T10:00:00Z" },
        keyArt: null,
        updated: "2026-07-30T10:00:00Z",
      },
    ];
    const queue = computeNeedsYou(state);
    const entry = queue.find((e) => e.kind === "closed-world-attention");
    assert.ok(entry);
    assert.equal(entry.asOf, "2026-07-30T10:00:00Z", "carries the time it was computed");
    assert.match(entry.detail, /a count, not a list/);
    assert.deepEqual(entry.actions, ["open-world"], "selecting it opens the world; items become precise");
  });
});

describe("actions offered only where the state permits (R-13, D10, §3.2)", () => {
  it("covers every job state", () => {
    assert.deepEqual(jobActions(job({ status: "queued" })), ["cancel"]);
    assert.deepEqual(jobActions(job({ status: "submitting" })), ["cancel"]);
    assert.deepEqual(jobActions(job({ status: "running" })), ["watch", "cancel"]);
    assert.deepEqual(jobActions(job({ status: "failed" })), ["retry", "delete"]);
    assert.deepEqual(jobActions(job({ status: "needs-reconciliation" })), ["resolve"]);
    assert.deepEqual(jobActions(job({ status: "succeeded" })), ["delete"], "no cancel on a completed job");
    assert.deepEqual(jobActions(job({ status: "cancelled" })), ["delete"]);
  });

  it("sends a failed job back to the surface that dispatched it, not always a production (issue 226)", () => {
    // The hint under every failure named "its production's dispatch dialog". Reference work
    // belongs to no production and has no such dialog, so a failed look was a dead end: the
    // character's own page reads `0 productions`, and the row's only instruction pointed at a
    // screen that does not exist for that job.
    const cast = (kind: string, id: string) => jobOrigin(job({ status: "failed", target: { kind, id } }));
    assert.equal(cast("character-look", "timi-j/msm7pzlb/1")?.path, `/w/${WORLD}/cast/timi-j/looks`);
    assert.equal(cast("main-photo-candidate", "timi-j/msm7pzlb/2")?.path, `/w/${WORLD}/cast/timi-j/main-photo`);
    assert.equal(cast("character-sheet", "timi-j/msm67mgg")?.path, `/w/${WORLD}/cast/timi-j/model-sheet`);
    assert.equal(cast("reference-tile", "timi-j/head-front")?.path, `/w/${WORLD}/cast/timi-j/kit`);
    assert.equal(cast("establish-candidate", "timi-j/1")?.path, `/w/${WORLD}/cast/timi-j/kit`);
    assert.equal(cast("voice-preview", "timi-j/elevenlabs/rachel")?.path, `/w/${WORLD}/cast/timi-j/voice`);
    // A section read is queued as a voice preview but did not start in the picker, and cannot
    // be re-run there — that screen auditions and assigns voices, and has no way to ask for
    // this paragraph again.
    const sectionRead = jobOrigin(
      job({
        status: "failed",
        target: { kind: "voice-preview", id: "timi-j/elevenlabs/rachel" },
        params: { purpose: "sheet-section", sectionHeading: "Essence" },
      }),
    );
    assert.equal(sectionRead?.path, `/w/${WORLD}/cast/timi-j`);
    // Every reference kind the queue can finalize is one Activity can route home, or the row it
    // leaves behind is the dead end this issue was about.
    for (const kind of REFERENCE_FINALIZATION_TARGETS) {
      assert.ok(cast(kind, "timi-j/1"), `${kind} names somewhere to run it again`);
    }
    // And production work still points where it always did.
    const shot = jobOrigin(job({ status: "failed", productionId: "saltlight", target: { kind: "shot", id: "sh_12" } }));
    assert.equal(shot?.path, `/w/${WORLD}/p/saltlight/generate/dispatch`);
    assert.match(shot!.where, /production/);
    // Except a line, which has a dialog of its own. The shot dispatch dialog carries no
    // dialogue or delivery controls, so sending a failed line there is the same dead end.
    const line = jobOrigin(
      job({ status: "failed", productionId: "saltlight", target: { kind: "voice-line", id: "sh_12" } }),
    );
    assert.equal(line?.path, `/w/${WORLD}/p/saltlight/generate/voice-line`);
    // A world's key art is dispatched from the world screen, and nothing else claims it.
    assert.equal(jobOrigin(job({ target: { kind: "world-image", id: WORLD } }))?.path, `/w/${WORLD}`);
    // Nothing to name beats naming the wrong place: a production-less job of an unknown kind,
    // and a reference job whose target carries no sheet, both say so.
    assert.equal(jobOrigin(job({ target: { kind: "extraction", id: "af_1" } })), null);
    assert.equal(jobOrigin(job({ target: { kind: "character-look" } })), null);
  });

  it("names a destination a button can say and a sentence can hold", () => {
    // One string cannot do both: "Open its production's dispatch dialog" is not a button, and
    // "run it again from Looks" reads as a stray proper noun.
    for (const kind of ["character-look", "main-photo-candidate", "character-sheet", "voice-preview"]) {
      const origin = jobOrigin(job({ status: "failed", target: { kind, id: "timi-j/x/1" } }));
      assert.ok(origin, kind);
      assert.match(origin!.label, /^[A-Z]/, `${kind}: the button starts a label, not a sentence`);
      assert.match(origin!.where, /^(the|its) /, `${kind}: the sentence fragment reads as one`);
    }
  });

  it("offers delete only on finished work that owes the user nothing", () => {
    // In flight: the action for this state is cancel, and offering both would be the D10 lie.
    for (const status of ["queued", "submitting", "running", "needs-reconciliation"] as const) {
      assert.ok(!canDeleteJob(job({ status })), `${status} is not history yet`);
      assert.ok(!jobActions(job({ status })).includes("delete"));
    }
    // Finished, and its result already prepared — or never needing preparation.
    assert.ok(canDeleteJob(job({ status: "succeeded" })));
    assert.ok(
      canDeleteJob(
        job({
          status: "succeeded",
          finalization: { status: "complete", error: null, updatedAt: "2026-08-01T10:01:00Z" },
        }),
      ),
    );
    // Still preparing: it draws as running work, so a delete here would remove a live row.
    assert.ok(
      !canDeleteJob(
        job({
          status: "succeeded",
          finalization: { status: "pending", error: null, updatedAt: "2026-08-01T10:01:00Z" },
        }),
      ),
    );
    // Failed preparation: a class-1 needs-you entry carrying a retry the user has not answered.
    const unprepared = job({
      status: "succeeded",
      finalization: { status: "failed", error: "not ready", updatedAt: "2026-08-01T10:01:00Z" },
    });
    assert.ok(!canDeleteJob(unprepared));
    assert.equal(computeNeedsYou(baseState({ jobs: [unprepared] })).length, 1, "it is still on the queue");
  });
});

describe("running work (R-2, D6, D7)", () => {
  it("shows generated work while its result is being prepared", () => {
    const pending = job({
      status: "succeeded",
      target: { kind: "character-sheet", id: "maren-kest/g1" },
      landedFiles: ["references/maren-kest/incoming/sheet.png"],
      finalization: { status: "pending", error: null, updatedAt: "2026-08-01T10:01:00Z" },
    });
    const [entry] = computeRunning(baseState({ jobs: [pending] }));
    assert.match(entry?.detail ?? "", /generated · preparing result/);
    assert.equal(entry?.cancellable, false);
  });

  it("jobs, downloads and exports appear side by side; instant work does not", () => {
    const state = baseState({ jobs: [job({ status: "running" }), job({ id: "jb_01J8E0000000000000000000J2", status: "succeeded" })] });
    const running = computeRunning(state, {
      sidecar: { state: "downloading", detail: "downloading kokoro — 40 of 92 MB" },
      exports: { ex_1: { productionId: "saltlight", status: "running", percent: 40 } },
    });
    assert.deepEqual(running.map((r) => r.kind).sort(), ["export", "job", "model-download"]);
    assert.match(running.find((r) => r.kind === "model-download")!.detail, /40 of 92 MB/);
    assert.ok(!running.some((r) => r.ref === "jb_01J8E0000000000000000000J2"), "terminal work is not running");
  });
});

describe("spend honesty (R-8, R-10, R-12, D8, D9, §3.2)", () => {
  const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
    ts: "2026-08-01T10:00:00Z",
    worldId: WORLD,
    jobId: "jb_01J8E0000000000000000000J1",
    provider: "fal",
    model: "seedance-2.0",
    outcome: "succeeded",
    estimatedMicroUsd: 100000,
    actualMicroUsd: 100000,
    actualSource: "provider-reported",
    ...over,
  });

  it("a mixed total says so; a uniform one does not", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const mixed = spendSummary(
      [entry({}), entry({ jobId: "jb_01J8E0000000000000000000J2", actualSource: "manifest-derived" })],
      7,
      now,
    );
    assert.equal(mixed.mixed, true);
    assert.equal(mixed.totalMicroUsd, 200000);
    const uniform = spendSummary([entry({}), entry({ jobId: "jb_01J8E0000000000000000000J2" })], 7, now);
    assert.equal(uniform.mixed, false);
  });

  it("local runs are unmetered — counted, never zero-dollar line items", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const summary = spendSummary(
      [entry({}), entry({ jobId: "jb_01J8E0000000000000000000J3", provider: "ollama", model: "llama3.1-8b", actualMicroUsd: 0, actualSource: "local-zero" })],
      7,
      now,
    );
    assert.equal(summary.unmeteredRuns, 1);
    assert.equal(summary.totalMicroUsd, 100000, "unmetered work never joins the money total");
    const ollamaRow = summary.byProvider.find((p) => p.provider === "ollama");
    assert.equal(ollamaRow?.unmetered, true);
    assert.equal(ollamaRow?.microUsd, 0);
  });

  it("the rolling window drops old entries", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const summary = spendSummary([entry({ ts: "2026-06-01T10:00:00Z" })], 7, now);
    assert.equal(summary.totalMicroUsd, 0);
  });
});

describe("registry attention counts (R-7, T-5, T-6)", () => {
  it("a world passing through records its counts with an as-of stamp", async () => {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root, {});
    await provider.ensureAppRoot();
    const worlds = await provider.listWorlds();
    const target = worlds.find((w) => w.slug === "the-undersong");
    assert.ok(target);
    await provider.loadWorld(target.worldId);
    await provider.close();
    const after = await provider.listWorlds();
    const summary = after.find((w) => w.slug === "the-undersong")!;
    assert.ok(summary.attention, "attention recorded when the bundle passed through");
    assert.ok(summary.attention!.unreviewedTakes >= 1, "the fixture has takes without decisions");
    assert.ok(summary.attention!.asOf.length > 0, "always as-of labelled — honest even after a crash");
  });
});

describe("liveness (R-14, §3.2): the screen has no polling timer", () => {
  it("ActivityScreen contains no setInterval", () => {
    const source = readFileSync(
      resolve(join(import.meta.dirname, "../../../client/src/screens/shell.tsx")),
      "utf8",
    );
    const activity = source.slice(source.indexOf("export function ActivityScreen"));
    const body = activity.slice(0, activity.indexOf("\nexport function", 10));
    assert.ok(!body.includes("setInterval"), "pushed events, never polling");
    assert.ok(!body.includes("setTimeout"), "no disguised polling either");
  });
});
