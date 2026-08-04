import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DomainEvent, Job, LedgerEntry } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { JobQueue, type EnqueueInput } from "../../src/queue/dispatcher.js";
import { FakeProvider, jpegBytes, pngBytes, truncatedPngBytes, webpBytes } from "./fake-provider.js";

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
  ledger: { entries: LedgerEntry[]; onAppend: ((e: LedgerEntry) => void) | null };
  faults: Array<{ provider: string; message: string }>;
  journalPath: string;
  worldDir: string;
  revive: () => Harness;
}

async function makeHarness(
  clients: Record<string, FakeProvider>,
  opts: { getKey?: (p: string) => Promise<string | null>; baseConcurrency?: number } = {},
): Promise<Harness> {
  const dir = await tempDir("arke-queue-");
  const worldDir = await tempDir("arke-qworld-");
  return build(join(dir, "jobs.jsonl"), worldDir, clients, opts);
}

function build(
  journalPath: string,
  worldDir: string,
  clients: Record<string, FakeProvider>,
  opts: { getKey?: (p: string) => Promise<string | null>; baseConcurrency?: number },
): Harness {
  const events: DomainEvent[] = [];
  const ledger: Harness["ledger"] = { entries: [], onAppend: null };
  const faults: Harness["faults"] = [];
  const queue = new JobQueue({
    journalPath,
    clients,
    getKey: opts.getKey ?? (async () => "test-key"),
    emit: (e) => events.push(e),
    ledger: {
      has: async (jobId) => ledger.entries.some((e) => e.jobId === jobId),
      append: async (entry) => {
        ledger.onAppend?.(entry);
        ledger.entries.push(entry);
      },
    },
    worldDirFor: () => worldDir,
    onProviderFault: (provider, message) => faults.push({ provider, message }),
    maxAttempts: 3,
    backoffBaseMs: 5,
    backoffCapMs: 20,
    pollIntervalMs: 5,
    offlineRetryMs: 40,
    baseIntervalMs: 1,
    ...(opts.baseConcurrency !== undefined ? { baseConcurrency: opts.baseConcurrency } : {}),
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

async function until(cond: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function foldedJob(h: Harness, id: string): Job | undefined {
  return h.queue.listJobs().find((j) => j.id === id);
}

describe("the happy path writes exactly one ledger entry and lands artifacts atomically", () => {
  it("queued → submitting → running → succeeded, with landing", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
    fake.artifacts = [{ name: "frame.png", contentType: "image/png", data: pngBytes() }];
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue({ ...INPUT, landing: { dir: "productions/saltlight/takes/tk_x" } });
    await until(() => foldedJob(h, job.id)?.status === "succeeded");
    assert.equal(fake.submitCount, 1);
    assert.deepEqual(foldedJob(h, job.id)?.landedFiles, ["productions/saltlight/takes/tk_x/frame.png"]);
    const landed = await readFile(join(h.worldDir, "productions/saltlight/takes/tk_x/frame.png"));
    assert.equal(landed.length, pngBytes().length);
    assert.equal(h.ledger.entries.length, 1);
    assert.equal(h.ledger.entries[0]!.actualSource, "manifest-derived", "no cost reported → derived (R-17)");
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
    await until(() => fake.submitCount === 1);
    await h.queue.drain();

    const raw = await readFile(h.journalPath, "utf8");
    assert.match(raw, /"submitting"/);
    assert.ok(!raw.includes('"running"'), "the remote id was never recorded — the uncertainty window");

    fake.onSubmitAccepted = null;
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.deepEqual(report.map((r) => [r.jobId, r.action]), [[job.id, "adopted"]]);
    await until(() => foldedJob(h2, job.id)?.status === "succeeded");
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
    await until(() => fake.submitCount === 1);
    h.queue.dispose(); // killed while the journal reads submitting and the provider has nothing
    await h.queue.drain();

    const raw = await readFile(h.journalPath, "utf8");
    assert.match(raw, /"submitting"/);

    fake.submitHangs = false;
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((r) => r.jobId === job.id)?.action, "resubmitted", "lookup said provably absent");
    await until(() => foldedJob(h2, job.id)?.status === "succeeded");
    assert.equal(fake.submitCount, 2, "one hung request, one real resubmission after reconciliation");
    assert.equal(h2.ledger.entries.length, 1);
    h2.queue.dispose();
  });
});

describe("kill mid-submit — strategy B: list recent", () => {
  async function killMidSubmit(fake: FakeProvider) {
    const h = await makeHarness({ fake });
    await h.queue.start();
    fake.onSubmitAccepted = () => h.queue.dispose();
    const job = await h.queue.enqueue(INPUT);
    await until(() => fake.submitCount === 1);
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
    await until(() => foldedJob(h2, job.id)?.status === "succeeded");
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
    await until(() => fake.submitCount === 1);
    await h.queue.drain();
    fake.onSubmitAccepted = null;

    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((r) => r.jobId === job.id)?.action, "held-for-user");
    const held = foldedJob(h2, job.id)!;
    assert.equal(held.status, "needs-reconciliation");
    assert.match(held.error!, /may charge twice/);
    assert.match(held.error!, /\$0\.13/, "the duplicate cost is stated in dollars");
    assert.equal(fake.submitCount, 1, "nothing sent while the user has not answered");

    // The user accepts the risk: exactly one more submission.
    await h2.queue.resolveHeld(job.id, "resubmit");
    await until(() => foldedJob(h2, job.id)?.status === "succeeded");
    assert.equal(fake.submitCount, 2);
    assert.equal(h2.ledger.entries.length, 1);
    h2.queue.dispose();

    // A second held job, discarded: cancelled with a ledger entry, actual unknown (R-15).
    const fake2 = new FakeProvider({});
    const g = await makeHarness({ fake: fake2 });
    await g.queue.start();
    fake2.onSubmitAccepted = () => g.queue.dispose();
    const job2 = await g.queue.enqueue(INPUT);
    await until(() => fake2.submitCount === 1);
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
    await until(() => fetched);
    await h.queue.drain();

    // Nothing partial is visible in the world (R-12).
    const entries = await readdir(h.worldDir, { recursive: true }).catch(() => []);
    assert.ok(!entries.some((e) => String(e).includes("frame.png")), "no artifact visible after the kill");

    fake.onFetch = null;
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((r) => r.jobId === job.id)?.action, "resumed-polling");
    await until(() => foldedJob(h2, job.id)?.status === "succeeded");
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
    await until(() => foldedJob(h, job.id)?.status === "succeeded");
    h.queue.dispose();
    await h.queue.drain();
    assert.equal(h.ledger.entries.length, 0, "the crash landed between ⑦'s two writes");

    h.ledger.onAppend = null;
    const h2 = h.revive();
    const report = await h2.queue.start();
    assert.equal(report.find((r) => r.jobId === job.id)?.action, "ledger-completed");
    assert.equal(h2.ledger.entries.length, 1, "exactly one, written by recovery");
    const h3 = h2.revive();
    h2.queue.dispose();
    const again = await h3.queue.start();
    assert.equal(again.find((r) => r.jobId === job.id), undefined, "idempotent: a second recovery adds nothing");
    assert.equal(h3.ledger.entries.length, 1);
    h3.queue.dispose();
  });
});

describe("provider faults pause the queue (R-8, D6, D7)", () => {
  it("a 401 with forty queued jobs: paused, told once, zero failed, others keep running", async () => {
    const bad = new FakeProvider({});
    bad.submitError = new Error("HTTP 401 the credential was rejected");
    const good = new FakeProvider({});
    const h = await makeHarness({ bad, good }, { baseConcurrency: 1 });
    await h.queue.start();

    const jobs: Job[] = [];
    for (let i = 0; i < 40; i++) jobs.push(await h.queue.enqueue({ ...INPUT, provider: "bad" }));
    const other = await h.queue.enqueue({ ...INPUT, provider: "good", capability: "image", model: "flux-pro-1.1" });

    await until(() => h.queue.queueStatus("bad").paused);
    await until(() => foldedJob(h, other.id)?.status === "succeeded");
    assert.equal(bad.submitCount, 1, "one spend against the failure, not forty (R-8)");
    assert.equal(h.faults.length, 1, "the user is told once");
    assert.match(h.faults[0]!.message, /401/);
    for (const job of jobs) {
      const now = foldedJob(h, job.id)!;
      assert.ok(now.status === "queued" || now.status === "submitting", "held, never failed — they were not wrong");
    }
    assert.equal(h.queue.queueStatus("bad").held, 40);

    // The key is fixed; resumption is the user's explicit confirmation (D7).
    bad.submitError = null;
    h.queue.resume("bad");
    await until(() => jobs.every((j) => foldedJob(h, j.id)?.status === "succeeded"), 10_000);
    assert.equal(h.ledger.entries.filter((e) => e.provider === "bad").length, 40);
    h.queue.dispose();
  });
});

describe("retry classification (R-7, R-9, D5)", () => {
  it("a content-policy rejection is not retried and the reason surfaces", async () => {
    const fake = new FakeProvider({});
    fake.submitError = new Error("HTTP 400 content policy violation: depicts a real person");
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "failed");
    assert.equal(fake.submitCount, 1, "five retries would be five charges for one refusal");
    assert.match(foldedJob(h, job.id)!.error!, /content policy/);
    assert.equal(h.ledger.entries.length, 1, "failures write ledger entries too (D7)");
    h.queue.dispose();
  });

  it("an ambiguous error is terminal, not retried (D5)", async () => {
    const fake = new FakeProvider({});
    fake.submitError = new Error("something inscrutable happened");
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "failed");
    assert.equal(fake.submitCount, 1);
    h.queue.dispose();
  });

  it("transient failures retry with bounded attempts then give up", async () => {
    const fake = new FakeProvider({});
    fake.submitError = new Error("HTTP 503 unavailable");
    fake.submitErrorTimes = 2; // two failures, then healthy
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => foldedJob(h, job.id)?.status === "succeeded");
    assert.equal(fake.submitCount, 3);
    assert.equal(foldedJob(h, job.id)?.attempt, 2);
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
    await until(() => foldedJob(h, a.id)?.status === "succeeded" && foldedJob(h, b.id)?.status === "succeeded");
    assert.equal(fake.maxObservedConcurrent, 1, "one key, one limit, regardless of worlds (D8)");
    h.queue.dispose();
  });

  it("queue position is observable while waiting (R-11)", async () => {
    const fake = new FakeProvider({});
    fake.submitError = new Error("HTTP 401 nope");
    const h = await makeHarness({ fake });
    await h.queue.start();
    const first = await h.queue.enqueue(INPUT);
    await until(() => h.queue.queueStatus("fake").paused);
    const second = await h.queue.enqueue(INPUT);
    const third = await h.queue.enqueue(INPUT);
    assert.equal(h.queue.queuePosition(first.id), 0, "the paused head went back to the front");
    assert.equal(h.queue.queuePosition(second.id), 1, "queued behind 1 job");
    assert.equal(h.queue.queuePosition(third.id), 2, "queued behind 2 jobs");
    h.queue.dispose();
  });
});

describe("offline holds rather than fails (R-17, D13)", () => {
  it("network unreachable: queued, no attempt burned, resumes by itself", async () => {
    const fake = new FakeProvider({});
    fake.submitError = new Error("fetch failed: ENOTFOUND queue.fal.run");
    const h = await makeHarness({ fake });
    await h.queue.start();
    const job = await h.queue.enqueue(INPUT);
    await until(() => h.queue.queueStatus("fake").paused);
    assert.match(h.queue.queueStatus("fake").reason!, /offline/);
    assert.equal(foldedJob(h, job.id)?.status, "queued", "not a failure — nothing about it is wrong");
    assert.equal(foldedJob(h, job.id)?.attempt, 0, "offline never burns an attempt");
    assert.equal(h.faults.length, 0, "offline is not a provider fault");

    fake.submitError = null; // connectivity returns; the offline timer resumes the lane
    await until(() => foldedJob(h, job.id)?.status === "succeeded");
    assert.equal(h.ledger.entries.length, 1);
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
    await until(() => foldedJob(h, job.id)?.status === "failed");
    assert.match(foldedJob(h, job.id)!.error!, /truncated/);
    const entries = await readdir(h.worldDir, { recursive: true }).catch(() => []);
    assert.ok(!entries.some((e) => String(e).includes("frame.png")));
    assert.equal(h.ledger.entries.length, 1);
    h.queue.dispose();
  });

  for (const sample of [
    { label: "JPEG", contentType: "image/jpeg", data: jpegBytes(), extension: "jpg" },
    { label: "WebP", contentType: "image/webp", data: webpBytes(), extension: "webp" },
    { label: "WebP without provider metadata", contentType: "application/octet-stream", data: webpBytes(), extension: "webp" },
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
      await until(() => foldedJob(h, job.id)?.status === "succeeded");
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
    await until(() => foldedJob(h, job.id)?.status === "failed");
    assert.match(foldedJob(h, job.id)!.error!, /not a PNG/);
    const entries = await readdir(h.worldDir, { recursive: true }).catch(() => []);
    assert.ok(!entries.some((entry) => String(entry).includes("frame.png")));
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
    await until(() => foldedJob(h, job.id)?.status === "running");
    await h.queue.cancel(job.id);
    assert.equal(foldedJob(h, job.id)?.status, "cancelled");
    assert.equal(fake.cancelCount, 1);
    assert.equal(h.ledger.entries.length, 1);
    assert.equal(h.ledger.entries[0]!.outcome, "cancelled");
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
    await until(() => foldedJob(h, job.id)?.status === "succeeded");
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
    await until(() => foldedJob(h, job.id)?.status === "succeeded");
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
    await until(() => h.queue.queueStatus("fake").paused);
    assert.match(h.queue.queueStatus("fake").reason!, /no credential/);
    assert.equal(foldedJob(h, job.id)?.status, "queued");
    assert.equal(fake.submitCount, 0);
    h.queue.dispose();
  });
});
