import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONTROL_REGISTRY,
  FINDING_KINDS,
  FindingSchema,
  comfyUiWeightsComponentId,
  consequencesOf,
  deriveDiagnostics,
  deriveWithRules,
  diagnosticsSources,
  findingRef,
  primaryFindings,
  suppressedRefs,
  type ComfyUiStatus,
  type DiagnosticsSources,
  type Job,
  type SetupComponent,
  ulid,
} from "../src/index.js";
import { IDLE_UPDATE_STATE } from "../src/update.js";

/**
 * SPEC-032 §1.3–§1.9: the finding contract and the eight joins over published state (#554).
 * Test names cite the adversarial matrix rows they cover.
 */

const NOW = "2026-08-28T12:00:00.000Z";
const RECENT = "2026-08-28T11:55:00.000Z";
/** Older than the fifteen-minute staleness bound R-16 states. */
const STALE = "2026-08-28T09:00:00.000Z";

function sources(over: Partial<DiagnosticsSources> = {}): DiagnosticsSources {
  return {
    version: "0.1.0",
    health: {
      coordinator: { status: "healthy" },
      harness: { status: "healthy" },
      voice: { status: "healthy" },
    },
    env: null,
    runtime: {
      probes: { vramMb: 12288, memMb: 32768, diskFreeMb: 100_000 },
      detectedAt: RECENT,
      models: [],
      recommended: {},
    },
    harness: null,
    harnessInfo: null,
    setup: null,
    comfyui: null,
    voiceRuntime: null,
    queues: [],
    jobs: [],
    providers: [],
    providerTools: [],
    manifest: null,
    routing: { defaults: {}, faults: [] },
    models: { disabled: [] },
    spend: null,
    ledger: [],
    drift: [],
    builds: [],
    update: IDLE_UPDATE_STATE,
    ...over,
  };
}

function derive(over: Partial<DiagnosticsSources> = {}, previous = null as Parameters<typeof deriveDiagnostics>[0]["previous"]) {
  return deriveDiagnostics({ sources: sources(over), tails: { appLog: [] }, previous, now: NOW });
}

const ENGINE_INSTANCE = "abc123def4567890";

function comfyui(over: {
  state?: ComfyUiStatus["engine"]["state"];
  source?: ComfyUiStatus["engine"]["source"];
  detail?: string | null;
  instanceId?: string | null;
  recipes?: ComfyUiStatus["recipes"];
  checkedAt?: string;
}): ComfyUiStatus {
  const state = over.state ?? "ready";
  return {
    engine: {
      source: over.source ?? "managed",
      state,
      locality: "local",
      location: null,
      version: state === "ready" ? "0.3.48" : null,
      instanceId: over.instanceId === undefined ? ENGINE_INSTANCE : over.instanceId,
      detail: over.detail ?? null,
      detected: [],
    },
    recipes: over.recipes ?? [],
    checkedAt: over.checkedAt ?? RECENT,
  };
}

function recipe(
  id: string,
  state: "ready" | "disabled" | "unknown",
  reasonKind?: ComfyUiStatus["recipes"][number]["reasonKind"],
  reason?: string,
): ComfyUiStatus["recipes"][number] {
  return {
    recipeId: id,
    recipeVersion: 1,
    displayName: id,
    capability: "video",
    state,
    ...(reason !== undefined ? { reason } : {}),
    ...(reasonKind !== undefined ? { reasonKind } : {}),
  };
}

function component(id: string, over: Partial<SetupComponent> = {}): SetupComponent {
  return {
    id,
    displayName: id,
    purpose: "test component",
    sizeMb: 1000,
    state: "available",
    bytesDone: 0,
    bytesTotal: 0,
    bytesPerSecond: null,
    ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: `jb_${ulid()}`,
    idempotencyKey: ulid(),
    worldId: ulid(),
    target: { kind: "shot", id: "sh_01" },
    capability: "video",
    provider: "comfyui",
    model: "wan-video",
    params: {},
    estimatedMicroUsd: 0,
    status: "queued",
    providerJobId: null,
    attempt: 0,
    error: null,
    createdAt: RECENT,
    updatedAt: RECENT,
    ...over,
  };
}

describe("work against a dead engine (R-20.1)", () => {
  const deadEngineJobs = (count: number, engineState: "failed" | "unreachable") =>
    derive({
      comfyui: comfyui({ state: engineState, detail: "the child exited with code 1" }),
      jobs: Array.from({ length: count }, () =>
        job({ engine: { source: "managed", instanceId: ENGINE_INSTANCE, processEpoch: "ep1" } }),
      ),
    });

  it("row 1: six jobs against a failed engine are one blocking finding with a count", () => {
    const snapshot = deadEngineJobs(6, "failed");
    const held = snapshot.findings.filter((f) => f.kind === "work-held-by-engine");
    assert.equal(held.length, 1);
    assert.equal(held[0]!.severity, "blocking");
    assert.equal(held[0]!.facts.find((f) => f.name === "held-jobs")?.value, 6);
    assert.equal(held[0]!.cause.statement, "the child exited with code 1");
    assert.equal(held[0]!.remedy?.control, "comfyui-restart");
  });

  it("row 1: the held work is a count, never its subject (R-30)", () => {
    const snapshot = deadEngineJobs(2, "failed");
    const held = snapshot.findings.find((f) => f.kind === "work-held-by-engine")!;
    const serialised = JSON.stringify(held);
    assert.ok(!serialised.includes("sh_01"), "no job target id in the finding");
    assert.ok(!serialised.includes("jb_"), "no job id in the finding");
  });

  it("jobs against a different instance are not this engine's problem", () => {
    const snapshot = derive({
      comfyui: comfyui({ state: "failed" }),
      jobs: [job({ engine: { source: "managed", instanceId: "somewhere-else00" } })],
    });
    assert.equal(snapshot.findings.some((f) => f.kind === "work-held-by-engine"), false);
  });

  it("a ready engine holds nothing", () => {
    const snapshot = derive({
      comfyui: comfyui({ state: "ready" }),
      jobs: [job({ engine: { source: "managed", instanceId: ENGINE_INSTANCE } })],
    });
    assert.equal(snapshot.findings.some((f) => f.kind === "work-held-by-engine"), false);
  });
});

describe("a lane paused on a credential (R-20.2)", () => {
  it("row 2: cause is the credential, the held count is carried, remedy is the key", () => {
    const snapshot = derive({
      queues: [
        { provider: "fal", paused: true, pauseKind: "credential", reason: "no credential stored", held: 4 },
      ],
    });
    const finding = snapshot.findings.find((f) => f.kind === "queue-paused-credential");
    assert.ok(finding);
    assert.equal(finding.severity, "blocking");
    assert.equal(finding.occurrence, "fal");
    assert.equal(finding.cause.statement, "no credential stored");
    assert.equal(finding.facts.find((f) => f.name === "held-jobs")?.value, 4);
    assert.deepEqual(finding.remedy, { control: "provider-key", target: "fal" });
  });

  it("a fault-paused lane is not this rule's finding", () => {
    const snapshot = derive({
      queues: [{ provider: "fal", paused: true, pauseKind: "fault", reason: "HTTP 500", held: 2 }],
    });
    assert.equal(snapshot.findings.some((f) => f.kind === "queue-paused-credential"), false);
  });

  it("a credential pause holding nothing is not stated", () => {
    const snapshot = derive({
      queues: [{ provider: "fal", paused: true, pauseKind: "credential", reason: "no credential", held: 0 }],
    });
    assert.equal(snapshot.findings.some((f) => f.kind === "queue-paused-credential"), false);
  });
});

describe("short of disk (R-20.3, R-20.4)", () => {
  const weightsId = comfyUiWeightsComponentId("wan-video");
  const blockedWeights = component(weightsId, {
    state: "blocked",
    detail: "needs 17 GB plus room to work; D: has 4 GB free",
    blockedBy: "disk",
    blockedVolumeRoot: "D:\\",
    sizeMb: 17408,
  });

  it("row 3: the cause names the volume with both figures; the recipe is a suppressed consequence", () => {
    const snapshot = derive({
      setup: { components: [blockedWeights], running: false, diskFreeMb: 4096, diskCheckedAt: RECENT },
      comfyui: comfyui({
        recipes: [recipe("wan-video", "disabled", "files", "1 of 1 model files missing from the models folder")],
      }),
    });
    const cause = snapshot.findings.find((f) => f.kind === "component-disk-short");
    assert.ok(cause);
    assert.equal(cause.severity, "blocking");
    assert.equal(cause.cause.statement, "needs 17 GB plus room to work; D: has 4 GB free");
    assert.equal(cause.facts.find((f) => f.name === "volume")?.value, "D:\\");
    // R-7: the figure travels as the measured number; "4 GB" is the surface's business.
    assert.equal(cause.facts.find((f) => f.name === "disk-free-mb")?.value, 4096);
    assert.deepEqual(cause.consequences, [`comfyui-recipe-disabled:wan-video`]);
    const suppressed = suppressedRefs(snapshot);
    assert.ok(suppressed.has("comfyui-recipe-disabled:wan-video"));
    assert.ok(primaryFindings(snapshot).every((f) => f.kind !== "comfyui-recipe-disabled"));
    assert.equal(consequencesOf(snapshot, cause).length, 1);
  });

  it("row 4: a voice model blocked for space is a finding in the same vocabulary", () => {
    const snapshot = derive({
      setup: {
        components: [
          component("voxa-kokoro", {
            state: "blocked",
            detail: "needs 400 MB plus room to work; this disk has 120 MB free",
            blockedBy: "disk",
            blockedVolumeRoot: "C:\\",
          }),
        ],
        running: false,
        diskFreeMb: 120,
        diskCheckedAt: RECENT,
      },
    });
    const finding = snapshot.findings.find((f) => f.kind === "component-disk-short");
    assert.ok(finding);
    assert.equal(finding.occurrence, "voxa-kokoro");
    assert.equal(finding.consequences.length, 0);
  });

  it("a component blocked on a dependency is not a disk finding", () => {
    const snapshot = derive({
      setup: {
        components: [component("ollama-model", { state: "blocked", detail: "waiting on Ollama", blockedBy: "dependency" })],
        running: false,
        diskFreeMb: 90_000,
        diskCheckedAt: RECENT,
      },
    });
    assert.equal(snapshot.findings.some((f) => f.kind === "component-disk-short"), false);
  });

  it("row 18: a stale free-disk figure is named stale with the re-measure control (R-16)", () => {
    const snapshot = derive({
      setup: { components: [blockedWeights], running: false, diskFreeMb: 4096, diskCheckedAt: STALE },
      comfyui: comfyui({ recipes: [] }),
    });
    const finding = snapshot.findings.find((f) => f.kind === "component-disk-short");
    assert.ok(finding?.stale);
    assert.deepEqual(finding.stale.facts, ["disk-free-mb"]);
    assert.equal(finding.stale.remeasure?.control, "component-retry");
    // The age is computable at the surface from the fact's own instant.
    assert.equal(finding.facts.find((f) => f.name === "disk-free-mb")?.measuredAt, STALE);
  });
});

describe("a recipe short of files (R-20.5)", () => {
  it("row 5: weights offered, disk fine — the remedy is that component's download", () => {
    const weightsId = comfyUiWeightsComponentId("wan-video");
    const snapshot = derive({
      setup: {
        components: [component(weightsId, { state: "available", sizeMb: 17408 })],
        running: false,
        diskFreeMb: 500_000,
        diskCheckedAt: RECENT,
      },
      comfyui: comfyui({
        recipes: [recipe("wan-video", "disabled", "files", "1 of 1 model files missing from the models folder")],
      }),
    });
    const finding = snapshot.findings.find((f) => f.kind === "comfyui-recipe-weights-missing");
    assert.ok(finding);
    assert.equal(finding.severity, "degraded");
    assert.deepEqual(finding.remedy, { control: "component-download", target: weightsId });
    assert.ok(suppressedRefs(snapshot).has("comfyui-recipe-disabled:wan-video"));
  });

  it("rows 31–32: weights downloading are not a fault; the disabled recipe waits as advisory (R-22)", () => {
    const weightsId = comfyUiWeightsComponentId("wan-video");
    const downloading = derive({
      setup: {
        components: [component(weightsId, { state: "downloading" })],
        running: true,
        diskFreeMb: 500_000,
        diskCheckedAt: RECENT,
      },
      comfyui: comfyui({
        recipes: [recipe("wan-video", "disabled", "files", "1 of 1 model files missing from the models folder")],
      }),
    });
    assert.equal(downloading.findings.some((f) => f.kind === "comfyui-recipe-weights-missing"), false);
    const waiting = downloading.findings.find((f) => f.kind === "waiting-on-component");
    assert.ok(waiting, "something waits, so the transit is stated");
    assert.equal(waiting.severity, "advisory");
    assert.ok(String(waiting.facts.find((f) => f.name === "waiting")?.value).includes("wan-video"));

    // Row 31: the same download with nothing waiting on it is no finding at all.
    const alone = derive({
      setup: {
        components: [component("ollama-runtime", { state: "downloading" })],
        running: true,
        diskFreeMb: 500_000,
        diskCheckedAt: RECENT,
      },
    });
    assert.equal(alone.findings.some((f) => f.kind === "waiting-on-component"), false);
  });
});

describe("a recipe with a failed digest (R-20.6)", () => {
  it("row 6: cause names the file, remedy is repair, and a retry is stated not to resolve it", () => {
    const weightsId = comfyUiWeightsComponentId("wan-video");
    const reason =
      "wan.safetensors does not match its pinned version — expected sha256 aaaaaaaa…, found sha256 bbbbbbbb…";
    const snapshot = derive({
      setup: {
        components: [component(weightsId, { state: "present" })],
        running: false,
        diskFreeMb: 500_000,
        diskCheckedAt: RECENT,
      },
      comfyui: comfyui({ recipes: [recipe("wan-video", "disabled", "digest", reason)] }),
    });
    const finding = snapshot.findings.find((f) => f.kind === "comfyui-recipe-digest-mismatch");
    assert.ok(finding);
    assert.equal(finding.cause.statement, reason);
    assert.deepEqual(finding.remedy, { control: "component-repair", target: weightsId });
    assert.match(finding.note ?? "", /retry will not resolve/i);
    assert.ok(suppressedRefs(snapshot).has("comfyui-recipe-disabled:wan-video"));
  });
});

describe("an engine that is down (R-20.7)", () => {
  it("row 7: engine absent with three disabled recipes is one cause with three reachable consequences", () => {
    const snapshot = derive({
      comfyui: comfyui({
        state: "absent",
        instanceId: null,
        recipes: [
          recipe("a", "disabled", "engine", "no ComfyUI engine is configured or installed"),
          recipe("b", "disabled", "engine", "no ComfyUI engine is configured or installed"),
          recipe("c", "disabled", "engine", "no ComfyUI engine is configured or installed"),
        ],
      }),
    });
    const cause = snapshot.findings.find((f) => f.kind === "comfyui-engine-unavailable");
    assert.ok(cause);
    assert.equal(cause.consequences.length, 3);
    const suppressed = suppressedRefs(snapshot);
    for (const id of ["a", "b", "c"]) assert.ok(suppressed.has(`comfyui-recipe-disabled:${id}`));
    assert.equal(consequencesOf(snapshot, cause).length, 3);
    assert.equal(primaryFindings(snapshot).filter((f) => f.kind === "comfyui-recipe-disabled").length, 0);
  });

  it("an engine nobody configured is advisory; one that died is degraded (D5, D6)", () => {
    const absent = derive({ comfyui: comfyui({ state: "absent", instanceId: null }) });
    assert.equal(absent.findings.find((f) => f.kind === "comfyui-engine-unavailable")?.severity, "advisory");
    const failed = derive({ comfyui: comfyui({ state: "failed", detail: "exit code 1" }) });
    assert.equal(failed.findings.find((f) => f.kind === "comfyui-engine-unavailable")?.severity, "degraded");
  });

  it("row 19: absent with no managed runtime on offer keeps its severity and carries no remedy (R-5, R-25)", () => {
    const snapshot = derive({ comfyui: comfyui({ state: "absent", instanceId: null }) });
    const finding = snapshot.findings.find((f) => f.kind === "comfyui-engine-unavailable")!;
    assert.equal(finding.remedy, null);
    assert.equal(finding.severity, "advisory");
  });

  it("row 21: a state that owes a reason and gave none is carried as upstream-generic naming SPEC-021 (R-6)", () => {
    const snapshot = derive({ comfyui: comfyui({ state: "unreachable", detail: null }) });
    const finding = snapshot.findings.find((f) => f.kind === "comfyui-engine-unavailable")!;
    assert.equal(finding.cause.upstreamGeneric, "SPEC-021");
  });

  it("a starting engine is transient, not a fault (R-22)", () => {
    const snapshot = derive({
      comfyui: comfyui({ state: "starting", recipes: [recipe("a", "disabled", "engine", "the engine is starting")] }),
    });
    assert.equal(snapshot.findings.some((f) => f.kind === "comfyui-engine-unavailable"), false);
  });
});

describe("a URL engine with no mapped models folder (R-20.8)", () => {
  it("row 8: stated as a limit of a non-managed engine, not a fault", () => {
    const snapshot = derive({
      comfyui: comfyui({
        source: "user-url",
        recipes: [
          recipe("a", "disabled", "models-folder", "Arke cannot verify this engine's files — map its models folder to enable"),
        ],
      }),
    });
    const finding = snapshot.findings.find((f) => f.kind === "comfyui-models-folder-unmapped");
    assert.ok(finding);
    assert.equal(finding.severity, "advisory");
    assert.match(finding.note ?? "", /not a fault/i);
    assert.deepEqual(finding.remedy, { control: "comfyui-map-models-folder" });
    assert.ok(suppressedRefs(snapshot).has("comfyui-recipe-disabled:a"));
  });
});

describe("two causes, one consequence (R-9)", () => {
  it("row 36: two cause findings, one consequence node, two edges, reported once", () => {
    const weightsId = comfyUiWeightsComponentId("wan-video");
    const snapshot = derive({
      setup: {
        components: [
          component(weightsId, {
            state: "blocked",
            detail: "needs 17 GB plus room to work; this disk has 4 GB free",
            blockedBy: "disk",
            blockedVolumeRoot: "C:\\",
          }),
        ],
        running: false,
        diskFreeMb: 4096,
        diskCheckedAt: RECENT,
      },
      comfyui: comfyui({
        state: "failed",
        detail: "exit code 1",
        recipes: [recipe("wan-video", "disabled", "engine", "the engine did not start")],
      }),
    });
    const consequenceRef = "comfyui-recipe-disabled:wan-video";
    const referencing = snapshot.findings.filter((f) => f.consequences.includes(consequenceRef));
    assert.equal(referencing.length, 2, "the disk cause and the engine cause both reference it");
    assert.equal(snapshot.findings.filter((f) => findingRef(f) === consequenceRef).length, 1);
  });
});

describe("the hardware facts (R-4, D5)", () => {
  it("row 17: never asked is unmeasured, names the measuring control, and is never unknown", () => {
    const snapshot = derive({ runtime: null });
    const finding = snapshot.findings.find((f) => f.kind === "hardware-unmeasured");
    assert.ok(finding);
    assert.equal(finding.severity, "unmeasured");
    assert.equal(finding.remedy?.control, "runtime-detect");
    assert.match(finding.note ?? "", /dispatch remains permitted/i);
    assert.equal(snapshot.findings.some((f) => f.kind === "hardware-unknown"), false);
  });

  it("row 16: probed and failed is unknown, and dispatch is stated to remain permitted", () => {
    const snapshot = derive({
      runtime: {
        probes: { vramMb: null, memMb: 32768, diskFreeMb: null },
        detectedAt: RECENT,
        models: [],
        recommended: {},
      },
    });
    const finding = snapshot.findings.find((f) => f.kind === "hardware-unknown");
    assert.ok(finding);
    assert.equal(finding.severity, "unknown");
    assert.match(finding.note ?? "", /dispatch remains permitted/i);
    assert.equal(snapshot.findings.some((f) => f.kind === "hardware-unmeasured"), false);
  });
});

describe("derivation discipline (R-11, R-14, R-35)", () => {
  it("row 33: identical inputs produce an identical snapshot, firstSeen included", () => {
    const previous = derive({ comfyui: comfyui({ state: "failed", detail: "exit code 1" }) });
    const a = derive({ comfyui: comfyui({ state: "failed", detail: "exit code 1" }) }, previous);
    const b = derive({ comfyui: comfyui({ state: "failed", detail: "exit code 1" }) }, previous);
    assert.deepEqual(a, b);
  });

  it("row 34: a condition true since an earlier snapshot keeps its firstSeen; a new one starts now", () => {
    const earlier = deriveDiagnostics({
      sources: sources({ comfyui: comfyui({ state: "failed", detail: "exit code 1" }) }),
      tails: { appLog: [] },
      previous: null,
      now: "2026-08-28T08:00:00.000Z",
    });
    const later = derive(
      {
        comfyui: comfyui({ state: "failed", detail: "exit code 1" }),
        queues: [{ provider: "fal", paused: true, pauseKind: "credential", reason: "no credential", held: 1 }],
      },
      earlier,
    );
    const engine = later.findings.find((f) => f.kind === "comfyui-engine-unavailable")!;
    const lane = later.findings.find((f) => f.kind === "queue-paused-credential")!;
    assert.equal(engine.firstSeen, "2026-08-28T08:00:00.000Z");
    assert.equal(lane.firstSeen, NOW);
  });

  it("row 28: a rule that throws becomes the reserved finding with the error's type, and every other rule runs", () => {
    const bomb = {
      kind: "provider-repeated-faults" as const,
      run(): never {
        throw new RangeError("secret-laden message that must not be carried");
      },
    };
    const snapshot = deriveWithRules([bomb], {
      sources: sources({ runtime: null }),
      tails: { appLog: [] },
      previous: null,
      now: NOW,
    });
    const reserved = snapshot.findings.find((f) => f.kind === "rule-failed");
    assert.ok(reserved);
    assert.equal(reserved.occurrence, "provider-repeated-faults");
    assert.equal(reserved.facts.find((f) => f.name === "error-type")?.value, "RangeError");
    assert.ok(!JSON.stringify(reserved).includes("secret-laden"), "the message is unvouched text");
  });

  it("row 27: an unreadable log tail is named unavailable in the sources", () => {
    const snapshot = deriveDiagnostics({
      sources: sources(),
      tails: { appLog: "unavailable" },
      previous: null,
      now: NOW,
    });
    assert.equal(snapshot.sources.find((s) => s.name === "log.app")?.state, "unavailable");
  });

  it("row 45: everything sound is a stated result naming what was checked", () => {
    const snapshot = derive({ runtime: sources().runtime });
    assert.equal(snapshot.findings.length, 0);
    assert.ok(snapshot.checked.length >= 8, "the rules that ran are named");
    assert.ok(snapshot.checked.includes("work-held-by-engine"));
  });

  it("row 46: every finding in a populated snapshot satisfies the contract", () => {
    const snapshot = derive({
      runtime: null,
      comfyui: comfyui({
        state: "failed",
        detail: null,
        recipes: [recipe("a", "disabled", "engine", "the engine did not start")],
      }),
      queues: [{ provider: "fal", paused: true, pauseKind: "credential", reason: "no credential", held: 2 }],
    });
    assert.ok(snapshot.findings.length >= 3);
    for (const finding of snapshot.findings) FindingSchema.parse(finding);
  });

  it("row 20 / 35: a subsystem reason is carried through the boundary, and alteration is recorded (R-13)", () => {
    const boundary = { scrub: (text: string) => text.replaceAll("sk-secret", "[redacted]") };
    const clean = deriveDiagnostics({
      sources: sources({
        queues: [{ provider: "fal", paused: true, pauseKind: "credential", reason: "key sk-secret rejected", held: 1 }],
      }),
      tails: { appLog: [] },
      previous: null,
      now: NOW,
      boundary,
    });
    const finding = clean.findings.find((f) => f.kind === "queue-paused-credential")!;
    assert.equal(finding.cause.statement, "key [redacted] rejected");
    assert.equal(finding.cause.redacted, true);

    const untouched = deriveDiagnostics({
      sources: sources({
        queues: [{ provider: "fal", paused: true, pauseKind: "credential", reason: "no credential stored", held: 1 }],
      }),
      tails: { appLog: [] },
      previous: null,
      now: NOW,
      boundary,
    });
    const carried = untouched.findings.find((f) => f.kind === "queue-paused-credential")!;
    assert.equal(carried.cause.statement, "no credential stored");
    assert.equal(carried.cause.redacted, undefined);
  });

  it("row 51: every remedy in a populated snapshot names a registry control, never an instruction (R-24, R-26)", () => {
    const snapshot = derive({
      runtime: null,
      comfyui: comfyui({ state: "failed", detail: "exit code 1", recipes: [recipe("a", "disabled", "engine", "x")] }),
      queues: [{ provider: "fal", paused: true, pauseKind: "credential", reason: "no credential", held: 2 }],
    });
    for (const finding of snapshot.findings) {
      if (finding.remedy === null) continue;
      assert.ok(finding.remedy.control in CONTROL_REGISTRY);
    }
  });

  it("row 49: the source projection carries exactly R-17's fields", () => {
    const app = {
      ...sources(),
      // Fields outside R-17's list that must not reach a rule.
      vendorAuth: { available: false },
      presets: [],
      agents: [],
    } as never;
    const projected = diagnosticsSources(app);
    assert.ok(!("vendorAuth" in projected));
    assert.ok(!("presets" in projected));
    assert.ok(!("agents" in projected));
    assert.equal(Object.keys(projected).length, 21);
  });
});

describe("the declared registry and kinds (R-8, R-24, R-27)", () => {
  it("every declared subsumption edge names a declared kind", () => {
    for (const [kind, { subsumes }] of Object.entries(FINDING_KINDS)) {
      for (const target of subsumes) {
        assert.ok(target in FINDING_KINDS, `${kind} subsumes unknown kind ${target}`);
      }
    }
  });

  it("every control names its label, its place in the product's words, and its route", () => {
    for (const control of Object.values(CONTROL_REGISTRY)) {
      assert.ok(control.label.length > 0);
      assert.ok(control.place.startsWith("Settings") || control.place.startsWith("Activity"));
      assert.ok(control.route.startsWith("/"));
    }
  });

  it("row 40: findings order blocking before degraded before advisory before unknown before unmeasured", () => {
    const snapshot = derive({
      runtime: null,
      comfyui: comfyui({
        state: "failed",
        detail: "exit code 1",
        recipes: [recipe("a", "disabled", "engine", "the engine did not start")],
      }),
      queues: [{ provider: "fal", paused: true, pauseKind: "credential", reason: "no credential", held: 2 }],
      jobs: [job({ engine: { source: "managed", instanceId: ENGINE_INSTANCE } })],
    });
    const ranks = snapshot.findings.map((f) =>
      ["blocking", "degraded", "advisory", "unknown", "unmeasured"].indexOf(f.severity),
    );
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  });
});
