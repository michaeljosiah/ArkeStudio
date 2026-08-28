import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ModelManifestSchema,
  PROVIDER_FAULT_THRESHOLD,
  SPEND_RISE_FLOOR_MICRO_USD,
  deriveDiagnostics,
  spendProjection,
  type DiagnosticsSources,
  type LedgerEntry,
  ulid,
} from "../src/index.js";
import { IDLE_UPDATE_STATE } from "../src/update.js";

/**
 * SPEC-032 §1.5, §1.6 (R-20.9, R-20.10): the two windowed correlations (#555). Test names cite
 * the adversarial matrix rows they cover.
 */

const NOW = "2026-08-28T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

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
      detectedAt: "2026-08-28T11:55:00.000Z",
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

// A provider.fault record is credential-or-billing class by construction — the queue's
// classifier admits 401/403/402/quota/billing and nothing else — so the fixture speaks 401.
function fault(provider: string, minutesAgo: number, message = "FAL rejected the key (HTTP 401)") {
  return {
    at: new Date(NOW_MS - minutesAgo * 60_000).toISOString(),
    kind: "provider.fault",
    provider,
    message,
  };
}

function deriveWithTail(
  tail: Array<Record<string, unknown>> | "unavailable",
  over: Partial<DiagnosticsSources> = {},
) {
  return deriveDiagnostics({ sources: sources(over), tails: { appLog: tail }, previous: null, now: NOW });
}

describe("repeated provider faults (R-20.9)", () => {
  it("row 9: two faults inside the window are below the threshold — no finding", () => {
    const snapshot = deriveWithTail([fault("fal", 2), fault("fal", 5)]);
    assert.equal(snapshot.findings.some((f) => f.kind === "provider-repeated-faults"), false);
  });

  it("row 10: three faults inside the window are one finding with the count and the window", () => {
    const snapshot = deriveWithTail([fault("fal", 2), fault("fal", 5), fault("fal", 14)]);
    const findings = snapshot.findings.filter((f) => f.kind === "provider-repeated-faults");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, "degraded");
    assert.equal(findings[0]!.facts.find((f) => f.name === "fault-count")?.value, 3);
    assert.equal(findings[0]!.facts.find((f) => f.name === "window-minutes")?.value, 15);
    // The cause is the latest fault's own words, never one finding per fault.
    assert.equal(findings[0]!.cause.statement, "FAL rejected the key (HTTP 401)");
    assert.deepEqual(findings[0]!.remedy, { control: "provider-key", target: "fal" });
  });

  it("row 11: three faults spanning sixteen minutes are no finding — the window is measured from the derivation instant", () => {
    const snapshot = deriveWithTail([fault("fal", 1), fault("fal", 8), fault("fal", 16)]);
    assert.equal(snapshot.findings.some((f) => f.kind === "provider-repeated-faults"), false);
  });

  it("row 12: two providers each over the threshold are two findings of one kind, separately addressable", () => {
    const snapshot = deriveWithTail([
      fault("fal", 1),
      fault("fal", 2),
      fault("fal", 3),
      fault("elevenlabs", 1),
      fault("elevenlabs", 2),
      fault("elevenlabs", 4),
    ]);
    const findings = snapshot.findings.filter((f) => f.kind === "provider-repeated-faults");
    assert.equal(findings.length, 2);
    assert.deepEqual(new Set(findings.map((f) => f.occurrence)), new Set(["fal", "elevenlabs"]));
  });

  it("row 27: an unreadable log makes the correlation unknown, naming the missing input; other rules still run", () => {
    const snapshot = deriveWithTail("unavailable", {
      queues: [{ provider: "fal", paused: true, pauseKind: "credential", reason: "no credential", held: 1 }],
    });
    const unknown = snapshot.findings.find((f) => f.kind === "correlation-unavailable");
    assert.ok(unknown);
    assert.equal(unknown.severity, "unknown");
    assert.equal(unknown.occurrence, "provider-repeated-faults");
    assert.equal(unknown.facts.find((f) => f.name === "missing-input")?.value, "log.app");
    assert.ok(snapshot.findings.some((f) => f.kind === "queue-paused-credential"), "others unaffected");
    assert.equal(snapshot.sources.find((s) => s.name === "log.app")?.state, "unavailable");
  });

  it("records outside the shape — other kinds, torn fields — are not counted", () => {
    const snapshot = deriveWithTail([
      { at: NOW, kind: "provider.validated", provider: "fal" },
      { at: NOW, kind: "provider.fault" }, // no provider named
      { kind: "provider.fault", provider: "fal" }, // no instant
      fault("fal", 1),
      fault("fal", 2),
    ]);
    assert.equal(snapshot.findings.some((f) => f.kind === "provider-repeated-faults"), false);
  });

  it(`the threshold is the spec's: exactly ${PROVIDER_FAULT_THRESHOLD} faults fire`, () => {
    const tail = Array.from({ length: PROVIDER_FAULT_THRESHOLD }, (_, i) => fault("fal", i + 1));
    assert.ok(
      deriveWithTail(tail).findings.some((f) => f.kind === "provider-repeated-faults"),
    );
  });

  it("a record dated after the derivation instant is outside the window — a corrected clock cannot inflate the count", () => {
    const snapshot = deriveWithTail([
      fault("fal", 1),
      fault("fal", 2),
      fault("fal", -30), // half an hour in the future
    ]);
    assert.equal(snapshot.findings.some((f) => f.kind === "provider-repeated-faults"), false);
  });

  it("the remedy follows where the credential lives: key row, sign-in, or nothing (R-25)", () => {
    const three = (provider: string) => [fault(provider, 1), fault(provider, 2), fault(provider, 3)];
    const stored = deriveWithTail(three("fal")).findings.find((f) => f.kind === "provider-repeated-faults")!;
    assert.deepEqual(stored.remedy, { control: "provider-key", target: "fal" });
    // Higgsfield's credential lives in a tool we drive; its providers-pane control is Sign in.
    const external = deriveWithTail(three("higgsfield")).findings.find((f) => f.kind === "provider-repeated-faults")!;
    assert.deepEqual(external.remedy, { control: "provider-sign-in", target: "higgsfield" });
    // A keyless runtime has no credential control at all; the finding says so rather than
    // pointing at a key row that does not exist.
    const keyless = deriveWithTail(three("ollama")).findings.find((f) => f.kind === "provider-repeated-faults")!;
    assert.equal(keyless.remedy, null);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

function entry(daysAgo: number, model: string, microUsd: number): LedgerEntry {
  return {
    ts: new Date(NOW_MS - daysAgo * DAY_MS).toISOString(),
    worldId: ulid(),
    jobId: `jb_${ulid()}`,
    provider: "fal",
    model,
    outcome: "succeeded",
    estimatedMicroUsd: microUsd,
    actualMicroUsd: microUsd,
  };
}

describe("spend above the previous period (R-20.10)", () => {
  it("row 13: up 60% and 2,000,000 microUSD names the model with the largest share", () => {
    const snapshot = deriveWithTail([], {
      ledger: [
        entry(10, "veo-3", 2_000_000),
        entry(9, "flux-pro", 1_500_000),
        entry(3, "veo-3", 4_500_000),
        entry(2, "flux-pro", 1_500_000),
      ],
    });
    const finding = snapshot.findings.find((f) => f.kind === "spend-above-previous");
    assert.ok(finding);
    assert.equal(finding.severity, "advisory");
    assert.equal(finding.facts.find((f) => f.name === "later-micro-usd")?.value, 6_000_000);
    assert.equal(finding.facts.find((f) => f.name === "earlier-micro-usd")?.value, 3_500_000);
    assert.equal(finding.facts.find((f) => f.name === "largest-share")?.value, "veo-3");
    assert.equal(finding.remedy, null);
  });

  it("row 14: up 60% and 200,000 microUSD is below the floor — no finding", () => {
    const snapshot = deriveWithTail([], {
      ledger: [entry(10, "veo-3", 300_000), entry(3, "veo-3", 500_000)],
    });
    assert.equal(snapshot.findings.some((f) => f.kind === "spend-above-previous"), false);
  });

  it("a large rise under fifty per cent is no finding", () => {
    const snapshot = deriveWithTail([], {
      ledger: [entry(10, "veo-3", 10_000_000), entry(3, "veo-3", 13_000_000)],
    });
    assert.equal(snapshot.findings.some((f) => f.kind === "spend-above-previous"), false);
  });

  it("row 14a: an equal share names both models, in manifest order — never an arbitrary winner", () => {
    // A schema-valid manifest, so the fixture stays honest if the rule ever reads more than ids.
    const model = (id: string, capability: "image" | "video") => ({
      id,
      provider: "fal" as const,
      capability,
      displayName: id,
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "perImage" as const, microUsdPerImage: 1 },
    });
    const manifest = ModelManifestSchema.parse({
      manifestVersion: 1,
      generated: "2026-08-28",
      models: [model("flux-pro", "image"), model("veo-3", "video")],
    });
    const snapshot = deriveWithTail([], {
      manifest,
      ledger: [
        entry(10, "anchor", 100_000),
        entry(3, "veo-3", 1_000_000),
        entry(2, "flux-pro", 1_000_000),
      ],
    });
    const finding = snapshot.findings.find((f) => f.kind === "spend-above-previous");
    assert.ok(finding);
    // flux-pro precedes veo-3 in the manifest, whatever the ledger order was.
    assert.equal(finding.facts.find((f) => f.name === "largest-share")?.value, "flux-pro, veo-3");
  });

  it("a future-dated ledger entry belongs to no window — a corrected clock cannot report a rise", () => {
    const snapshot = deriveWithTail([], {
      ledger: [
        entry(10, "veo-3", 2_000_000),
        entry(3, "veo-3", 500_000),
        entry(-2, "veo-3", 50_000_000), // two days in the future
      ],
    });
    assert.equal(snapshot.findings.some((f) => f.kind === "spend-above-previous"), false);
  });

  it("row 15: a four-day-old install has no previous period — no finding, and no unknown either (R-21)", () => {
    const snapshot = deriveWithTail([], {
      ledger: [entry(3, "veo-3", 50_000_000), entry(1, "veo-3", 20_000_000)],
    });
    assert.equal(snapshot.findings.some((f) => f.kind === "spend-above-previous"), false);
    assert.equal(snapshot.findings.some((f) => f.kind === "correlation-unavailable"), false);
  });

  it("a quiet previous week with real history still compares — a rise from zero is a rise", () => {
    const snapshot = deriveWithTail([], {
      ledger: [entry(20, "veo-3", 500_000), entry(2, "veo-3", SPEND_RISE_FLOOR_MICRO_USD)],
    });
    const finding = snapshot.findings.find((f) => f.kind === "spend-above-previous");
    assert.ok(finding, "an entry older than both windows proves a previous period existed");
    assert.equal(finding.facts.find((f) => f.name === "earlier-micro-usd")?.value, 0);
  });

  it("row 23: the world and production identifiers on ledger entries never reach the finding (R-30)", () => {
    const worldId = ulid();
    const snapshot = deriveWithTail([], {
      ledger: [
        { ...entry(10, "veo-3", 2_000_000), worldId, productionId: "saltlight" },
        { ...entry(3, "veo-3", 6_000_000), worldId, productionId: "saltlight" },
      ],
    });
    const finding = snapshot.findings.find((f) => f.kind === "spend-above-previous");
    assert.ok(finding);
    const serialised = JSON.stringify(finding);
    assert.ok(!serialised.includes(worldId), "no world id");
    assert.ok(!serialised.includes("saltlight"), "no production id");
  });

  it("the projection carries when, what model and what it cost — actual where recorded, estimate otherwise", () => {
    const projected = spendProjection([
      { ...entry(1, "veo-3", 100), actualMicroUsd: null, estimatedMicroUsd: 250 },
    ]);
    assert.equal(projected.length, 1);
    assert.deepEqual(Object.keys(projected[0]!).sort(), ["microUsd", "model", "ts"]);
    assert.equal(projected[0]!.microUsd, 250);
  });
});
