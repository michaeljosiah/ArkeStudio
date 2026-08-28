import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import type { DiagnosticsSnapshot, DiagnosticsSources } from "@arke-studio/contracts";
import { IDLE_UPDATE_STATE } from "@arke-studio/contracts";
import { DiagnosticsSnapshotHolder } from "../../src/diagnostics-snapshot.js";

/**
 * SPEC-032 §1.9: refresh. Changes arriving in one tick coalesce into at most one derivation
 * (R-33, matrix row 38), nothing runs on a timer, and an unchanged snapshot is not re-broadcast.
 */

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
    ledgerUnavailable: false,
    drift: [],
    builds: [],
    update: IDLE_UPDATE_STATE,
    ...over,
  };
}

function holderWith(current: () => DiagnosticsSources) {
  let reads = 0;
  const broadcasts: DiagnosticsSnapshot[] = [];
  const holder = new DiagnosticsSnapshotHolder({
    sources: () => {
      reads += 1;
      return current();
    },
    tails: () => ({ appLog: [] }),
    boundary: { scrub: (text) => text },
    onSnapshot: (snapshot) => broadcasts.push(snapshot),
  });
  return { holder, broadcasts, reads: () => reads };
}

describe("the snapshot holder (R-33, R-34)", () => {
  it("row 38: twelve source changes in one tick are one derivation", async () => {
    const { holder, reads } = holderWith(() => sources());
    for (let i = 0; i < 12; i++) holder.schedule();
    assert.equal(reads(), 0, "nothing derives synchronously on the calling path (R-34)");
    await tick();
    assert.equal(reads(), 1);
    holder.dispose();
  });

  it("an unchanged snapshot that CONTAINS findings is not re-broadcast (live facts carry the derivation instant)", async () => {
    // runtime: null is the common session (§2.2) — it always yields hardware-unmeasured, whose
    // facts are stamped with the derivation instant. A naive equality would re-send it on every
    // tick forever.
    const { holder, broadcasts } = holderWith(() => sources({ runtime: null }));
    holder.schedule();
    await tick();
    assert.equal(broadcasts.length, 1);
    assert.ok(broadcasts[0]!.findings.some((f) => f.kind === "hardware-unmeasured"));
    holder.schedule();
    await tick();
    holder.schedule();
    await tick();
    assert.equal(broadcasts.length, 1, "nothing changed, nothing re-sent");
    holder.dispose();
  });

  it("broadcasts the first derivation, then only what changed", async () => {
    let paused = false;
    const { holder, broadcasts } = holderWith(() =>
      sources({
        queues: paused
          ? [{ provider: "fal", paused: true, pauseKind: "credential", reason: "no credential", held: 1 }]
          : [],
      }),
    );
    holder.schedule();
    await tick();
    assert.equal(broadcasts.length, 1);

    // The same state again: derived, compared, not re-sent.
    holder.schedule();
    await tick();
    assert.equal(broadcasts.length, 1);

    paused = true;
    holder.schedule();
    await tick();
    assert.equal(broadcasts.length, 2);
    assert.ok(broadcasts[1]!.findings.some((f) => f.kind === "queue-paused-credential"));
    holder.dispose();
  });

  it("carries firstSeen across derivations without writing anything (R-35, D2)", async () => {
    let held = 1;
    const { holder, broadcasts } = holderWith(() =>
      sources({
        queues: [{ provider: "fal", paused: true, pauseKind: "credential", reason: "no credential", held }],
      }),
    );
    holder.schedule();
    await tick();
    held = 3; // the held count moves; the condition is the same occurrence
    holder.schedule();
    await tick();
    assert.equal(broadcasts.length, 2);
    const [first, second] = broadcasts;
    const a = first!.findings.find((f) => f.kind === "queue-paused-credential")!;
    const b = second!.findings.find((f) => f.kind === "queue-paused-credential")!;
    assert.equal(b.firstSeen, a.firstSeen);
    holder.dispose();
  });

  it("refresh() broadcasts even an unchanged snapshot — the on-demand asker came for the instant (R-33)", async () => {
    const { holder, broadcasts } = holderWith(() => sources({ runtime: null }));
    holder.schedule();
    await tick();
    assert.equal(broadcasts.length, 1);
    holder.schedule();
    await tick();
    assert.equal(broadcasts.length, 1, "unchanged, unforced: not re-sent");
    holder.refresh();
    await tick();
    assert.equal(broadcasts.length, 2, "unchanged but asked for: sent");
    // And still coalesced: a refresh joining a pending schedule is one derivation.
    holder.refresh();
    holder.schedule();
    holder.refresh();
    await tick();
    assert.equal(broadcasts.length, 3);
    holder.dispose();
  });

  it("currentSnapshot() reads the maintained snapshot rather than re-deriving", async () => {
    const { holder, reads } = holderWith(() => sources());
    holder.schedule();
    await tick();
    assert.equal(reads(), 1);
    holder.currentSnapshot();
    holder.currentSnapshot();
    assert.equal(reads(), 1);
    holder.dispose();
  });

  it("refreshed() resolves with the next derivation — the bundle's freshness gate", async () => {
    let clockCalls = 0;
    const clocks = ["2026-08-28T12:00:00.000Z", "2026-08-28T13:00:00.000Z", "2026-08-28T13:00:00.000Z"];
    const holder = new DiagnosticsSnapshotHolder({
      sources: () => sources({ runtime: null }),
      tails: () => ({ appLog: [] }),
      boundary: { scrub: (text) => text },
      onSnapshot: () => {},
      clock: () => clocks[Math.min(clockCalls++, clocks.length - 1)]!,
    });
    holder.schedule();
    await tick();
    assert.equal(holder.currentSnapshot().derivedAt, "2026-08-28T12:00:00.000Z");
    // An hour of quiet later, the bundle asks: the answer is a fresh instant, not the cache.
    const fresh = await holder.refreshed();
    assert.equal(fresh.derivedAt, "2026-08-28T13:00:00.000Z");
    holder.dispose();
  });

  it("dispose settles a caller awaiting a derivation that will never fire", async () => {
    const { holder } = holderWith(() => sources());
    holder.schedule();
    await tick();
    const pending = holder.refreshed();
    holder.dispose();
    const settled = await pending;
    assert.ok(settled.findings !== undefined, "the awaiting caller gets the last snapshot, not a hang");
  });

  it("dispose cancels a pending derivation and stops broadcasting", async () => {
    const { holder, broadcasts, reads } = holderWith(() => sources());
    holder.schedule();
    holder.dispose();
    await tick();
    assert.equal(reads(), 0);
    assert.equal(broadcasts.length, 0);
  });
});
