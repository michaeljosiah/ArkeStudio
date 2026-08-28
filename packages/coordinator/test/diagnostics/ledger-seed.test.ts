import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";

/**
 * The ledger seed publishes its own failure (SPEC-032 R-21, matrix row 15a).
 *
 * The seed read used to fold every failure into an empty array, so a ledger.jsonl that existed
 * and could not be read published as a clean, empty ledger — and the spend correlation reported
 * nothing wrong off a lie. EACCES has no portable fixture, so the unreadable file here is a
 * directory named ledger.jsonl: readFile fails EISDIR on every platform, which is exactly a
 * path that exists and cannot be read as a file.
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
    close: async () => {
      await coordinator.stop();
      await provider.close();
    },
  };
}

describe("the ledger seed carries availability (SPEC-032 R-21, row 15a)", () => {
  it("a ledger that exists and cannot be read publishes unavailable, and the snapshot says unknown", async () => {
    const { root } = await makeTempRoot();
    await mkdir(join(root, "ledger.jsonl"));
    const { coordinator, close } = await startedAt(root);
    try {
      const app = coordinator.getState().app;
      assert.equal(app.ledgerUnavailable, true);
      assert.deepEqual(app.ledger, []);
      const bundle = await coordinator.diagnostics();
      const findings = bundle["findings"] as {
        sources: Array<{ name: string; state: string }>;
        findings: Array<{ kind: string; occurrence: string }>;
      };
      assert.equal(findings.sources.find((s) => s.name === "app.ledger")?.state, "unavailable");
      assert.ok(
        findings.findings.some(
          (f) => f.kind === "correlation-unavailable" && f.occurrence === "spend-above-previous",
        ),
        "the spend correlation must answer unknown, never a clean bill off a failed read",
      );
    } finally {
      await close();
    }
  });

  it("a ledger nobody has written yet is absence, not unavailability — no unknown (row 15)", async () => {
    const { root } = await makeTempRoot();
    const { coordinator, close } = await startedAt(root);
    try {
      assert.equal(coordinator.getState().app.ledgerUnavailable, false);
      const bundle = await coordinator.diagnostics();
      const findings = bundle["findings"] as {
        sources: Array<{ name: string; state: string }>;
        findings: Array<{ kind: string }>;
      };
      assert.equal(findings.sources.find((s) => s.name === "app.ledger")?.state, "read");
      assert.equal(findings.findings.some((f) => f.kind === "correlation-unavailable"), false);
    } finally {
      await close();
    }
  });

  it("a readable seed lands its entries with availability intact", async () => {
    const { root } = await makeTempRoot();
    const entry = sampleEntry();
    await writeFile(join(root, "ledger.jsonl"), JSON.stringify(entry) + "\n", "utf8");
    const { coordinator, close } = await startedAt(root);
    try {
      const app = coordinator.getState().app;
      assert.equal(app.ledgerUnavailable, false);
      assert.equal(app.ledger.length, 1);
      assert.equal(app.ledger[0]!.jobId, entry.jobId);
    } finally {
      await close();
    }
  });

  it("a crash-torn final line is skipped, never fatal — the app boots and the complete entries land", async () => {
    // The seed runs before LedgerFile's tail repair, so a strict parse here was a launch
    // failure on the most likely real unreadable ledger: the one a crash mid-append leaves.
    const { root } = await makeTempRoot();
    const entry = sampleEntry();
    await writeFile(
      join(root, "ledger.jsonl"),
      `${JSON.stringify(entry)}\n{"ts":"2026-08-28T11:`,
      "utf8",
    );
    const { coordinator, close } = await startedAt(root);
    try {
      const app = coordinator.getState().app;
      assert.equal(app.ledgerUnavailable, false, "a torn line is not a failed file read");
      assert.equal(app.ledger.length, 1);
      assert.equal(app.ledger[0]!.jobId, entry.jobId);
    } finally {
      await close();
    }
  });
});

function sampleEntry() {
  return {
    ts: "2026-08-28T11:00:00.000Z",
    worldId: ulid(),
    jobId: `jb_${ulid()}`,
    provider: "fal",
    model: "veo-3",
    outcome: "succeeded",
    estimatedMicroUsd: 250_000,
    actualMicroUsd: 250_000,
  };
}
