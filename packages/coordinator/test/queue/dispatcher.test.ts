import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DomainEvent, Job, LedgerEntry } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import {
  foldJobHistory,
  JobQueue,
  type EnqueueInput,
  type JobQueueOptions,
} from "../../src/queue/dispatcher.js";
import { FakeProvider, jpegBytes, pngBytes, truncatedPngBytes, webpBytes } from "./fake-provider.js";
import { until } from "../wait.js";

/**
 * The exactly-once suite (SPEC-009 §3.2): kills are simulated by disposing the running queue
 * mid-step — after dispose, no further journal writes or events happen, exactly like a dead
 * process — then a fresh queue over the same journal and the same provider-side state runs
 * recovery. Each run asserts: no job lost, no second submission without reconciliation, no
 * duplicate ledger entry, and a resolvable state.
 */

const WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC";

interface Harness {
  queue: JobQueue;
  events: DomainEvent[];
  ledger: {
    entries: LedgerEntry[];
    onAppend: ((e: LedgerEntry) => void) | null;
    /** Set to make both reads reject — the file exists but cannot be read (EACCES, a lock). */
    failReads: Error | null;
    readJobIdsCount: number;
    hasCount: number;
  };
  faults: Array<{ provider: string; message: string }>;
  journalPath: string;
  worldDir: string;
  revive: () => Harness;
}

async function makeHarness(
  clients: Record<string, FakeProvider>,
  opts: {
    getKey?: (p: string) => Promise<string | null>;
    baseConcurrency?: number;
    providerConcurrency?: Readonly<Record<string, number>>;
    landInWorld?: (worldId: string, fn: (worldDir: string) => Promise<void>) => Promise<boolean>;
    onTerminal?: (job: Job) => void | Promise<void>;
    onFinalizationFailure?: JobQueueOptions["onFinalizationFailure"];
    readImageReferences?: JobQueueOptions["readImageReferences"];
    readVoiceReference?: JobQueueOptions["readVoiceReference"];
    admit?: JobQueueOptions["admit"];
    backoffBaseMs?: number;
    backoffCapMs?: number;
    rng?: () => number;
  } = {},
): Promise<Harness> {
  const dir = await tempDir("arke-queue-");
  const worldDir = await tempDir("arke-qworld-");
  return build(join(dir, "jobs.jsonl"), worldDir, clients, opts);
}

function build(
  journalPath: string,
  worldDir: string,
  clients: Record<string, FakeProvider>,
  opts: {
    getKey?: (p: string) => Promise<string | null>;
    baseConcurrency?: number;
    providerConcurrency?: Readonly<Record<string, number>>;
    landInWorld?: (worldId: string, fn: (worldDir: string) => Promise<void>) => Promise<boolean>;
    onTerminal?: (job: Job) => void | Promise<void>;
    onFinalizationFailure?: JobQueueOptions["onFinalizationFailure"];
    readImageReferences?: JobQueueOptions["readImageReferences"];
    readVoiceReference?: JobQueueOptions["readVoiceReference"];
    admit?: JobQueueOptions["admit"];
    backoffBaseMs?: number;
    backoffCapMs?: number;
    rng?: () => number;
  },
): Harness {
  const events: DomainEvent[] = [];
  const ledger: Harness["ledger"] = { entries: [], onAppend: null, failReads: null, readJobIdsCount: 0, hasCount: 0 };
  const faults: Harness["faults"] = [];
  const queue = new JobQueue({
    journalPath,
    clients,
    getKey: opts.getKey ?? (async () => "test-key"),
    emit: (e) => events.push(e),
    ledger: {
      readJobIds: async () => {
        ledger.readJobIdsCount += 1;
        if (ledger.failReads) throw ledger.failReads;
        return new Set(ledger.entries.map((entry) => entry.jobId));
      },
      has: async (jobId) => {
        ledger.hasCount += 1;
        if (ledger.failReads) throw ledger.failReads;
        return ledger.entries.some((e) => e.jobId === jobId);
      },
      append: async (entry) => {
        ledger.onAppend?.(entry);
        ledger.entries.push(entry);
      },
    },
    landInWorld:
      opts.landInWorld ??
      (async (_worldId, fn) => {
        await fn(worldDir);
        return true;
      }),
    onProviderFault: (provider, message) => faults.push({ provider, message }),
    ...(opts.onTerminal ? { onTerminal: opts.onTerminal } : {}),
    ...(opts.onFinalizationFailure ? { onFinalizationFailure: opts.onFinalizationFailure } : {}),
    ...(opts.readImageReferences ? { readImageReferences: opts.readImageReferences } : {}),
    ...(opts.readVoiceReference ? { readVoiceReference: opts.readVoiceReference } : {}),
    ...(opts.admit ? { admit: opts.admit } : {}),
    maxAttempts: 3,
    backoffBaseMs: 5,
    backoffCapMs: 20,
    pollIntervalMs: 5,
    offlineRetryMs: 40,
    baseIntervalMs: 1,
    ...(opts.baseConcurrency !== undefined ? { baseConcurrency: opts.baseConcurrency } : {}),
    ...(opts.providerConcurrency !== undefined ? { providerConcurrency: opts.providerConcurrency } : {}),
    ...(opts.backoffBaseMs !== undefined ? { backoffBaseMs: opts.backoffBaseMs } : {}),
    ...(opts.backoffCapMs !== undefined ? { backoffCapMs: opts.backoffCapMs } : {}),
    ...(opts.rng !== undefined ? { rng: opts.rng } : {}),
  });
  const harness: Harness = {
    queue,
    events,
    ledger,
    faults,
    journalPath,
    worldDir,
    revive: () => {
      const next = build(journalPath, worldDir, clients, opts);
      next.ledger.entries.push(...ledger.entries); // the real ledger file survives a kill
      return next;
    },
  };
  return harness;
}

const INPUT: EnqueueInput = {
  worldId: WORLD,
  productionId: "saltlight",
  target: { kind: "shot", id: "sh_12" },
  capability: "video",
  provider: "fake",
  model: "seedance-2.0",
  params: { durationSec: 6 },
  estimatedMicroUsd: 130000,
};

// 30s everywhere below: the folds are in-process, but a starved shard stalls the event loop
// for seconds at a time — the settle tier from supervisor.test.ts's budget note.
const FOLD_MS = 30_000;

function foldedJob(h: Harness, id: string): Job | undefined {
  return h.queue.listJobs().find((j) => j.id === id);
}

describe("startup reconciliation scaling", () => {
  it("folds 1,000 terminal jobs in one history pass and reads the ledger once", async () => {
    const jobs: Job[] = Array.from({ length: 1_000 }, (_, index) => ({
      ...INPUT,
      id: `jb_${String(index).padStart(26, "0")}`,
      idempotencyKey: String(index + 1_000).padStart(26, "0"),
      status: "succeeded",
      providerJobId: `remote-${index}`,
      attempt: 1,
      error: null,
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:01:00.000Z",
    }));
    const history: Job[] = [];
    for (const job of jobs) {
      history.push(
        { ...job, status: "queued", providerJobId: null, attempt: 0 },
        { ...job, status: "submitting", providerJobId: null, attempt: 1 },
        { ...job, status: "submitting", providerJobId: null, attempt: 1 },
        job,
      );
    }

    let iterations = 0;
    let rowsVisited = 0;
    const singlePassHistory: Iterable<Job> = {
      *[Symbol.iterator]() {
        iterations += 1;
        for (const row of history) {
          rowsVisited += 1;
          yield row;
        }
      },
    };
    const folded = foldJobHistory(singlePassHistory);
    assert.equal(iterations, 1);
    assert.equal(rowsVisited, history.length);
    assert.equal(folded.length, jobs.length);
    assert.ok(folded.every(({ job }) => job.attempt === 2));

    const h = await makeHarness({});
    await writeFile(h.journalPath, history.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    h.ledger.entries.push(
      ...jobs.map((job) => ({
        ts: job.updatedAt,
        worldId: job.worldId,
        productionId: job.productionId!,
        jobId: job.id,
        provider: job.provider,
        model: job.model,
        outcome: "succeeded" as const,
        estimatedMicroUsd: job.estimatedMicroUsd,
        actualMicroUsd: job.estimatedMicroUsd,
        actualSource: "manifest-derived" as const,
      })),
    );

    await h.queue.start();
    assert.equal(h.queue.listJobs().length, jobs.length);
    assert.equal(h.ledger.readJobIdsCount, 1, "startup takes one batch ledger snapshot");
    assert.equal(h.ledger.hasCount, 0, "terminal jobs use the snapshot rather than per-job reads");
    assert.equal(h.ledger.entries.length, jobs.length, "reconciliation does not duplicate entries");
    h.queue.dispose();
  });
});

/**
 * The seam contract: an unreadable ledger rejects rather than answering empty (R-16). Folded
 * into [], the startup snapshot said every job in history was never billed, and the ⑦
 * completion pass appended a second entry for each — permanent duplicates in an append-only
 * file. The queue's fail-safe is to park the ledger-gated work: entries stay missing (the
 * recoverable state ⑦ already handles) rather than doubled, and finalization verdicts wait
 * for a start-up that can actually read the file.
 */
function terminalRow(suffix: string, extra: Partial<Job> = {}): Job {
  return {
    ...INPUT,
    id: `jb_01J8E000000000000000000${suffix}`,
    idempotencyKey: `01J8E100000000000000000${suffix}`,
    status: "succeeded",
    providerJobId: `remote-${suffix}`,
    attempt: 1,
    error: null,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:01:00.000Z",
    ...extra,
  };
}

function entryFor(job: Job): LedgerEntry {
  return {
    ts: job.updatedAt,
    worldId: job.worldId,
    productionId: job.productionId!,
    jobId: job.id,
    provider: job.provider,
    model: job.model,
    outcome: "succeeded",
    estimatedMicroUsd: job.estimatedMicroUsd,
    actualMicroUsd: job.estimatedMicroUsd,
    actualSource: "manifest-derived",
  };
}

describe("an unreadable ledger parks reconciliation instead of answering 'never billed'", () => {
  it("appends no duplicate for a job that was billed, and no completion for one that was not", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    const h = await makeHarness({ fake });
    await h.queue.start();
    h.queue.dispose();
    const billed = terminalRow("DB1");
    const unbilled = terminalRow("DB2");
    await appendFile(h.journalPath, `${JSON.stringify(billed)}\n${JSON.stringify(unbilled)}\n`, "utf8");
    h.ledger.entries.push(entryFor(billed));

    const h2 = h.revive();
    h2.ledger.failReads = new Error("EACCES: permission denied, read");
    const report = await h2.queue.start();
    assert.equal(h2.ledger.entries.length, 1, "nothing appended while billed-or-not is unknowable");
    assert.equal(report.some((a) => a.action === "ledger-completed"), false);
    assert.equal(fake.submitCount, 0, "parking the ledger never re-dispatches terminal work");
    h2.queue.dispose();

    // The restart that can read the file completes exactly the one genuinely missing entry.
    const h3 = h2.revive();
    const recovered = await h3.queue.start();
    assert.deepEqual(
      recovered.filter((a) => a.action === "ledger-completed").map((a) => a.jobId),
      [unbilled.id],
    );
    assert.equal(h3.ledger.entries.length, 2);
    assert.equal(h3.ledger.entries.filter((e) => e.jobId === billed.id).length, 1, "still exactly one (R-16)");
    h3.queue.dispose();
  });

  it("a live terminalization skips the append rather than risking a duplicate, and ⑦ completes it later", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    const h = await makeHarness({ fake });
    await h.queue.start();
    h.ledger.failReads = new Error("EACCES: permission denied, read");
    const job = await h.queue.enqueue(INPUT);
    await until(
      () => h.events.some((e) => e.type === "job.ready" && e.job.id === job.id),
      "the job to reach ready with the ledger unreadable",
    );
    assert.equal(foldedJob(h, job.id)?.status, "succeeded", "the job itself is unaffected");
    assert.equal(h.ledger.entries.length, 0, "presence unknowable → no append");
    h.queue.dispose();

    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((a) => a.jobId === job.id)?.action, "ledger-completed");
    assert.equal(h2.ledger.entries.length, 1);
    assert.equal(fake.submitCount, 1, "recovery never resubmitted");
    h2.queue.dispose();
  });

  it("a live follow-on fails its finalization honestly rather than running ahead of the spend record", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.artifacts = [{ name: "frame.png", contentType: "image/png", data: pngBytes() }];
    let finalizations = 0;
    const h = await makeHarness({ fake }, { onTerminal: () => void (finalizations += 1) });
    await h.queue.start();
    h.ledger.failReads = new Error("EACCES: permission denied, read");
    const job = await h.queue.enqueue({
      ...INPUT,
      capability: "image",
      target: { kind: "character-sheet", id: "maren-kest/recover" },
      landing: { dir: "references/maren-kest/incoming" },
    });
    await until(
      () => foldedJob(h, job.id)?.finalization?.status === "failed",
      "the finalization to fail rather than run ahead of the spend record",
    );
    assert.equal(foldedJob(h, job.id)?.status, "succeeded");
    assert.equal(finalizations, 0, "no follow-on ran ahead of an unconfirmed entry");
    assert.equal(h.ledger.entries.length, 0);
    h.queue.dispose();

    // The readable restart completes the missing entry; the failed finalization keeps its
    // user-facing retry rather than replaying by itself.
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((a) => a.jobId === job.id)?.action, "ledger-completed");
    assert.equal(h2.ledger.entries.length, 1);
    assert.equal(foldedJob(h2, job.id)?.finalization?.status, "failed");
    await h2.queue.retryFinalization(job.id);
    assert.equal(finalizations, 1, "the explicit retry now runs, with the entry in place");
    assert.equal(h2.ledger.entries.length, 1, "and appends nothing further");
    h2.queue.dispose();
  });

  it("neither replays nor fails a pending finalization on a guess; the readable restart decides", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    let finalizations = 0;
    const h = await makeHarness({ fake }, { onTerminal: () => void (finalizations += 1) });
    await h.queue.start();
    h.queue.dispose();
    const terminal = terminalRow("DF1", {
      target: { kind: "voice-preview", id: "maren-kest/elevenlabs/v1" },
      landedFiles: [".cache/voice-previews/lf1.mp3"],
      finalization: { status: "pending", error: null, updatedAt: "2026-08-04T12:01:00.000Z" },
    });
    await appendFile(h.journalPath, `${JSON.stringify(terminal)}\n`, "utf8");
    h.ledger.entries.push(entryFor(terminal));

    const h2 = h.revive();
    h2.ledger.failReads = new Error("EACCES: permission denied, read");
    await h2.queue.start();
    assert.equal(foldedJob(h2, terminal.id)?.finalization?.status, "pending", "no verdict on a guess");
    assert.equal(finalizations, 0);
    assert.equal(h2.ledger.entries.length, 1, "and no duplicate entry either");
    h2.queue.dispose();

    const h3 = h2.revive();
    await h3.queue.start();
    assert.equal(foldedJob(h3, terminal.id)?.finalization?.status, "complete", "the readable restart replays it");
    assert.equal(finalizations, 1);
    assert.equal(h3.ledger.entries.length, 1);
    h3.queue.dispose();
  });

  it("a world open does not replay what the park withheld — only a readable start-up releases it", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    let finalizations = 0;
    const h = await makeHarness({ fake }, { onTerminal: () => void (finalizations += 1) });
    await h.queue.start();
    h.queue.dispose();
    const terminal = terminalRow("DW1", {
      target: { kind: "voice-preview", id: "maren-kest/elevenlabs/v2" },
      landedFiles: [".cache/voice-previews/dw1.mp3"],
      finalization: { status: "pending", error: null, updatedAt: "2026-08-04T12:01:00.000Z" },
    });
    await appendFile(h.journalPath, `${JSON.stringify(terminal)}\n`, "utf8");
    h.ledger.entries.push(entryFor(terminal));

    const h2 = h.revive();
    h2.ledger.failReads = new Error("EACCES: permission denied, read");
    await h2.queue.start();
    // The world open that used to walk straight past the park (Codex round 1).
    await h2.queue.retryFinalizationsForWorld(INPUT.worldId);
    assert.equal(finalizations, 0, "the follow-on did not run ahead of a spend record nobody could confirm");
    assert.equal(foldedJob(h2, terminal.id)?.finalization?.status, "pending");

    // Readable again, without a restart: the same world open now releases it.
    h2.ledger.failReads = null;
    await h2.queue.retryFinalizationsForWorld(INPUT.worldId);
    assert.equal(finalizations, 1);
    assert.equal(foldedJob(h2, terminal.id)?.finalization?.status, "complete");
    assert.equal(h2.ledger.entries.length, 1);
    h2.queue.dispose();
  });

  it("still fails a non-replayable pending follow-on, whose verdict never needed the ledger", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    let finalizations = 0;
    const h = await makeHarness({ fake }, { onTerminal: () => void (finalizations += 1) });
    await h.queue.start();
    h.queue.dispose();
    // A shot: a follow-on target outside the replayable set, so start-up's verdict is "fail"
    // whether or not the entry landed. Parking it left an undeletable "preparing result" row.
    const terminal = terminalRow("DN1", {
      target: { kind: "shot", id: "sh_14" },
      landedFiles: ["incoming/DN1.mp4"],
      finalization: { status: "pending", error: null, updatedAt: "2026-08-04T12:01:00.000Z" },
    });
    await appendFile(h.journalPath, `${JSON.stringify(terminal)}\n`, "utf8");
    h.ledger.entries.push(entryFor(terminal));

    const h2 = h.revive();
    h2.ledger.failReads = new Error("EACCES: permission denied, read");
    await h2.queue.start();
    assert.equal(
      foldedJob(h2, terminal.id)?.finalization?.status,
      "failed",
      "the ledger-free verdict still runs, so the row settles instead of stranding",
    );
    assert.equal(finalizations, 0, "failing it replays nothing");
    assert.equal(h2.ledger.entries.length, 1, "and appends nothing on a guess");
    h2.queue.dispose();
  });

  it("does not fail a finalization whose entry it just appended, when the next read is locked out", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.artifacts = [{ name: "frame.png", contentType: "image/png", data: pngBytes() }];
    let finalizations = 0;
    const h = await makeHarness({ fake }, { onTerminal: () => void (finalizations += 1) });
    await h.queue.start();
    // The scanner opens the file in the window between the append landing and the check —
    // asking again could only be wrong, and its wrong answer used to settle the row as failed.
    h.ledger.onAppend = () => {
      h.ledger.failReads = new Error("EBUSY: resource busy or locked");
    };
    const job = await h.queue.enqueue({
      ...INPUT,
      capability: "image",
      target: { kind: "character-sheet", id: "maren-kest/window" },
      landing: { dir: "references/maren-kest/incoming" },
    });
    await until(
      () => foldedJob(h, job.id)?.finalization?.status === "complete",
      "the finalization to complete on the append the check could not re-read",
    );
    assert.equal(finalizations, 1, "the follow-on ran: its spend record had durably landed");
    assert.equal(h.ledger.entries.length, 1);
    h.queue.dispose();
  });

  it("recovers the exact charged provider-fault amount after the terminal-row ledger window", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true, reportsCost: true });
    fake.pollState = "failed";
    fake.pollFailureMessage = "HTTP 402 quota exhausted";
    fake.costMicroUsd = 7654;
    const h = await makeHarness({ fake });
    h.ledger.onAppend = () => {
      h.queue.dispose();
      throw new Error("killed before ledger append");
    };
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "failed", "the charged terminal row to persist", FOLD_MS);
    await h.queue.drain();
    assert.equal(foldedJob(h, job.id)?.providerCostMicroUsd, 7654);
    assert.equal(h.ledger.entries.length, 0);

    h.ledger.onAppend = null;
    const recovered = h.revive();
    const report = await recovered.queue.start();
    assert.equal(report.find((entry) => entry.jobId === job.id)?.action, "ledger-completed");
    assert.equal(recovered.ledger.entries.length, 1);
    assert.equal(recovered.ledger.entries[0]!.actualMicroUsd, 7654);
    assert.equal(recovered.ledger.entries[0]!.actualSource, "provider-reported");
    recovered.queue.dispose();
  });
});

describe("the happy path writes exactly one ledger entry and lands artifacts atomically", () => {
  it("queued → submitting → running → succeeded, with landing", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.artifacts = [{ name: "frame.png", contentType: "image/png", data: pngBytes() }];
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue({ ...INPUT, landing: { dir: "productions/saltlight/takes/tk_x" } });
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    assert.equal(fake.submitCount, 1);
    assert.deepEqual(foldedJob(h, job.id)?.landedFiles, ["productions/saltlight/takes/tk_x/frame.png"]);
    const landed = await readFile(join(h.worldDir, "productions/saltlight/takes/tk_x/frame.png"));
    assert.equal(landed.length, pngBytes().length);
    assert.equal(h.ledger.entries.length, 1);
    assert.equal(h.ledger.entries[0]!.actualSource, "manifest-derived", "no cost reported → derived (R-17)");
    assert.equal(h.ledger.entries[0]!.actualMicroUsd, INPUT.estimatedMicroUsd);
    assert.ok(h.ledger.entries[0]!.actualMicroUsd! > 0);
    assert.ok(h.ledger.hasCount > 0, "live terminalization still checks the current ledger");
    h.queue.dispose();
  });
});

describe("enqueue admission during shutdown", () => {
  for (const close of ["stop accepting", "dispose"] as const) {
    it(`refuses work whose admission finishes after ${close}, without returning an unjournalled id`, async () => {
      let entered!: () => void;
      const admissionEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const admissionPaused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = await makeHarness(
        {},
        {
          admit: async () => {
            entered();
            await admissionPaused;
            return { ok: true };
          },
        },
      );
      await h.queue.start();

      const enqueuing = h.queue.enqueue(INPUT);
      await admissionEntered;
      if (close === "dispose") h.queue.dispose();
      else h.queue.stopAccepting();
      release();

      await assert.rejects(enqueuing, /not accepting new work/);
      await h.queue.drain();
      assert.equal(await readFile(h.journalPath, "utf8").catch(() => ""), "");
      assert.deepEqual(h.queue.listJobs(), []);
      h.queue.dispose();
    });
  }
});

describe("ephemeral provider image references", () => {
  it("resolves bytes before submit, never journals them, and lands synchronous output without polling", async () => {
    const fake = new FakeProvider({});
    fake.inlineArtifacts = [{ name: "image.png", contentType: "image/png", data: pngBytes() }];
    const secret = Uint8Array.from([9, 8, 7, 6]);
    let resolutions = 0;
    const h = await makeHarness(
      { fake },
      {
        readImageReferences: async (_worldId, paths) => {
          resolutions += 1;
          assert.deepEqual(paths, ["references/maren-kest/main.png"]);
          return [{ name: "reference-01.png", contentType: "image/png", data: secret }];
        },
      },
    );
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      capability: "image",
      target: { kind: "character-sheet", id: "maren-kest/refs" },
      params: { prompt: "preserve identity", references: ["references/maren-kest/main.png"] },
      landing: { dir: "references/maren-kest/incoming", name: "sheet.png" },
    });
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    assert.equal(resolutions, 1);
    assert.equal(fake.submitCount, 1);
    assert.equal(fake.pollCount, 0, "synchronous image output lands directly");
    assert.deepEqual(fake.submittedReferenceBytes, [secret]);
    const journal = await readFile(h.journalPath, "utf8");
    assert.ok(journal.includes("references/maren-kest/main.png"));
    assert.ok(!journal.includes("data:image"));
    assert.ok(!journal.includes(Buffer.from(secret).toString("base64")));
    h.queue.dispose();
  });

  it("fails unsafe reference preparation before attempt or provider I/O", async () => {
    const fake = new FakeProvider({});
    const h = await makeHarness(
      { fake },
      {
        readImageReferences: async () => {
          throw new Error("image reference path is invalid");
        },
      },
    );
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      capability: "image",
      params: { references: ["../outside.png"] },
    });
    await until(() => foldedJob(h, job.id)?.status === "failed", "the job to fold to failed", FOLD_MS);
    assert.equal(fake.submitCount, 0);
    assert.equal(foldedJob(h, job.id)?.attempt, 0);
    assert.match(foldedJob(h, job.id)?.error ?? "", /invalid/);
    h.queue.dispose();
  });

  it("refuses incomplete reference preparation before attempt or provider I/O", async () => {
    const fake = new FakeProvider({});
    const h = await makeHarness({ fake }, { readImageReferences: async () => [] });
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      capability: "image",
      params: { references: ["references/maren-kest/main.png"] },
    });
    await until(() => foldedJob(h, job.id)?.status === "failed", "the job to fold to failed", FOLD_MS);
    assert.equal(fake.submitCount, 0);
    assert.equal(foldedJob(h, job.id)?.attempt, 0);
    assert.match(foldedJob(h, job.id)?.error ?? "", /not every image reference/);
    h.queue.dispose();
  });
});

describe("ephemeral provider voice references", () => {
  it("refuses a remote upload without destination-specific confirmation before journalling", async () => {
    const fake = new FakeProvider({});
    const h = await makeHarness(
      { fake },
      {
        readVoiceReference: async () => {
          throw new Error("must not read the clip");
        },
      },
    );
    await h.queue.start();
    await assert.rejects(
      h.queue.enqueue({
        ...INPUT,
        provider: "comfyui",
        model: "comfyui-cloned-voice",
        capability: "voice-tts",
        params: { voiceId: "harbour", text: "A line." },
        voiceReference: true,
        engine: { source: "user-url", instanceId: "remote-1", locality: "remote" },
      }),
      /explicit confirmation.*destination/,
    );
    assert.equal(fake.submitCount, 0);
    assert.equal((await readFile(h.journalPath, "utf8").catch(() => "")).includes("harbour"), false);
    h.queue.dispose();
  });

  it("accepts confirmation only for the exact remote engine instance", async () => {
    const fake = new FakeProvider({});
    fake.inlineArtifacts = [
      {
        name: "speech.wav",
        contentType: "audio/wav",
        data: Uint8Array.from([
          0x52, 0x49, 0x46, 0x46, 38, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1,
          0, 1, 0, 0x44, 0xac, 0, 0, 0x88, 0x58, 1, 0, 2, 0, 16, 0, 0x64, 0x61, 0x74, 0x61, 2, 0, 0, 0, 0, 0,
        ]),
      },
    ];
    const h = await makeHarness(
      { comfyui: fake },
      {
        readVoiceReference: async () => ({
          name: `${"a".repeat(64)}.wav`,
          contentType: "audio/wav",
          data: Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4]),
        }),
      },
    );
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      provider: "comfyui",
      model: "comfyui-cloned-voice",
      capability: "voice-tts",
      params: { voiceId: "harbour", text: "A line." },
      voiceReference: true,
      engine: { source: "user-url", instanceId: "remote-1", locality: "remote" },
      voiceUploadConfirmedFor: "remote-1",
      landing: { dir: "productions/saltlight/audio" },
    });
    await until(
      () => {
        const current = foldedJob(h, job.id);
        return current?.status === "succeeded" || current?.status === "failed";
      },
      "the job to fold to a terminal status",
      FOLD_MS,
    );
    assert.equal(foldedJob(h, job.id)?.status, "succeeded", foldedJob(h, job.id)?.error ?? undefined);
    assert.equal(foldedJob(h, job.id)?.voiceUploadConfirmedFor, "remote-1");
    assert.equal(fake.submitCount, 1);
    h.queue.dispose();
  });

  it("resolves clip bytes before submit while journalling only the voice id and marker", async () => {
    const fake = new FakeProvider({});
    fake.inlineArtifacts = [
      {
        name: "speech.mp3",
        contentType: "audio/mpeg",
        data: Uint8Array.from([0xff, 0xfb, 0x90, 0, ...Array.from({ length: 413 }, () => 0)]),
      },
    ];
    const secret = Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4]);
    const h = await makeHarness(
      { fake },
      {
        readVoiceReference: async (_worldId, provider, model, voiceId) => {
          assert.equal(provider, "fake");
          assert.equal(model, "seedance-2.0");
          assert.equal(voiceId, "harbour-glass");
          return { name: `${"a".repeat(64)}.wav`, contentType: "audio/wav", data: secret };
        },
      },
    );
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      capability: "voice-tts",
      target: { kind: "bench-take", id: "sess/take" },
      params: { text: "The tide turns.", voiceId: "harbour-glass", audioFormat: "flac" },
      voiceReference: true,
      landing: { dir: ".sessions/sess/media/take" },
    });
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    assert.deepEqual(fake.submittedVoiceReference?.data, secret);
    const journal = await readFile(h.journalPath, "utf8");
    assert.match(journal, /harbour-glass/);
    assert.match(journal, /"voiceReference":true/);
    assert.equal(journal.includes(Buffer.from(secret).toString("base64")), false);
    assert.equal(/[A-Z]:\\|\/Users\//.test(journal), false);
    h.queue.dispose();
  });

  it("lands synchronous paid audio without journalling a synthetic running state", async () => {
    const elevenlabs = new FakeProvider({});
    elevenlabs.inlineArtifacts = [
      {
        name: "speech.mp3",
        contentType: "audio/mpeg",
        data: Uint8Array.from([0xff, 0xfb, 0x90, 0, ...Array.from({ length: 413 }, () => 0)]),
      },
    ];
    const h = await makeHarness({ elevenlabs });
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      capability: "voice-tts",
      target: { kind: "voice-line", id: "sh_12" },
      params: { voiceId: "v1", text: "The harbour remembers." },
      landing: { dir: "productions/saltlight/audio" },
    });
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    const journal = await readFile(h.journalPath, "utf8");
    assert.doesNotMatch(journal, /"status":"running"/);
    assert.equal(elevenlabs.pollCount, 0);
    assert.ok(await readFile(join(h.worldDir, foldedJob(h, job.id)!.landedFiles![0]!)));
    h.queue.dispose();
  });

  it("a crash after inline audio lands recovers the terminal ledger without provider activity", async () => {
    const elevenlabs = new FakeProvider({});
    elevenlabs.inlineArtifacts = [
      {
        name: "speech.mp3",
        contentType: "audio/mpeg",
        data: Uint8Array.from([0xff, 0xfb, 0x90, 0, ...Array.from({ length: 413 }, () => 0)]),
      },
    ];
    const h = await makeHarness({ elevenlabs });
    await h.queue.start();
    h.ledger.onAppend = () => {
      throw new Error("killed before ledger");
    };
    const job = await h.queue.enqueue({
      ...INPUT,
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      capability: "voice-tts",
      target: { kind: "voice-line", id: "sh_12" },
      params: { voiceId: "v1", text: "The harbour remembers." },
      landing: { dir: "productions/saltlight/audio" },
    });
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    h.queue.dispose();
    await h.queue.drain();
    assert.equal(h.ledger.entries.length, 0);
    assert.equal(elevenlabs.submitCount, 1);

    h.ledger.onAppend = null;
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((entry) => entry.jobId === job.id)?.action, "ledger-completed");
    assert.equal(elevenlabs.submitCount, 1);
    assert.equal(elevenlabs.pollCount, 0);
    assert.equal(h2.ledger.entries.length, 1);
    assert.ok(await readFile(join(h.worldDir, foldedJob(h2, job.id)!.landedFiles![0]!)));
    h2.queue.dispose();
  });

  it("recovers spooled inline audio after a crash while its world was unavailable", async () => {
    const elevenlabs = new FakeProvider({});
    elevenlabs.inlineArtifacts = [
      {
        name: "speech.mp3",
        contentType: "audio/mpeg",
        data: Uint8Array.from([0xff, 0xfb, 0x90, 0, ...Array.from({ length: 413 }, () => 0)]),
      },
    ];
    const h = await makeHarness({ elevenlabs }, { landInWorld: async () => false });
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      capability: "voice-tts",
      target: { kind: "voice-line", id: "sh_12" },
      params: { voiceId: "v1", text: "The harbour remembers." },
      landing: { dir: "productions/saltlight/audio" },
    });
    await until(
      () => foldedJob(h, job.id)?.error?.includes("waiting for the owning world") === true,
      "the job to record the world-lease wait",
      FOLD_MS,
    );
    assert.equal(elevenlabs.submitCount, 1);
    h.queue.dispose();
    await h.queue.drain();

    const h2 = build(h.journalPath, h.worldDir, { elevenlabs }, {});
    const report = await h2.queue.start();
    assert.equal(report.find((entry) => entry.jobId === job.id)?.detail, "resumed durable inline artifacts");
    await until(() => foldedJob(h2, job.id)?.status === "succeeded", "the rebuilt queue to fold the job to succeeded", FOLD_MS);
    assert.equal(elevenlabs.submitCount, 1, "the paid request was not repeated");
    assert.equal(elevenlabs.pollCount, 0, "a synthetic id was never polled");
    assert.ok(await readFile(join(h2.worldDir, foldedJob(h2, job.id)!.landedFiles![0]!)));
    h2.queue.dispose();
  });

  it("fails an unsafe clip read before a provider attempt", async () => {
    const fake = new FakeProvider({});
    const h = await makeHarness(
      { fake },
      {
        readVoiceReference: async () => {
          throw new Error("voice recording escapes the world");
        },
      },
    );
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      capability: "voice-tts",
      params: { text: "x", voiceId: "unsafe", audioFormat: "flac" },
      voiceReference: true,
    });
    await until(() => foldedJob(h, job.id)?.status === "failed", "the job to fold to failed", FOLD_MS);
    assert.equal(fake.submitCount, 0);
    assert.equal(foldedJob(h, job.id)?.attempt, 0);
    h.queue.dispose();
  });

  it("refuses an absolute speaker path before it can enter the journal", async () => {
    const fake = new FakeProvider({});
    const h = await makeHarness({ fake });
    await h.queue.start();
    await assert.rejects(
      h.queue.enqueue({
        ...INPUT,
        capability: "voice-tts",
        params: { text: "x", voiceId: "unsafe", speakerFile: String.raw`C:\worlds\voice.wav` },
      }),
      /cannot be stored in jobs/,
    );
    assert.equal(await readFile(h.journalPath, "utf8").catch(() => ""), "");
    h.queue.dispose();
  });
});

describe("reference finalization after provider success", () => {
  it("retries a failed finalizer without provider or ledger activity", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.artifacts = [{ name: "sheet.png", contentType: "image/png", data: pngBytes() }];
    let finalizations = 0;
    let fail = true;
    const h = await makeHarness(
      { fake },
      {
        onTerminal: () => {
          finalizations += 1;
          if (fail) throw new Error("disk busy");
        },
      },
    );
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      capability: "image",
      target: { kind: "character-sheet", id: "maren-kest/finalize" },
      landing: { dir: "references/maren-kest/incoming", name: "sheet.png" },
    });
    await until(() => foldedJob(h, job.id)?.finalization?.status === "failed", "the finalization to fold to failed", FOLD_MS);
    assert.equal(
      h.events.some((event) => event.type === "job.ready"),
      false,
    );
    assert.equal(fake.submitCount, 1);
    assert.equal(h.ledger.entries.length, 1);
    assert.match(
      foldedJob(h, job.id)?.finalization?.error ?? "",
      /will not contact the provider or charge again/,
    );

    fail = false;
    await Promise.all([h.queue.retryFinalization(job.id), h.queue.retryFinalization(job.id)]);
    assert.equal(foldedJob(h, job.id)?.finalization?.status, "complete");
    const completedIndex = h.events.findIndex(
      (event) => event.type === "job.updated" && event.job.finalization?.status === "complete",
    );
    const readyIndex = h.events.findIndex((event) => event.type === "job.ready");
    assert.ok(completedIndex >= 0 && readyIndex > completedIndex, "ready follows durable completion");
    assert.equal(finalizations, 2, "one live attempt and one single-flight retry");
    assert.equal(fake.submitCount, 1);
    assert.equal(h.ledger.entries.length, 1);

    h.queue.dispose();
    const h2 = h.revive();
    await h2.queue.start();
    assert.equal(finalizations, 2, "completed finalization is not replayed on restart");
    assert.equal(fake.submitCount, 1);
    h2.queue.dispose();
  });

  it("does not replay a failed finalization on restart or world open", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.artifacts = [{ name: "sheet.png", contentType: "image/png", data: pngBytes() }];
    let finalizations = 0;
    const h = await makeHarness(
      { fake },
      {
        onTerminal: () => {
          finalizations += 1;
          // A permanent cause — the dispatch predates the provenance the take is built from.
          throw new Error("reference take finalization produced no take");
        },
      },
    );
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      capability: "image",
      target: { kind: "character-sheet", id: "maren-kest/permanent" },
      landing: { dir: "references/maren-kest/incoming", name: "sheet.png" },
    });
    await until(() => foldedJob(h, job.id)?.finalization?.status === "failed", "the finalization to fold to failed", FOLD_MS);
    assert.equal(finalizations, 1);

    // A cause that cannot resolve itself must not re-run every time the world opens…
    await h.queue.retryFinalizationsForWorld(job.worldId);
    assert.equal(finalizations, 1, "world open does not replay a failed finalization");

    // …nor on every launch, which is what filled the app log with one line per job per start.
    h.queue.dispose();
    const h2 = h.revive();
    await h2.queue.start();
    assert.equal(finalizations, 1, "restart does not replay a failed finalization");
    assert.equal(fake.submitCount, 1);
    assert.equal(h2.ledger.entries.length, 1);

    // The user's own retry is still honoured — the row keeps its action.
    await h2.queue.retryFinalization(job.id);
    assert.equal(finalizations, 2, "an explicit retry still runs");
    h2.queue.dispose();
  });

  it("repairs a legacy succeeded reference job on startup without provider activity", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    let finalizations = 0;
    const h = await makeHarness({ fake }, { onTerminal: () => void (finalizations += 1) });
    await h.queue.start();
    h.queue.dispose();
    const terminal: Job = {
      ...INPUT,
      id: "jb_01J8E000000000000000000R77",
      idempotencyKey: "01J8E100000000000000000R77",
      status: "succeeded",
      providerJobId: "remote-r77",
      attempt: 1,
      target: { kind: "character-sheet", id: "maren-kest/recover" },
      landedFiles: ["references/maren-kest/incoming/recover.png"],
      error: null,
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:01:00.000Z",
    };
    await appendFile(h.journalPath, `${JSON.stringify(terminal)}\n`, "utf8");
    h.ledger.entries.push({
      ts: terminal.updatedAt,
      worldId: terminal.worldId,
      productionId: terminal.productionId!,
      jobId: terminal.id,
      provider: terminal.provider,
      model: terminal.model,
      outcome: "succeeded",
      estimatedMicroUsd: terminal.estimatedMicroUsd,
      actualMicroUsd: terminal.estimatedMicroUsd,
      actualSource: "manifest-derived",
    });
    const h2 = h.revive();
    await h2.queue.start();
    assert.equal(foldedJob(h2, terminal.id)?.finalization?.status, "complete");
    assert.equal(finalizations, 1);
    assert.equal(fake.submitCount, 0);
    assert.equal(h2.ledger.entries.length, 1);
    h2.queue.dispose();
  });

  it("does not replay legacy production or reference-tile follow-ons without a finalization marker", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    let finalizations = 0;
    const h = await makeHarness({ fake }, { onTerminal: () => void (finalizations += 1) });
    await h.queue.start();
    h.queue.dispose();
    for (const [suffix, target] of [
      ["S77", { kind: "shot", id: "sh_14" }],
      ["T77", { kind: "reference-tile", id: "maren-kest/head-front" }],
    ] as const) {
      const terminal: Job = {
        ...INPUT,
        id: `jb_01J8E000000000000000000${suffix}`,
        idempotencyKey: `01J8E100000000000000000${suffix}`,
        status: "succeeded",
        providerJobId: `remote-${suffix}`,
        attempt: 1,
        target,
        landedFiles: [`incoming/${suffix}.png`],
        error: null,
        createdAt: "2026-08-04T12:00:00.000Z",
        updatedAt: "2026-08-04T12:01:00.000Z",
      };
      await appendFile(h.journalPath, `${JSON.stringify(terminal)}\n`, "utf8");
      h.ledger.entries.push({
        ts: terminal.updatedAt,
        worldId: terminal.worldId,
        productionId: terminal.productionId!,
        jobId: terminal.id,
        provider: terminal.provider,
        model: terminal.model,
        outcome: "succeeded",
        estimatedMicroUsd: terminal.estimatedMicroUsd,
        actualMicroUsd: terminal.estimatedMicroUsd,
        actualSource: "manifest-derived",
      });
    }
    const h2 = h.revive();
    await h2.queue.start();
    await h2.queue.retryFinalizationsForWorld(INPUT.worldId);
    assert.equal(finalizations, 0);
    assert.equal(fake.submitCount, 0);
    h2.queue.dispose();
  });

  it("surfaces interrupted non-reference follow-ons without replaying them", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    let finalizations = 0;
    const h = await makeHarness({ fake }, { onTerminal: () => void (finalizations += 1) });
    await h.queue.start();
    h.queue.dispose();
    const terminal: Job = {
      ...INPUT,
      id: "jb_01J8E000000000000000000S88",
      idempotencyKey: "01J8E100000000000000000S88",
      status: "succeeded",
      providerJobId: "remote-s88",
      attempt: 1,
      target: { kind: "shot", id: "sh_14" },
      landedFiles: ["incoming/S88.mp4"],
      finalization: { status: "pending", error: null, updatedAt: "2026-08-04T12:01:00.000Z" },
      error: null,
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:01:00.000Z",
    };
    await appendFile(h.journalPath, `${JSON.stringify(terminal)}\n`, "utf8");
    h.ledger.entries.push({
      ts: terminal.updatedAt,
      worldId: terminal.worldId,
      productionId: terminal.productionId!,
      jobId: terminal.id,
      provider: terminal.provider,
      model: terminal.model,
      outcome: "succeeded",
      estimatedMicroUsd: terminal.estimatedMicroUsd,
      actualMicroUsd: terminal.estimatedMicroUsd,
      actualSource: "manifest-derived",
    });
    const h2 = h.revive();
    await h2.queue.start();
    assert.equal(foldedJob(h2, terminal.id)?.finalization?.status, "failed");
    assert.equal(finalizations, 0);
    assert.equal(fake.submitCount, 0);
    h2.queue.dispose();
  });

  it("replays a landed voice preview finalization safely", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    let finalizations = 0;
    const h = await makeHarness({ fake }, { onTerminal: () => void (finalizations += 1) });
    await h.queue.start();
    h.queue.dispose();
    const terminal: Job = {
      ...INPUT,
      id: "jb_01J8E000000000000000000V77",
      idempotencyKey: "01J8E100000000000000000V77",
      status: "succeeded",
      providerJobId: "remote-v77",
      attempt: 1,
      target: { kind: "voice-preview", id: "maren-kest/elevenlabs/v1" },
      landedFiles: [".cache/voice-previews/v77.mp3"],
      finalization: { status: "pending", error: null, updatedAt: "2026-08-04T12:01:00.000Z" },
      error: null,
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:01:00.000Z",
    };
    await appendFile(h.journalPath, `${JSON.stringify(terminal)}\n`, "utf8");
    h.ledger.entries.push({
      ts: terminal.updatedAt,
      worldId: terminal.worldId,
      productionId: terminal.productionId!,
      jobId: terminal.id,
      provider: terminal.provider,
      model: terminal.model,
      outcome: "succeeded",
      estimatedMicroUsd: terminal.estimatedMicroUsd,
      actualMicroUsd: terminal.estimatedMicroUsd,
      actualSource: "manifest-derived",
    });
    const h2 = h.revive();
    await h2.queue.start();
    assert.equal(foldedJob(h2, terminal.id)?.finalization?.status, "complete");
    assert.equal(finalizations, 1);
    h2.queue.dispose();
  });

  it("replays an interrupted voice-line finalization without provider or ledger activity", async () => {
    const fake = new FakeProvider({});
    let finalizations = 0;
    let fail = false;
    const failed: Job[] = [];
    const h = await makeHarness(
      { fake },
      {
        onTerminal: () => {
          finalizations += 1;
          if (fail) throw new Error("disk busy");
        },
        onFinalizationFailure: (job) => failed.push(job),
      },
    );
    await h.queue.start();
    h.queue.dispose();
    const terminal: Job = {
      ...INPUT,
      id: "jb_01J8E000000000000000000A77",
      idempotencyKey: "01J8E100000000000000000A77",
      status: "succeeded",
      providerJobId: "elevenlabs-a77",
      attempt: 1,
      capability: "voice-tts",
      target: { kind: "voice-line", id: "sh_12" },
      landedFiles: ["productions/saltlight/audio/A77.mp3"],
      finalization: { status: "pending", error: null, updatedAt: "2026-08-04T12:01:00.000Z" },
      error: null,
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:01:00.000Z",
    };
    await appendFile(h.journalPath, `${JSON.stringify(terminal)}\n`, "utf8");
    h.ledger.entries.push({
      ts: terminal.updatedAt,
      worldId: terminal.worldId,
      productionId: terminal.productionId!,
      jobId: terminal.id,
      provider: terminal.provider,
      model: terminal.model,
      outcome: "succeeded",
      estimatedMicroUsd: terminal.estimatedMicroUsd,
      actualMicroUsd: terminal.estimatedMicroUsd,
      actualSource: "manifest-derived",
    });
    const h2 = h.revive();
    await h2.queue.start();
    assert.equal(foldedJob(h2, terminal.id)?.finalization?.status, "complete");
    assert.equal(finalizations, 1);
    assert.equal(fake.submitCount, 0);
    assert.equal(h2.ledger.entries.length, 1);

    fail = true;
    await h2.queue.retryFinalization(terminal.id);
    assert.equal(foldedJob(h2, terminal.id)?.finalization?.status, "failed");
    assert.match(foldedJob(h2, terminal.id)?.finalization?.error ?? "", /Retry finalization/);
    assert.equal(failed.at(-1)?.target.kind, "voice-line");
    fail = false;
    await h2.queue.retryFinalization(terminal.id);
    assert.equal(foldedJob(h2, terminal.id)?.finalization?.status, "complete");
    assert.equal(fake.submitCount, 0);
    assert.equal(h2.ledger.entries.length, 1);
    h2.queue.dispose();
  });

  it("a failed voice-line finalization survives restart for an explicit no-charge retry", async () => {
    const fake = new FakeProvider({});
    let fail = true;
    let finalizations = 0;
    const h = await makeHarness(
      { fake },
      {
        onTerminal: () => {
          finalizations += 1;
          if (fail) throw new Error("disk busy");
        },
      },
    );
    await h.queue.start();
    h.queue.dispose();
    const terminal: Job = {
      ...INPUT,
      id: "jb_01J8E000000000000000000A78",
      idempotencyKey: "01J8E100000000000000000A78",
      status: "succeeded",
      providerJobId: "elevenlabs-a78",
      attempt: 1,
      capability: "voice-tts",
      target: { kind: "voice-line", id: "sh_12" },
      landedFiles: ["productions/saltlight/audio/A78.mp3"],
      finalization: { status: "pending", error: null, updatedAt: "2026-08-04T12:01:00.000Z" },
      error: null,
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:01:00.000Z",
    };
    await appendFile(h.journalPath, `${JSON.stringify(terminal)}\n`, "utf8");
    h.ledger.entries.push({
      ts: terminal.updatedAt,
      worldId: terminal.worldId,
      productionId: terminal.productionId!,
      jobId: terminal.id,
      provider: terminal.provider,
      model: terminal.model,
      outcome: "succeeded",
      estimatedMicroUsd: terminal.estimatedMicroUsd,
      actualMicroUsd: terminal.estimatedMicroUsd,
      actualSource: "manifest-derived",
    });

    const h2 = h.revive();
    await h2.queue.start();
    assert.equal(foldedJob(h2, terminal.id)?.finalization?.status, "failed");
    assert.equal(finalizations, 1);
    h2.queue.dispose();

    fail = false;
    const h3 = h2.revive();
    await h3.queue.start();
    assert.equal(finalizations, 1, "failed finalization is not replayed automatically every launch");
    await h3.queue.retryFinalization(terminal.id);
    assert.equal(foldedJob(h3, terminal.id)?.finalization?.status, "complete");
    assert.equal(finalizations, 2);
    assert.equal(fake.submitCount, 0);
    assert.equal(h3.ledger.entries.length, 1);
    h3.queue.dispose();
  });
});

describe("provider completion while the owning world is unavailable", () => {
  it("waits for the destination and lands without another submission", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.artifacts = [{ name: "portrait.png", contentType: "image/png", data: pngBytes() }];
    let available = false;
    let destination = "";
    const h = await makeHarness(
      { fake },
      {
        landInWorld: async (_worldId, fn) => {
          if (!available) return false;
          await fn(destination);
          return true;
        },
      },
    );
    destination = h.worldDir;
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      capability: "image",
      target: { kind: "character-sheet", id: "maren-kest/g1" },
      landing: { dir: "references/maren-kest/incoming", name: "character-sheet.png" },
    });
    await until(
      () => foldedJob(h, job.id)?.error?.includes("waiting for the owning world") === true,
      "the job to record the world-lease wait",
      FOLD_MS,
    );
    assert.equal(fake.submitCount, 1);
    assert.equal(foldedJob(h, job.id)?.status, "running");
    available = true;
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    assert.equal(fake.submitCount, 1, "destination recovery never resubmits paid provider work");
    assert.ok(await readFile(join(h.worldDir, "references/maren-kest/incoming/character-sheet.png")));
    h.queue.dispose();
  });
});

describe("kill at every step (§3.2) — strategy A: lookup by idempotency key", () => {
  it("killed after the provider accepted, before the remote id landed: adopted, no second request", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true, supportsLookupByKey: true });
    const h = await makeHarness({ fake });
    await h.queue.start();
    fake.onSubmitAccepted = () => h.queue.dispose(); // the kill: accepted remotely, never recorded
    const job = await h.queue.enqueue(INPUT);
    await until(() => fake.submitCount === 1, "the submission to reach the provider", FOLD_MS);
    await h.queue.drain();

    const raw = await readFile(h.journalPath, "utf8");
    assert.match(raw, /"submitting"/);
    assert.ok(!raw.includes('"running"'), "the remote id was never recorded — the uncertainty window");

    fake.onSubmitAccepted = null;
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.deepEqual(
      report.map((r) => [r.jobId, r.action]),
      [[job.id, "adopted"]],
    );
    await until(() => foldedJob(h2, job.id)?.status === "succeeded", "the rebuilt queue to fold the job to succeeded", FOLD_MS);
    assert.equal(fake.submitCount, 1, "no second submission — the whole point");
    assert.equal(h2.ledger.entries.length, 1, "exactly one ledger entry");
    h2.queue.dispose();
  });

  it("killed before the provider accepted: provably absent, resubmitted safely", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true, supportsLookupByKey: true });
    const h = await makeHarness({ fake });
    await h.queue.start();
    fake.submitHangs = true; // the request left; no answer ever came back
    const job = await h.queue.enqueue(INPUT);
    await until(() => fake.submitCount === 1, "the submission to reach the provider", FOLD_MS);
    h.queue.dispose(); // killed while the journal reads submitting and the provider has nothing
    await h.queue.drain();

    const raw = await readFile(h.journalPath, "utf8");
    assert.match(raw, /"submitting"/);

    fake.submitHangs = false;
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(
      report.find((r) => r.jobId === job.id)?.action,
      "resubmitted",
      "lookup said provably absent",
    );
    await until(() => foldedJob(h2, job.id)?.status === "succeeded", "the rebuilt queue to fold the job to succeeded", FOLD_MS);
    assert.equal(fake.submitCount, 2, "one hung request, one real resubmission after reconciliation");
    assert.equal(h2.ledger.entries.length, 1);
    h2.queue.dispose();
  });

  it("a failed lookup is unknown and never treated as proof the paid request is absent", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true, supportsLookupByKey: true });
    const h = await makeHarness({ fake });
    await h.queue.start();
    fake.onSubmitAccepted = () => h.queue.dispose();
    const job = await h.queue.enqueue(INPUT);
    await until(() => fake.submitCount === 1, "the submission to reach the provider", FOLD_MS);
    await h.queue.drain();
    fake.onSubmitAccepted = null;
    fake.lookupError = new Error("fetch failed during lookup");
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((row) => row.jobId === job.id)?.action, "held-for-user");
    assert.equal(fake.submitCount, 1);
    h2.queue.dispose();
  });
});

describe("kill mid-submit — strategy B: list recent", () => {
  async function killMidSubmit(fake: FakeProvider) {
    const h = await makeHarness({ fake });
    await h.queue.start();
    fake.onSubmitAccepted = () => h.queue.dispose();
    const job = await h.queue.enqueue(INPUT);
    await until(() => fake.submitCount === 1, "the submission to reach the provider", FOLD_MS);
    await h.queue.drain();
    fake.onSubmitAccepted = null;
    return { h, job };
  }

  it("inside the listing window with the key carried: adopted", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true, supportsListRecent: true });
    const { h, job } = await killMidSubmit(fake);
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((r) => r.jobId === job.id)?.action, "adopted");
    await until(() => foldedJob(h2, job.id)?.status === "succeeded", "the rebuilt queue to fold the job to succeeded", FOLD_MS);
    assert.equal(fake.submitCount, 1);
    h2.queue.dispose();
  });

  it("a listing that cannot carry the key is inconclusive: escalated to the user, never guessed", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true, supportsListRecent: true });
    fake.listingCarriesKeys = false; // the ElevenLabs shape
    const { h, job } = await killMidSubmit(fake);
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((r) => r.jobId === job.id)?.action, "held-for-user");
    assert.equal(foldedJob(h2, job.id)?.status, "needs-reconciliation");
    assert.equal(fake.submitCount, 1, "no request until the user answers");
    h2.queue.dispose();
  });

  it("outside the listing window: escalated, not resubmitted", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true, supportsListRecent: true });
    const { h, job } = await killMidSubmit(fake);
    fake.remote.clear(); // the listing no longer reaches back to the submission
    fake.listingWindowFloor = "9999-01-01T00:00:00Z";
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((r) => r.jobId === job.id)?.action, "held-for-user");
    h2.queue.dispose();
  });
});

describe("kill mid-submit — strategy C: neither, so the user is asked (D4)", () => {
  it("holds with the duplicate cost stated; resubmit and discard both resolve honestly", async () => {
    const fake = new FakeProvider({});
    const h = await makeHarness({ fake });
    await h.queue.start();
    fake.onSubmitAccepted = () => h.queue.dispose();
    const job = await h.queue.enqueue(INPUT);
    await until(() => fake.submitCount === 1, "the submission to reach the provider", FOLD_MS);
    await h.queue.drain();
    fake.onSubmitAccepted = null;

    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((r) => r.jobId === job.id)?.action, "held-for-user");
    const held = foldedJob(h2, job.id)!;
    assert.equal(held.status, "needs-reconciliation");
    assert.match(held.error!, /may have accepted and charged/);
    assert.match(held.error!, /\$0\.13/, "the duplicate cost is stated in dollars");
    assert.equal(fake.submitCount, 1, "nothing sent while the user has not answered");

    // The user accepts the risk: exactly one more submission.
    await h2.queue.resolveHeld(job.id, "resubmit");
    await until(() => foldedJob(h2, job.id)?.status === "succeeded", "the rebuilt queue to fold the job to succeeded", FOLD_MS);
    assert.equal(fake.submitCount, 2);
    assert.equal(h2.ledger.entries.length, 1);
    h2.queue.dispose();

    const fake3 = new FakeProvider({});
    const r = await makeHarness({ fake: fake3 });
    await r.queue.start();
    fake3.submitError = new Error("fetch failed after receipt");
    const job3 = await r.queue.enqueue(INPUT);
    await until(() => foldedJob(r, job3.id)?.status === "needs-reconciliation", "the third job to fold to needs-reconciliation", FOLD_MS);
    fake3.submitError = null;
    await Promise.all([r.queue.resolveHeld(job3.id, "resubmit"), r.queue.resolveHeld(job3.id, "resubmit")]);
    await until(() => foldedJob(r, job3.id)?.status === "succeeded", "the reconciled job to fold to succeeded", FOLD_MS);
    assert.equal(fake3.submitCount, 2, "concurrent decisions authorize only one additional call");
    r.queue.dispose();

    // A second held job, discarded: cancelled with a ledger entry, actual unknown (R-15).
    const fake2 = new FakeProvider({});
    const g = await makeHarness({ fake: fake2 });
    await g.queue.start();
    fake2.onSubmitAccepted = () => g.queue.dispose();
    const job2 = await g.queue.enqueue(INPUT);
    await until(() => fake2.submitCount === 1, "the second provider to receive the submission", FOLD_MS);
    await g.queue.drain();
    fake2.onSubmitAccepted = null;
    const g2 = g.revive();
    await g2.queue.start();
    await g2.queue.resolveHeld(job2.id, "discard");
    assert.equal(foldedJob(g2, job2.id)?.status, "cancelled");
    assert.equal(g2.ledger.entries.length, 1);
    assert.equal(g2.ledger.entries[0]!.outcome, "cancelled");
    assert.equal(g2.ledger.entries[0]!.actualMicroUsd, null, "the charge is unknown, not zero");
    g2.queue.dispose();
  });
});

describe("kill during download and after terminal (§3.2)", () => {
  it("killed mid-fetch: nothing partial visible; recovery resumes polling and lands once", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true, supportsLookupByKey: true });
    fake.artifacts = [{ name: "frame.png", contentType: "image/png", data: pngBytes() }];
    const h = await makeHarness({ fake });
    await h.queue.start();
    let fetched = false;
    fake.onFetch = () => {
      fetched = true;
      h.queue.dispose(); // the kill lands inside step ⑥
    };
    const job = await h.queue.enqueue({ ...INPUT, landing: { dir: "takes/tk_y" } });
    await until(() => fetched, "the artifact fetch to start", FOLD_MS);
    await h.queue.drain();

    // Nothing partial is visible in the world (R-12).
    const entries = await readdir(h.worldDir, { recursive: true }).catch(() => []);
    assert.ok(!entries.some((e) => String(e).includes("frame.png")), "no artifact visible after the kill");

    fake.onFetch = null;
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((r) => r.jobId === job.id)?.action, "resumed-polling");
    await until(() => foldedJob(h2, job.id)?.status === "succeeded", "the rebuilt queue to fold the job to succeeded", FOLD_MS);
    const landed = await readFile(join(h.worldDir, "takes/tk_y/frame.png"));
    assert.equal(landed.length, pngBytes().length);
    assert.equal(h2.ledger.entries.length, 1);
    h2.queue.dispose();
  });

  it("killed after the terminal row, before the ledger: recovery writes exactly one entry (R-16)", async () => {
    const fake = new FakeProvider({});
    const h = await makeHarness({ fake });
    await h.queue.start();
    h.ledger.onAppend = () => {
      throw new Error("killed before the ledger write");
    };
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    h.queue.dispose();
    await h.queue.drain();
    assert.equal(h.ledger.entries.length, 0, "the crash landed between ⑦'s two writes");

    h.ledger.onAppend = null;
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((r) => r.jobId === job.id)?.action, "ledger-completed");
    assert.equal(h2.ledger.entries.length, 1, "exactly one, written by recovery");
    assert.equal(h2.ledger.readJobIdsCount, 1);
    assert.equal(h2.ledger.hasCount, 0, "startup updates its snapshot after recovery append");
    const h3 = h2.revive();
    h2.queue.dispose();
    const again = await h3.queue.start();
    assert.equal(
      again.find((r) => r.jobId === job.id),
      undefined,
      "idempotent: a second recovery adds nothing",
    );
    assert.equal(h3.ledger.entries.length, 1);
    h3.queue.dispose();
  });
});

describe("provider faults pause the queue (R-8, D6, D7)", () => {
  it("a witnessed provider-fault submission rejection pauses before queued siblings can submit", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.submitError = new Error("HTTP 402 payment required: quota exhausted");
    fake.submissionRejected = true;
    const h = await makeHarness({ fake }, { baseConcurrency: 1 });
    await h.queue.start();
    const first = await h.queue.enqueue(INPUT);
    const siblings = await Promise.all(Array.from({ length: 4 }, () => h.queue.enqueue(INPUT)));
    await until(() => foldedJob(h, first.id)?.status === "failed", "the witnessed rejection to terminalize", FOLD_MS);
    assert.equal(foldedJob(h, first.id)?.failureClass, "provider-fault");
    assert.equal(h.queue.queueStatus("fake").paused, true);
    assert.equal(h.faults.length, 1);
    assert.equal(fake.submitCount, 1, "the lane pauses before runJob's finally can pump a sibling");
    assert.ok(siblings.every((job) => foldedJob(h, job.id)?.status === "queued"));
    h.queue.dispose();
  });

  it("a charged provider-fault poll terminalizes and ledgers the witnessed attempt exactly once", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true, reportsCost: true });
    fake.pollState = "failed";
    fake.pollFailureMessage = "HTTP 401 credential was rejected by the provider";
    fake.costMicroUsd = 4312;
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(
      () => foldedJob(h, job.id)?.status === "failed" && foldedJob(h, job.id)?.failureClass === "provider-fault",
      "the charged witnessed verdict to terminalize",
      FOLD_MS,
    );
    assert.equal(h.queue.queueStatus("fake").paused, true);
    assert.equal(fake.submitCount, 1);
    assert.deepEqual(h.ledger.entries.map((entry) => ({
      outcome: entry.outcome,
      actualMicroUsd: entry.actualMicroUsd,
      actualSource: entry.actualSource,
    })), [{ outcome: "failed", actualMicroUsd: 4312, actualSource: "provider-reported" }]);
    h.queue.resume("fake");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.submitCount, 1, "resuming the lane cannot reuse a charged terminal job");
    assert.equal(h.ledger.entries.length, 1);
    h.queue.dispose();
  });

  it("a poll-time provider fault durably holds the running job and resumes polling without resubmit", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.pollError = new Error("HTTP 401 credential was rejected while polling");
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(
      () => foldedJob(h, job.id)?.status === "running" && foldedJob(h, job.id)?.failureClass === "provider-fault",
      "the running job to persist its provider hold",
      FOLD_MS,
    );
    assert.equal(h.queue.queueStatus("fake").paused, true);
    assert.equal(fake.submitCount, 1);
    fake.pollError = null;
    h.queue.resume("fake");
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "polling to resume to success", FOLD_MS);
    assert.equal(fake.submitCount, 1, "a poll fault never resubmits paid work");
    assert.equal(foldedJob(h, job.id)?.failureClass, null);
    h.queue.dispose();
  });

  it("a 401 with forty queued jobs: paused, told once, zero failed, others keep running", async () => {
    const bad = new FakeProvider({ supportsIdempotencyKey: true });
    bad.submitError = new Error("HTTP 401 the credential was rejected");
    const good = new FakeProvider({});
    const h = await makeHarness({ bad, good }, { baseConcurrency: 1 });
    await h.queue.start();

    const jobs: Job[] = [];
    for (let i = 0; i < 40; i++) jobs.push(await h.queue.enqueue({ ...INPUT, provider: "bad" }));
    const other = await h.queue.enqueue({
      ...INPUT,
      provider: "good",
      capability: "image",
      model: "flux-pro-1.1",
    });

    await until(() => h.queue.queueStatus("bad").paused, "the failing provider's queue to pause", FOLD_MS);
    await until(() => foldedJob(h, other.id)?.status === "succeeded", "the healthy provider's job to fold to succeeded", FOLD_MS);
    assert.equal(bad.submitCount, 1, "one spend against the failure, not forty (R-8)");
    assert.equal(h.faults.length, 1, "the user is told once");
    assert.match(h.faults[0]!.message, /401/);
    for (const job of jobs) {
      const now = foldedJob(h, job.id)!;
      assert.ok(
        now.status === "queued" || now.status === "submitting",
        "held, never failed — they were not wrong",
      );
    }
    assert.equal(h.queue.queueStatus("bad").held, 40);

    // The key is fixed; resumption is the user's explicit confirmation (D7).
    bad.submitError = null;
    h.queue.resume("bad");
    await until(() => jobs.every((j) => foldedJob(h, j.id)?.status === "succeeded"), "every job in the wave to fold to succeeded", FOLD_MS);
    assert.equal(h.ledger.entries.filter((e) => e.provider === "bad").length, 40);
    h.queue.dispose();
  });
});

describe("retry classification (R-7, R-9, D5)", () => {
  it("a witnessed non-idempotent provider rejection fails without reconciliation", async () => {
    const fake = new FakeProvider({});
    fake.submitError = new Error("openai: image generation failed (HTTP 400)");
    fake.submissionRejected = true;
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "failed", "the job to fold to failed", FOLD_MS);
    assert.equal(foldedJob(h, job.id)?.failureClass, "terminal", "the class is durable on every failed row");
    assert.equal(fake.submitCount, 1);
    assert.equal(foldedJob(h, job.id)?.attempt, 1);
    assert.doesNotMatch(foldedJob(h, job.id)?.error ?? "", /outcome was not witnessed/);
    h.queue.dispose();
  });

  it("a content-policy rejection is not retried and the reason surfaces", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.submitError = new Error("HTTP 400 content policy violation: depicts a real person");
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "failed", "the job to fold to failed", FOLD_MS);
    assert.equal(fake.submitCount, 1, "five retries would be five charges for one refusal");
    assert.match(foldedJob(h, job.id)!.error!, /content policy/);
    assert.equal(h.ledger.entries.length, 1, "failures write ledger entries too (D7)");
    h.queue.dispose();
  });

  it("an ambiguous error is terminal, not retried (D5)", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.submitError = new Error("something inscrutable happened");
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "failed", "the job to fold to failed", FOLD_MS);
    assert.equal(fake.submitCount, 1);
    h.queue.dispose();
  });

  it("transient failures retry with bounded attempts then give up", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.submitError = new Error("HTTP 503 unavailable");
    fake.submitErrorTimes = 2; // two failures, then healthy
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    assert.equal(fake.submitCount, 3);
    assert.equal(foldedJob(h, job.id)?.attempt, 3);
    assert.deepEqual(new Set(fake.submittedKeys).size, 1, "every safe retry carries the same persisted key");
    h.queue.dispose();
  });

  it("an error that declares itself transient is backed off, and the class survives giving up", async () => {
    // A local engine whose card has no room for the recipe (#692). Its message matches no
    // pattern, so only the class the client declared makes it a retry — and the failed row has
    // to keep that class, because it is what every frame-run surface offers Retry on.
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.submitError = Object.assign(
      new Error("comfyui: Draft Image needs 5.9 GB of free graphics memory and this machine has 2.0 GB free. Close other programs using the graphics card, then try again."),
      { failureClass: "transient" },
    );
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "failed", "the job to fold to failed", FOLD_MS);
    assert.equal(fake.submitCount, 3, "a busy engine is retried, bounded");
    assert.equal(foldedJob(h, job.id)?.attempt, 3);
    assert.equal(foldedJob(h, job.id)?.failureClass, "transient", "an exhausted transient keeps a live Retry (SPEC-036 R-18)");
    assert.match(foldedJob(h, job.id)?.error ?? "", /^gave up after 3 attempts: comfyui: Draft Image needs/);
    h.queue.dispose();
  });

  it("waits out the backoff before resubmitting, even when the attempt outlasted the interval", async () => {
    // The lane timer alone never held a retry: the failing attempt's own completion pumps the
    // lane, and an attempt longer than the dispatch interval met an open gate. Every real
    // provider call is longer than the interval, so every retry went straight back out.
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.submitError = new Error("HTTP 503 unavailable");
    fake.submitErrorTimes = 1;
    fake.submitDelayMs = 30;
    const h = await makeHarness({ fake }, { backoffBaseMs: 200, backoffCapMs: 200, rng: () => 1 });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    assert.equal(fake.submitCount, 2);
    const gap = fake.submitStartedAt[1]! - fake.submitStartedAt[0]!;
    assert.ok(gap >= 200, `resubmitted ${gap} ms after the first attempt began; the backoff is 200 ms`);
    h.queue.dispose();
  });

  it("holds only the job that is backing off, never a sibling queued behind it", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.submitError = new Error("HTTP 503 unavailable");
    fake.submitErrorTimes = 1;
    fake.submitDelayMs = 10;
    const h = await makeHarness({ fake }, { baseConcurrency: 1, backoffBaseMs: 300, backoffCapMs: 300, rng: () => 1 });
    await h.queue.start();
    const first = await h.queue.enqueue(INPUT);
    await until(
      () => foldedJob(h, first.id)?.status === "queued" && foldedJob(h, first.id)?.attempt === 1,
      "the first job to be requeued on its backoff",
      FOLD_MS,
    );
    const second = await h.queue.enqueue(INPUT);
    await until(() => [first.id, second.id].every((id) => foldedJob(h, id)?.status === "succeeded"), "both jobs to succeed", FOLD_MS);
    assert.equal(fake.submitCount, 3);
    const [a, b, aAgain] = fake.submittedKeys;
    assert.notEqual(b, a, "the sibling went out while the first job waited");
    assert.equal(aAgain, a, "the first job went out last, after its backoff");
    const held = fake.submitStartedAt[2]! - fake.submitStartedAt[0]!;
    assert.ok(held >= 300, `the retry waited ${held} ms; the backoff is 300 ms`);
    h.queue.dispose();
  });
});

describe("rate and concurrency (R-10, D8)", () => {
  it("two worlds serialise against one provider limit", async () => {
    const fake = new FakeProvider({});
    const h = await makeHarness({ fake }, { baseConcurrency: 1 });
    await h.queue.start();
    const a = await h.queue.enqueue({ ...INPUT, worldId: WORLD });
    const b = await h.queue.enqueue({ ...INPUT, worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD" });
    await until(
      () => foldedJob(h, a.id)?.status === "succeeded" && foldedJob(h, b.id)?.status === "succeeded",
      "both worlds' jobs to fold to succeeded",
      FOLD_MS,
    );
    assert.equal(fake.maxObservedConcurrent, 1, "one key, one limit, regardless of worlds (D8)");
    h.queue.dispose();
  });

  it("a Kokoro override stays at one while other providers retain the global limit", async () => {
    const kokoro = new FakeProvider({});
    const h = await makeHarness({ kokoro }, { baseConcurrency: 2, providerConcurrency: { kokoro: 1 } });
    await h.queue.start();
    const input = {
      ...INPUT,
      capability: "voice-tts" as const,
      provider: "kokoro",
      model: "kokoro-82m",
      params: { voiceId: "af_bella", text: "the harbour remembers" },
      estimatedMicroUsd: 0,
    };
    const first = await h.queue.enqueue(input);
    const second = await h.queue.enqueue({ ...input, worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD" });
    await until(
      () => foldedJob(h, first.id)?.status === "succeeded" && foldedJob(h, second.id)?.status === "succeeded",
      "both Kokoro jobs to fold to succeeded",
      FOLD_MS,
    );
    assert.equal(kokoro.maxObservedConcurrent, 1);
    h.queue.dispose();
  });

  it("queue position is observable while waiting (R-11)", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.submitError = new Error("HTTP 401 nope");
    const h = await makeHarness({ fake });
    await h.queue.start();
    const first = await h.queue.enqueue(INPUT);
    await until(() => h.queue.queueStatus("fake").paused, "the provider's queue to pause", FOLD_MS);
    const second = await h.queue.enqueue(INPUT);
    const third = await h.queue.enqueue(INPUT);
    assert.equal(h.queue.queuePosition(first.id), 0, "the paused head went back to the front");
    assert.equal(h.queue.queuePosition(second.id), 1, "queued behind 1 job");
    assert.equal(h.queue.queuePosition(third.id), 2, "queued behind 2 jobs");
    h.queue.dispose();
  });
});

describe("offline holds rather than fails (R-17, D13)", () => {
  it("a non-idempotent paid request is held after one ambiguous submission", async () => {
    const fake = new FakeProvider({});
    fake.submitError = new Error("fetch failed: ENOTFOUND queue.fal.run");
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "needs-reconciliation", "the job to fold to needs-reconciliation", FOLD_MS);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fake.submitCount, 1, "offline auto-resume cannot repeat a paid non-idempotent call");
    assert.equal(foldedJob(h, job.id)?.attempt, 1);
    assert.equal(h.faults.length, 0, "offline is not a provider fault");
    assert.equal(h.ledger.entries.length, 0, "unknown work is not claimed as zero-cost completion");
    h.queue.dispose();
  });

  it("contains a legacy submitting-to-queued loop on the first patched restart", async () => {
    const fake = new FakeProvider({});
    const h = await makeHarness({ fake });
    await h.queue.start();
    h.queue.dispose();
    const now = "2026-08-04T12:00:00.000Z";
    const base: Job = {
      id: "jb_01J8E000000000000000000J93",
      idempotencyKey: "01J8E100000000000000000J93",
      worldId: WORLD,
      target: { kind: "character-sheet", id: "maren-kest/legacy" },
      capability: "image",
      provider: "fake",
      model: "gpt-image-2",
      params: {},
      estimatedMicroUsd: 40000,
      status: "queued",
      providerJobId: null,
      attempt: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await appendFile(
      h.journalPath,
      `${JSON.stringify({ ...base, status: "submitting" })}\n${JSON.stringify(base)}\n`,
      "utf8",
    );
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((row) => row.jobId === base.id)?.action, "held-for-user");
    assert.equal(foldedJob(h2, base.id)?.status, "needs-reconciliation");
    assert.equal(foldedJob(h2, base.id)?.attempt, 1);
    assert.equal(fake.submitCount, 0);
    h2.queue.dispose();
  });

  it("a guaranteed-idempotent offline submission retries with one key and a hard ceiling", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.submitError = new Error("fetch failed: ENOTFOUND queue.fal.run");
    fake.submitErrorTimes = 2;
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    assert.equal(fake.submitCount, 3);
    assert.equal(foldedJob(h, job.id)?.attempt, 3);
    assert.equal(new Set(fake.submittedKeys).size, 1);
    h.queue.dispose();
  });
});

describe("artifact verification (R-12, R-13, D12)", () => {
  it("a truncated download fails verification and is never landed", async () => {
    const fake = new FakeProvider({});
    fake.artifacts = [{ name: "frame.png", contentType: "image/png", data: truncatedPngBytes() }];
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue({ ...INPUT, landing: { dir: "takes/tk_z" } });
    await until(() => foldedJob(h, job.id)?.status === "failed", "the job to fold to failed", FOLD_MS);
    assert.equal(foldedJob(h, job.id)?.failureClass, "transient", "invalid provider output remains retryable");
    assert.match(foldedJob(h, job.id)!.error!, /truncated/);
    const entries = await readdir(h.worldDir, { recursive: true }).catch(() => []);
    assert.ok(!entries.some((e) => String(e).includes("frame.png")));
    assert.equal(h.ledger.entries.length, 1);
    h.queue.dispose();
  });

  for (const sample of [
    { label: "JPEG", contentType: "image/jpeg", data: jpegBytes(), extension: "jpg" },
    { label: "WebP", contentType: "image/webp", data: webpBytes(), extension: "webp" },
    {
      label: "WebP without provider metadata",
      contentType: "application/octet-stream",
      data: webpBytes(),
      extension: "webp",
    },
  ]) {
    it(`preserves ${sample.label} bytes and extension for character images`, async () => {
      const fake = new FakeProvider({});
      fake.artifacts = [{ name: "provider-output.png", contentType: sample.contentType, data: sample.data }];
      const h = await makeHarness({ fake });
      await h.queue.start();
      const job = await h.queue.enqueue({
        ...INPUT,
        target: { kind: "character-sheet", id: "maren-kest/g1" },
        capability: "image",
        landing: { dir: "references/maren-kest/incoming", name: "character-sheet-g1.png" },
      });
      await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
      const relative = `references/maren-kest/incoming/character-sheet-g1.${sample.extension}`;
      assert.deepEqual(foldedJob(h, job.id)?.landedFiles, [relative]);
      assert.deepEqual(new Uint8Array(await readFile(join(h.worldDir, relative))), sample.data);
      h.queue.dispose();
    });
  }

  it("rejects a declared image type that disagrees with the bytes", async () => {
    const fake = new FakeProvider({});
    fake.artifacts = [{ name: "frame.png", contentType: "image/png", data: jpegBytes() }];
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue({ ...INPUT, landing: { dir: "takes/tk_mismatch" } });
    await until(() => foldedJob(h, job.id)?.status === "failed", "the job to fold to failed", FOLD_MS);
    assert.match(foldedJob(h, job.id)!.error!, /not a PNG/);
    const entries = await readdir(h.worldDir, { recursive: true }).catch(() => []);
    assert.ok(!entries.some((entry) => String(entry).includes("frame.png")));
    h.queue.dispose();
  });

  it("rejects an MP3 whose first frame is complete but the following frame is truncated", async () => {
    const fake = new FakeProvider({});
    const frame = Uint8Array.from([0xff, 0xfb, 0x90, 0, ...Array.from({ length: 413 }, () => 0)]);
    fake.inlineArtifacts = [
      {
        name: "speech.mp3",
        contentType: "audio/mpeg",
        data: Uint8Array.from([...frame, ...frame.subarray(0, 100)]),
      },
    ];
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      capability: "voice-tts",
      target: { kind: "voice-line", id: "sh_12" },
      landing: { dir: "productions/saltlight/audio" },
    });
    await until(() => foldedJob(h, job.id)?.status === "failed", "the job to fold to failed", FOLD_MS);
    assert.match(foldedJob(h, job.id)?.error ?? "", /MP3 is truncated/);
    const entries = await readdir(h.worldDir, { recursive: true }).catch(() => []);
    assert.equal(
      entries.some((entry) => String(entry).includes("speech.mp3")),
      false,
    );
    h.queue.dispose();
  });
});

describe("cancellation (R-14, R-15, D10)", () => {
  it("cancelling a running job attempts the remote cancel and still writes a ledger entry", async () => {
    const fake = new FakeProvider({ reportsCost: true });
    fake.pollState = "running"; // the remote work never finishes on its own
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "running", "the job to fold to running", FOLD_MS);
    await h.queue.cancel(job.id);
    assert.equal(foldedJob(h, job.id)?.status, "cancelled");
    assert.equal(fake.cancelCount, 1);
    assert.equal(h.ledger.entries.length, 1);
    assert.equal(h.ledger.entries[0]!.outcome, "cancelled");
    h.queue.dispose();
  });

  it("aborts a synchronous submit that has not produced a remote id yet", async () => {
    let submitSignal: AbortSignal | undefined;
    const client = new FakeProvider({});
    client.submit = async (_key, request) => {
      submitSignal = (request as { signal?: AbortSignal }).signal;
      await new Promise<void>((_resolve, reject) => {
        submitSignal?.addEventListener("abort", () => reject(new Error("submit cancelled")), { once: true });
      });
      throw new Error("unreachable");
    };
    const h = await makeHarness({ kokoro: client });
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      provider: "kokoro",
      model: "kokoro-82m",
      capability: "voice-tts",
      params: { voiceId: "af_bella", text: "the harbour remembers" },
      estimatedMicroUsd: 0,
    });
    await until(() => foldedJob(h, job.id)?.status === "submitting", "the job to fold to submitting", FOLD_MS);
    await h.queue.cancel(job.id);
    assert.equal(submitSignal?.aborted, true);
    assert.equal(foldedJob(h, job.id)?.status, "cancelled");
    assert.equal(h.ledger.entries.at(-1)?.outcome, "cancelled");
    h.queue.dispose();
  });

  it("aborting a paid remote submit lands cancelled, never a hold or a resubmit (issue 95)", async () => {
    // The case above is a local runtime, which skips handleSubmitError's hold branch outright. A
    // paid, non-idempotent remote takes that branch — so now that the OpenAI/fal/Anthropic clients
    // actually honour the signal, the abort rejection reaches it for the first time. It must not
    // turn a user cancellation into a needs-reconciliation hold, and above all not into a second
    // charged attempt (#93). The two settle against each other on a microtask, so drain before
    // believing the status: the failure this guards is a late transition, not an immediate one.
    let submitSignal: AbortSignal | undefined;
    let submits = 0;
    const fake = new FakeProvider({});
    fake.submit = async (_key, request) => {
      submits += 1;
      submitSignal = (request as { signal?: AbortSignal }).signal;
      await new Promise<void>((_resolve, reject) => {
        submitSignal?.addEventListener("abort", () => reject(new Error("submit cancelled")), { once: true });
      });
      throw new Error("unreachable");
    };
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "submitting", "the job to fold to submitting", FOLD_MS);
    await h.queue.cancel(job.id);
    // cancel() resolves with the job terminal; only the racing submit-rejection's ledger
    // append can still be in flight, so that is the condition to wait on — not a sleep.
    await until(() => h.ledger.entries.at(-1)?.outcome === "cancelled", "the cancellation to reach the ledger", FOLD_MS);
    assert.equal(submitSignal?.aborted, true);
    assert.equal(foldedJob(h, job.id)?.status, "cancelled");
    assert.equal(submits, 1);
    h.queue.dispose();
  });

  it("a queue-backed submit landing after cancellation is still cancelled remotely (issue 95)", async () => {
    // The counterpart to the test above, and why the signal is NOT forwarded everywhere. fal's
    // submit is an enqueue that ignores the abort deliberately: it has to return the request id,
    // because that id is the only handle for calling accepted remote work off. So the cancel is
    // delivered on the far side of a submit that completes *after* the user cancelled — the branch
    // at dispatcher.ts:701. Abort that POST instead and the id is lost with the remote job still
    // running: a cancelled paid generation that finishes, and charges, unseen.
    let release: (() => void) | undefined;
    const fake = new FakeProvider({});
    const accept = fake.submit.bind(fake);
    fake.submit = async (key, request) => {
      // No signal handling, exactly like the fal enqueue.
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return accept(key, request);
    };
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "submitting", "the job to fold to submitting", FOLD_MS);
    await until(() => release !== undefined, "the provider to hold the in-flight submission", FOLD_MS);
    await h.queue.cancel(job.id);
    assert.equal(foldedJob(h, job.id)?.status, "cancelled");
    assert.equal(fake.cancelCount, 0, "there is nothing to cancel remotely until the id comes back");
    release!();
    await until(() => fake.cancelCount === 1, "the cancellation to reach the provider", FOLD_MS);
    assert.equal(foldedJob(h, job.id)?.status, "cancelled");
    h.queue.dispose();
  });
});

describe("cost capture (R-15, SPEC-008 R-17)", () => {
  it("a provider that reports cost records it as provider-reported", async () => {
    const fake = new FakeProvider({ reportsCost: true });
    fake.costMicroUsd = 128400;
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    assert.equal(h.ledger.entries[0]!.actualMicroUsd, 128400);
    assert.equal(h.ledger.entries[0]!.actualSource, "provider-reported");
    h.queue.dispose();
  });

  it("a local runtime records zero, labelled unmetered", async () => {
    const fake = new FakeProvider({});
    const h = await makeHarness({ ollama: fake }, { getKey: async () => null });
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      provider: "ollama",
      capability: "llm",
      model: "llama3.1-8b",
      estimatedMicroUsd: 0,
    });
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    assert.equal(h.ledger.entries[0]!.actualMicroUsd, 0);
    assert.equal(h.ledger.entries[0]!.actualSource, "local-zero");
    h.queue.dispose();
  });
});

describe("no credential holds the lane rather than failing the work", () => {
  it("a job for an unkeyed provider waits with the reason stated", async () => {
    const fake = new FakeProvider({});
    const h = await makeHarness({ fake }, { getKey: async () => null });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => h.queue.queueStatus("fake").paused, "the provider's queue to pause", FOLD_MS);
    assert.match(h.queue.queueStatus("fake").reason!, /no credential/);
    assert.equal(foldedJob(h, job.id)?.status, "queued");
    assert.equal(fake.submitCount, 0);
    h.queue.dispose();
  });
});

describe("deleting a finished job from Activity's history (SPEC-014 R-13)", () => {
  it("drops the row, keeps the ledger entry, and stays gone across a restart", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "succeeded", "the job to fold to succeeded", FOLD_MS);
    const spentBefore = h.ledger.entries.length;

    await h.queue.delete(job.id);
    assert.equal(foldedJob(h, job.id), undefined, "the row leaves the queue's view");
    assert.equal(h.ledger.entries.length, spentBefore, "what was spent stays spent");
    assert.ok(
      h.events.some((e) => e.type === "job.deleted" && e.jobId === job.id),
      "the deletion is pushed, not polled for",
    );

    // The journal is append-only: the tombstone is a record, not a rewrite.
    const lines = (await readFile(h.journalPath, "utf8")).trim().split("\n");
    const rows = lines.map((line) => JSON.parse(line) as Job).filter((row) => row.id === job.id);
    assert.ok(rows.length > 1, "earlier records are still there");
    assert.ok(rows.at(-1)!.deletedAt, "the last record is the tombstone");

    h.queue.dispose();
    const revived = h.revive();
    const report = await revived.queue.start();
    assert.equal(foldedJob(revived, job.id), undefined, "recovery does not resurrect it");
    assert.equal(report.length, 0, "a deleted row is nothing to reconcile");
    revived.queue.dispose();
  });

  it("refuses work that is still in flight — that is a cancel, not a delete", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.pollState = "running"; // never finishes: the job sits in flight for the whole test
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "running", "the job to fold to running", FOLD_MS);

    await h.queue.delete(job.id);
    assert.equal(foldedJob(h, job.id)?.status, "running", "the job is untouched");
    assert.ok(!h.events.some((e) => e.type === "job.deleted"));

    // Cancel is the action this state does permit, and then the row can go.
    await h.queue.cancel(job.id);
    await h.queue.delete(job.id);
    assert.equal(foldedJob(h, job.id), undefined);
    h.queue.dispose();
  });

  it("refuses a job whose finalization still owes the user an outcome", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.artifacts = [{ name: "main.png", contentType: "image/png", data: pngBytes() }];
    const h = await makeHarness(
      { fake },
      {
        onTerminal: () => {
          throw new Error("preparation failed");
        },
      },
    );
    await h.queue.start();
    const job = await h.queue.enqueue({
      ...INPUT,
      target: { kind: "main-photo-candidate", id: "kestrel/main" },
      capability: "image",
      landing: { dir: "references/kestrel/candidates" },
    });
    await until(() => foldedJob(h, job.id)?.finalization?.status === "failed", "the finalization to fold to failed", FOLD_MS);

    await h.queue.delete(job.id);
    assert.ok(foldedJob(h, job.id), "a failed finalization is a needs-you item with a retry on it");
    assert.ok(!h.events.some((e) => e.type === "job.deleted"));
    h.queue.dispose();
  });
});

describe("pre-allocated idempotency keys (SPEC-024 D2, R-19)", () => {
  it("re-enqueueing a key that already journalled a job returns that job, never a second spend", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    const h = await makeHarness({ fake });
    await h.queue.start();
    const key = "01J8E0000000000000000000K1";
    const first = await h.queue.enqueue({ ...INPUT, idempotencyKey: key });
    assert.equal(first.idempotencyKey, key, "the caller's key is the journalled key");
    // The crash window this exists for: a plan recorded pass-materialised, enqueued, and died
    // before recording the jobId — the reopened driver re-enqueues the same key.
    const second = await h.queue.enqueue({ ...INPUT, idempotencyKey: key });
    assert.equal(second.id, first.id, "one key, one job");
    assert.equal(h.queue.listJobs().filter((job) => job.idempotencyKey === key).length, 1);
    h.queue.dispose();
  });
});
