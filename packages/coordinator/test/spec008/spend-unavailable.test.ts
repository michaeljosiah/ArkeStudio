import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid, type LedgerEntry, type ModelManifest } from "@arke-studio/contracts";
import { makeTempRoot } from "../world/helpers.js";
import { startLedgerCoordinator } from "../spend/seeded-ledger.js";

/**
 * The spend status states the fate of the read behind it (SPEC-008 R-19; SPEC-032 R-21,
 * matrix row 15a).
 *
 * The seed publishes `app.ledgerUnavailable`, but every spend evaluation re-reads the file
 * through `LedgerFile`, and that read folded its own failure into an empty array — so the
 * threshold was evaluated against zero and the bundle exported `rollingMicroUsd: 0,
 * alerted: false` marked `read`, beside `ledgerUnavailable: true`.
 */

const MANIFEST: ModelManifest = {
  manifestVersion: 7,
  generated: "2026-07-28",
  models: [
    {
      id: "veo-3",
      provider: "fal",
      capability: "video",
      displayName: "Veo 3",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "perSecond", microUsdPerSecond: 21667 },
    },
  ],
};

// Inside any rolling window, wherever this runs — evaluateSpend measures from the wall clock.
const RECENT = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ts: RECENT,
    worldId: ulid(),
    jobId: `jb_${ulid()}`,
    provider: "fal",
    model: "veo-3",
    outcome: "succeeded",
    estimatedMicroUsd: 250_000,
    actualMicroUsd: 250_000,
    actualSource: "provider-reported",
    ...overrides,
  };
}

/** Four provider-reported entries 30% over estimate — drift, when the read allows deriving it. */
const DRIFTING = Array.from({ length: 4 }, () =>
  entry({ estimatedMicroUsd: 100_000, actualMicroUsd: 130_000 }),
);

describe("spend over an unreadable ledger states the failed read (SPEC-008 R-19, row 15a)", () => {
  it("seeds a status carrying the failure — and its zero never marked read in the sources", async () => {
    const { root } = await makeTempRoot();
    await mkdir(join(root, "ledger.jsonl"));
    const { coordinator, close } = await startLedgerCoordinator(root, { manifest: MANIFEST });
    try {
      const app = coordinator.getState().app;
      assert.equal(app.spend?.ledgerUnavailable, true);
      assert.equal(app.spend?.rollingMicroUsd, 0);
      assert.equal(app.spend?.alerted, false, "an alert cannot fire off a read that failed");
      const bundle = await coordinator.diagnostics();
      const exported = bundle["app"] as { spend: { ledgerUnavailable: boolean } };
      const findings = bundle["findings"] as { sources: Array<{ name: string; state: string }> };
      assert.equal(exported.spend.ledgerUnavailable, true, "the exported block says it itself");
      assert.equal(findings.sources.find((s) => s.name === "app.spend")?.state, "unavailable");
      // Drift is derived from the same read and was not derived at all, so its row says so
      // rather than presenting an uncomputed empty list as a successful read.
      assert.deepEqual(app.drift, []);
      assert.equal(findings.sources.find((s) => s.name === "app.drift")?.state, "unavailable");
    } finally {
      await close();
    }
  });

  it("a ledger nobody has written yet evaluates as empty, not failed — the merely-empty screen is unchanged (row 15)", async () => {
    const { root } = await makeTempRoot();
    const { coordinator, close } = await startLedgerCoordinator(root, { manifest: MANIFEST });
    try {
      assert.equal(coordinator.getState().app.spend?.ledgerUnavailable, false);
      const bundle = await coordinator.diagnostics();
      const findings = bundle["findings"] as { sources: Array<{ name: string; state: string }> };
      assert.equal(findings.sources.find((s) => s.name === "app.spend")?.state, "read");
      assert.equal(findings.sources.find((s) => s.name === "app.drift")?.state, "read");
    } finally {
      await close();
    }
  });

  it("re-evaluating from Settings states the fate of that fresh read, not the seed's", async () => {
    const { root } = await makeTempRoot();
    await mkdir(join(root, "ledger.jsonl"));
    const { coordinator, send, close } = await startLedgerCoordinator(root);
    try {
      await send({ kind: "set-spend-threshold", thresholdMicroUsd: 5_000_000, periodDays: 7 });
      const spend = coordinator.getState().app.spend;
      assert.equal(spend?.settings.thresholdMicroUsd, 5_000_000, "the setting still lands");
      assert.equal(spend?.ledgerUnavailable, true, "a fresh evaluation over the same failed read says so");
    } finally {
      await close();
    }
  });

  it("a read that works publishes read — appends evaluate from the real file with the flag down", async () => {
    const { root } = await makeTempRoot();
    await writeFile(join(root, "ledger.jsonl"), JSON.stringify(entry()) + "\n", "utf8");
    const { coordinator, close } = await startLedgerCoordinator(root);
    try {
      assert.equal(coordinator.getState().app.spend?.ledgerUnavailable, false);
      await coordinator.recordLedger(entry());
      const spend = coordinator.getState().app.spend;
      assert.equal(spend?.ledgerUnavailable, false);
      assert.equal(spend?.rollingMicroUsd, 500_000, "both entries count — the evaluation read the file");
    } finally {
      await close();
    }
  });

  /*
   * Drift is not derived from a failed read, and the seeded reports are not cleared by one:
   * an empty list would read as "nothing drifted", downgrading a true manifest warning to
   * silence on a transient I/O failure. Asserted with a manifest present, or the `manifest &&`
   * short-circuit would carry these assertions whether the guard exists or not.
   */
  it("keeps drift derived from a read that worked, and derives none from one that failed", async () => {
    const readable = await makeTempRoot();
    await writeFile(
      join(readable.root, "ledger.jsonl"),
      DRIFTING.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    const good = await startLedgerCoordinator(readable.root, { manifest: MANIFEST });
    try {
      const drift = good.coordinator.getState().app.drift;
      assert.equal(drift.length, 1, "a readable ledger still reports drift");
      assert.equal(drift[0]!.modelId, "veo-3");
    } finally {
      await good.close();
    }

    const unreadable = await makeTempRoot();
    await mkdir(join(unreadable.root, "ledger.jsonl"));
    const bad = await startLedgerCoordinator(unreadable.root, { manifest: MANIFEST });
    try {
      assert.deepEqual(bad.coordinator.getState().app.drift, [], "nothing derived from nothing");
    } finally {
      await bad.close();
    }
  });

  /*
   * The append is where a mid-session failure surfaces. It used to throw before the mirror and
   * before the re-evaluation, and SPEC-009's dispatcher catches it to keep the pump alive — so
   * a ledger that went unreadable after boot published nothing at all, and Activity kept
   * showing the boot figure with no caveat.
   */
  it("an append that fails still publishes the read's fate, and still reaches its caller", async () => {
    const { root } = await makeTempRoot();
    await mkdir(join(root, "ledger.jsonl"));
    const { coordinator, close } = await startLedgerCoordinator(root);
    try {
      await assert.rejects(coordinator.recordLedger(entry()), "the caller still learns the append failed");
      const spend = coordinator.getState().app.spend;
      assert.equal(spend?.ledgerUnavailable, true, "the failure reached the screen rather than being swallowed");
      assert.deepEqual(coordinator.getState().app.ledger, [], "an entry that did not land is not mirrored");
    } finally {
      await close();
    }
  });

  /*
   * One crossing, one alert. The un-fired alert on an unavailable status must not clear the
   * latch, or the next read that works re-announces a crossing the user was already told
   * about — the failed read manufacturing an alert rather than merely hiding one.
   */
  it("an outage between two appends does not re-fire the alert for one continuous crossing", async () => {
    const { root } = await makeTempRoot();
    const ledgerPath = join(root, "ledger.jsonl");
    await writeFile(ledgerPath, "", "utf8");
    const { coordinator, send, close } = await startLedgerCoordinator(root);
    try {
      await send({ kind: "set-spend-threshold", thresholdMicroUsd: 300_000, periodDays: 7 });
      await coordinator.recordLedger(entry({ actualMicroUsd: 400_000 }));
      assert.equal(coordinator.getState().app.spend?.alerted, true, "the crossing alerts once");

      // The outage: the same evaluation over a read that fails, then one that works again.
      const ledger = (coordinator as unknown as { ledger: { readAllChecked(): Promise<unknown> } }).ledger;
      const real = ledger.readAllChecked.bind(ledger);
      ledger.readAllChecked = () => Promise.resolve({ entries: [], unavailable: true });
      await coordinator.recordLedger(entry({ actualMicroUsd: 10_000 }));
      assert.equal(coordinator.getState().app.spend?.ledgerUnavailable, true);
      assert.equal(coordinator.getState().app.spend?.alerted, false, "nothing was measured to alert on");
      ledger.readAllChecked = real;
      await coordinator.recordLedger(entry({ actualMicroUsd: 10_000 }));
      assert.equal(coordinator.getState().app.spend?.alerted, true, "still over, as it never stopped being");

      const log = await readFile(join(root, "logs", "app.jsonl"), "utf8");
      const alerts = log.split("\n").filter((l) => l.includes(`"spend.alert"`));
      assert.equal(alerts.length, 1, "one crossing is one alert — the outage did not reset the latch");
    } finally {
      await close();
    }
  });
});
