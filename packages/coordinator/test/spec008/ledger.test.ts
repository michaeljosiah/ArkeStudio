import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEntry, ModelManifest } from "@arke-studio/contracts";
import { detectDrift, evaluateSpend } from "../../src/spend/analytics.js";
import { LedgerFile } from "../../src/spend/ledger.js";

const WORLD_A = "01J8F3K2QW9VZX4N7M0RTYB6HC";
const WORLD_B = "01J8F3K2QW9VZX4N7M0RTYB6HD";

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    ts: "2026-08-01T10:00:00Z",
    worldId: WORLD_A,
    jobId: "jb_01J8E0000000000000000000J1",
    provider: "fal",
    model: "seedance-2.0",
    outcome: "succeeded",
    estimatedMicroUsd: 130000,
    actualMicroUsd: null,
    ...overrides,
  };
}

describe("the ledger file (R-16, R-17, §3.2)", () => {
  it("append-only under concurrent writes — every line lands whole", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-ledger-"));
    const ledger = new LedgerFile(join(dir, "ledger.jsonl"));
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        ledger.append(entry({ jobId: `jb_01J8E00000000000000000${String(i).padStart(4, "0")}`.slice(0, 29) })),
      ),
    );
    await ledger.drain();
    const raw = await readFile(join(dir, "ledger.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 50);
    for (const line of lines) JSON.parse(line); // every line is complete JSON
    assert.equal((await ledger.readAll()).length, 50);
  });

  it("a truncated final line is tolerated and repaired; complete records are never touched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-ledger-"));
    const path = join(dir, "ledger.jsonl");
    const good = JSON.stringify(entry({}));
    await writeFile(path, good + "\n" + good.slice(0, 40), "utf8"); // crash mid-write

    const ledger = new LedgerFile(path);
    const entries = await ledger.readAll();
    assert.equal(entries.length, 1, "the torn tail is not an entry");
    await ledger.append(entry({ outcome: "failed", actualMicroUsd: 40000, actualSource: "provider-reported" }));
    await ledger.drain();

    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 2, "repair removed the torn tail before the append");
    assert.deepEqual(JSON.parse(lines[0]!), JSON.parse(good), "the complete record is byte-identical");
  });

  it("failures and cancellations produce entries with honest actualSource (D7, R-17)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-ledger-"));
    const ledger = new LedgerFile(join(dir, "ledger.jsonl"));
    // A provider that reports cost: the actual is measured, even for a failure.
    await ledger.append(entry({ outcome: "failed", actualMicroUsd: 40000, actualSource: "provider-reported" }));
    // A provider that does not: the actual is derived, and the entry says so.
    await ledger.append(entry({ outcome: "cancelled", actualMicroUsd: 130000, actualSource: "manifest-derived" }));
    // A local run: zero and labelled unmetered.
    await ledger.append(
      entry({ provider: "ollama", model: "llama3.1-8b", actualMicroUsd: 0, actualSource: "local-zero", estimatedMicroUsd: 0 }),
    );
    const all = await ledger.readAll();
    assert.deepEqual(
      all.map((e) => [e.outcome, e.actualSource]),
      [
        ["failed", "provider-reported"],
        ["cancelled", "manifest-derived"],
        ["succeeded", "local-zero"],
      ],
    );
  });

  it("foreign lines are skipped by the tolerant reader, never fatal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-ledger-"));
    const path = join(dir, "ledger.jsonl");
    await writeFile(path, `${JSON.stringify(entry({}))}\n{"not":"a ledger entry"}\n`, "utf8");
    await appendFile(path, JSON.stringify(entry({ outcome: "failed" })) + "\n", "utf8");
    assert.equal((await new LedgerFile(path).readAll()).length, 2);
  });
});

describe("the rolling spend threshold (R-19, D10, §3.2)", () => {
  it("fires across worlds, not per world, over the rolling period only", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const entries: LedgerEntry[] = [
      entry({ worldId: WORLD_A, ts: "2026-07-30T10:00:00Z", actualMicroUsd: 30_000_000, actualSource: "provider-reported" }),
      entry({ worldId: WORLD_B, ts: "2026-07-31T10:00:00Z", actualMicroUsd: 25_000_000, actualSource: "provider-reported" }),
      // Outside the window — must not count.
      entry({ worldId: WORLD_A, ts: "2026-07-01T10:00:00Z", actualMicroUsd: 500_000_000, actualSource: "provider-reported" }),
    ];
    const status = evaluateSpend(entries, { thresholdMicroUsd: 50_000_000, periodDays: 7 }, now);
    assert.equal(status.rollingMicroUsd, 55_000_000, "both worlds count; the stale entry does not");
    assert.equal(status.alerted, true);

    const perWorldWouldMiss = evaluateSpend(
      entries.filter((e) => e.worldId === WORLD_A),
      { thresholdMicroUsd: 50_000_000, periodDays: 7 },
      now,
    );
    assert.equal(perWorldWouldMiss.alerted, false, "a per-world evaluation would have missed it — hence global");
  });

  it("uses the estimate when no actual was recorded, and a zero threshold disables", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const entries = [entry({ ts: "2026-08-01T10:00:00Z", actualMicroUsd: null, estimatedMicroUsd: 700_000 })];
    assert.equal(evaluateSpend(entries, { thresholdMicroUsd: 500_000, periodDays: 7 }, now).alerted, true);
    assert.equal(evaluateSpend(entries, { thresholdMicroUsd: 0, periodDays: 7 }, now).alerted, false);
  });
});

describe("manifest drift (R-13, §2.11)", () => {
  const manifest: ModelManifest = {
    manifestVersion: 7,
    generated: "2026-07-28",
    models: [
      {
        id: "seedance-2.0",
        provider: "fal",
        capability: "video",
        displayName: "Seedance 2.0",
        accepts: { referenceImages: 4, startFrame: true, endFrame: true },
        limits: {},
        pricing: { kind: "perSecond", microUsdPerSecond: 21667 },
      },
    ],
  };

  it("repeated provider-reported divergence surfaces, naming the model and the size", () => {
    const off = Array.from({ length: 4 }, (_, i) =>
      entry({
        ts: `2026-08-0${i + 1}T10:00:00Z`.replace("08-05", "08-04"),
        estimatedMicroUsd: 100000,
        actualMicroUsd: 130000, // 30% over, every time
        actualSource: "provider-reported",
      }),
    );
    const reports = detectDrift(off, manifest);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.modelId, "seedance-2.0");
    assert.equal(reports[0]!.samples, 4);
    assert.equal(reports[0]!.medianDivergencePerMille, 300);
  });

  it("derived actuals never count — they would only measure our own arithmetic", () => {
    const derived = Array.from({ length: 5 }, () =>
      entry({ estimatedMicroUsd: 100000, actualMicroUsd: 200000, actualSource: "manifest-derived" }),
    );
    assert.equal(detectDrift(derived, manifest).length, 0);
  });

  it("two samples are noise, not drift", () => {
    const twice = Array.from({ length: 2 }, () =>
      entry({ estimatedMicroUsd: 100000, actualMicroUsd: 200000, actualSource: "provider-reported" }),
    );
    assert.equal(detectDrift(twice, manifest).length, 0);
  });
});
