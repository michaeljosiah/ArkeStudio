import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid, type ClientMessage, type LedgerEntry } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";

/**
 * The spend status states the fate of the read behind it (SPEC-008 R-19; SPEC-032 R-21,
 * matrix row 15a).
 *
 * The seed publishes `app.ledgerUnavailable`, but every spend evaluation re-reads the file
 * through `LedgerFile`, and that read folded its own failure into an empty array — so the
 * threshold was evaluated against zero and the bundle exported `rollingMicroUsd: 0,
 * alerted: false` marked `read`, beside `ledgerUnavailable: true`. As in the seed's test, the
 * unreadable file is a directory named ledger.jsonl: readFile fails EISDIR on every platform.
 */

async function startedAt(root: string) {
  const provider = new FsWorldProvider(root, { clock: () => "2026-08-28T12:00:00.000Z" });
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    // The desktop shell's own wiring: the seed path is the ledger file (apps/desktop/main.ts).
    ledgerSeedPath: join(root, "ledger.jsonl"),
  });
  await coordinator.start(0);
  return {
    coordinator,
    send: (msg: ClientMessage) =>
      (coordinator as unknown as { handleClientMessage(m: ClientMessage): Promise<void> }).handleClientMessage(msg),
    close: async () => {
      await coordinator.stop();
      await provider.close();
    },
  };
}

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

describe("spend over an unreadable ledger states the failed read (SPEC-008 R-19, row 15a)", () => {
  it("seeds a status carrying the failure — and its zero never marked read in the sources", async () => {
    const { root } = await makeTempRoot();
    await mkdir(join(root, "ledger.jsonl"));
    const { coordinator, close } = await startedAt(root);
    try {
      const app = coordinator.getState().app;
      assert.equal(app.spend?.ledgerUnavailable, true);
      assert.equal(app.spend?.rollingMicroUsd, 0);
      assert.equal(app.spend?.alerted, false, "an alert cannot fire off a read that failed");
      assert.deepEqual(app.drift, [], "no drift is derived from nothing");
      const bundle = await coordinator.diagnostics();
      const exported = bundle["app"] as { spend: { ledgerUnavailable: boolean } };
      const findings = bundle["findings"] as { sources: Array<{ name: string; state: string }> };
      assert.equal(exported.spend.ledgerUnavailable, true, "the exported block says it itself");
      assert.equal(findings.sources.find((s) => s.name === "app.spend")?.state, "unavailable");
    } finally {
      await close();
    }
  });

  it("a ledger nobody has written yet evaluates as empty, not failed — the merely-empty screen is unchanged (row 15)", async () => {
    const { root } = await makeTempRoot();
    const { coordinator, close } = await startedAt(root);
    try {
      assert.equal(coordinator.getState().app.spend?.ledgerUnavailable, false);
      const bundle = await coordinator.diagnostics();
      const findings = bundle["findings"] as { sources: Array<{ name: string; state: string }> };
      assert.equal(findings.sources.find((s) => s.name === "app.spend")?.state, "read");
    } finally {
      await close();
    }
  });

  it("re-evaluating from Settings states the fate of that fresh read, not the seed's", async () => {
    const { root } = await makeTempRoot();
    await mkdir(join(root, "ledger.jsonl"));
    const { coordinator, send, close } = await startedAt(root);
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
    const { coordinator, close } = await startedAt(root);
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
});
