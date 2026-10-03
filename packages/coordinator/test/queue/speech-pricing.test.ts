import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { quoteGroupedSpeech, quoteSpeech, type Job, type LedgerEntry, type ManifestModel, type SpeechUsage } from "@arke-studio/contracts";
import { JobQueue, type DispatchClient, type EnqueueInput } from "../../src/queue/dispatcher.js";
import { JobJournal } from "../../src/queue/journal.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";

const model: ManifestModel = { id: "token-reader", provider: "elevenlabs", capability: "voice-tts", displayName: "Token reader",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {},
  pricing: { kind: "perToken", microUsdPerMillionInput: 500000, microUsdPerMillionOutput: 9000000,
    speech: { tier: "standard", maxInputTokens: 8192, maxOutputTokens: 16384, audioTokensPerSecond: 25, rates: [
      { version: "intro", effectiveFrom: "2026-09-01T00:00:00.000Z", microUsdPerMillionInput: 500000, microUsdPerMillionOutput: 9000000 },
      { version: "standard", effectiveFrom: "2027-01-01T00:00:00.000Z", microUsdPerMillionInput: 1000000, microUsdPerMillionOutput: 18000000 },
    ] } } };
const initial = "2026-12-31T23:59:59.000Z";
const input: EnqueueInput = { worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", target: { kind: "voice-preview", id: "test" },
  capability: "voice-tts", provider: model.provider, model: model.id, params: { text: "Hello" },
  estimatedMicroUsd: quoteSpeech(model, "Hello", { at: initial }).expectedMicroUsd };

async function harness(usage?: SpeechUsage, state: "succeeded" | "failed" = "succeeded", inline = false, afterAppend?: (job: Job) => Promise<void>) {
  const dir = await tempDir("arke-speech-price-");
  const ledger: LedgerEntry[] = [];
  let now = initial;
  let submissions = 0;
  let expire = false;
  const client: DispatchClient = {
    declarations: { supportsIdempotencyKey: false, supportsLookupByKey: false, supportsListRecent: false, reportsCost: false },
    submit: async () => { submissions++; return { remoteId: "remote-1", ...(inline ? { artifacts: [], speechUsage: usage } : {}) }; },
    poll: async () => ({ state, speechUsage: usage }), fetchArtifacts: async () => [], cancel: async () => {},
  };
  const journal = new JobJournal(join(dir, "jobs.jsonl"));
  const create = () => new JobQueue({ journalPath: join(dir, "jobs.jsonl"), clients: { elevenlabs: client }, getKey: async () => "test",
    ...(afterAppend ? { journal: { append: async (job: Job) => { await journal.append(job); await afterAppend(job); }, readHistory: () => journal.readHistory(), drain: () => journal.drain() } } : {}),
    emit: () => {}, speechModel: () => model, clock: () => now,
    beforeSubmit: async () => { if (expire) now = "2027-01-01T00:00:00.000Z"; },
    ledger: { readJobIds: async () => new Set(ledger.map(e => e.jobId)), has: async id => ledger.some(e => e.jobId === id), append: async entry => { ledger.push(entry); } },
    landInWorld: async (_id, fn) => { await fn(dir); return true; }, baseIntervalMs: 1, pollIntervalMs: 1 });
  const queue = create();
  await queue.start();
  return { queue, create, client, ledger, dir, submissions: () => submissions, expire: () => { expire = true; } };
}

it("never repeats an uncertain voice creation after restart and retains its estimate basis", async () => {
  const h = await harness();
  let calls = 0;
  h.client.submit = async (_key, request) => { assert.equal(request.voiceDesign, true); calls++; throw new Error("lost response"); };
  try {
    // Voice design approves its allowance, the service limits (R-19), as the coordinator sends it.
    await h.queue.enqueue({ ...input, target: { kind: "voice-design" }, params: { text: "A warm storyteller", operation: "voice-design" }, estimatedMicroUsd: 151552 });
    await until(() => h.queue.listJobs()[0]?.status === "needs-reconciliation", "uncertain creation", 30000);
    assert.equal(h.queue.listJobs()[0]?.speechQuote?.costBasis, "estimate");
    h.queue.dispose();
    const restored = h.create();
    try { await restored.start(); assert.equal(restored.listJobs()[0]?.status, "needs-reconciliation"); assert.equal(calls, 1); }
    finally { restored.dispose(); }
  } finally { h.queue.dispose(); }
});

it("refuses under-authorised token speech and rechecks rates after asynchronous preparation", async () => {
  const h = await harness();
  try {
    await assert.rejects(h.queue.enqueue({ ...input, estimatedMicroUsd: 0 }), /pricing changed/);
    h.expire();
    const job = await h.queue.enqueue(input);
    await until(() => h.ledger.length === 1, "expired quote", 30000);
    assert.equal(h.submissions(), 0);
    assert.match(h.queue.listJobs().find(j => j.id === job.id)!.error!, /quote expired/);
    assert.equal(h.ledger[0]!.actualMicroUsd, null);
  } finally { h.queue.dispose(); }
});

// 2026-10-03: a chapter was asked $18.49 because each block's estimate was its service-limit
// authorisation. The job carries the estimate the author approved; the quote keeps the cap.
it("carries the approved estimate to the ledger and keeps the service limits as the cap", async () => {
  const h = await harness({ inputTextTokens: 3, outputAudioTokens: 250 }, "succeeded", true);
  try {
    const words = "The harbour remembers every story. Listen closely, and a new world begins.";
    const estimate = quoteSpeech(model, words, { at: initial }).expectedMicroUsd;
    assert.ok(estimate > 0 && estimate < 151552 / 20);
    await assert.rejects(h.queue.enqueue({ ...input, params: { text: words }, estimatedMicroUsd: estimate - 1 }), /pricing changed/);
    // A sentence the screen left out of its figure never refuses the read: the guard prices the words.
    const job = await h.queue.enqueue({ ...input, params: { text: words, instructions: "Read warmly and gently." }, estimatedMicroUsd: estimate });
    assert.equal(job.estimatedMicroUsd, estimate);
    assert.equal(job.speechQuote!.authorisedMicroUsd, 151552, "the service limits are the cap");
    assert.ok(job.speechQuote!.expectedMicroUsd >= estimate);
    assert.ok(job.speechQuote!.quantities.inputTextTokens! > quoteSpeech(model, words, { at: initial }).quantities.inputTextTokens!, "the style is counted in the record");
    await until(() => h.ledger.length === 1, "settlement", 30000);
    assert.equal(h.ledger[0]!.estimatedMicroUsd, estimate);
    assert.equal(h.ledger[0]!.actualMicroUsd, 2252, "the actual is the reported usage, as before");
    assert.equal(h.ledger[0]!.actualSource, "usage-derived");
  } finally { h.queue.dispose(); }
});

for (const inline of [true, false]) it(`persists reported usage before settlement (${inline ? "unary" : "poll"}) and replays a missing ledger once`, async () => {
  const h = await harness({ inputTextTokens: 3, outputAudioTokens: 250 }, "succeeded", inline);
  try {
    await h.queue.enqueue(input);
    await until(() => h.ledger.length === 1, "usage settlement", 30000);
    assert.equal(h.ledger[0]!.actualMicroUsd, 2252);
    assert.equal(h.ledger[0]!.actualSource, "usage-derived");
    h.queue.dispose();
    const rows = (await readFile(join(h.dir, "jobs.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Job);
    assert.deepEqual(rows.at(-1)!.speechUsage, { inputTextTokens: 3, outputAudioTokens: 250 });
    h.ledger.length = 0;
    const restored = h.create();
    try { await restored.start(); assert.equal(h.ledger.length, 1); assert.equal(h.ledger[0]!.actualMicroUsd, 2252); }
    finally { restored.dispose(); }
    const again = h.create();
    try { await again.start(); assert.equal(h.ledger.length, 1); assert.equal(h.submissions(), 1); }
    finally { again.dispose(); }
  } finally { h.queue.dispose(); }
});

it("keeps partial usage unknown and prices a failed call when complete usage is reported", async () => {
  for (const usage of [{ outputAudioTokens: 250 }, { inputTextTokens: 3, outputAudioTokens: 250 }]) {
    const h = await harness(usage, "failed");
    try {
      await h.queue.enqueue(input);
      await until(() => h.ledger.length === 1, "failed speech", 30000);
      assert.equal(h.ledger[0]!.actualMicroUsd, usage.inputTextTokens === undefined ? null : 2252);
      assert.equal(h.submissions(), 1);
    } finally { h.queue.dispose(); }
  }
});

it("holds an uncertain result with its durable usage without submitting again", async () => {
  const h = await harness({ inputTextTokens: 3, outputAudioTokens: 250 }, "succeeded", true);
  try {
    const made = await h.queue.enqueue(input);
    await until(() => h.ledger.length === 1, "first result", 30000);
    h.queue.dispose();
    // Simulate a process that stopped after the durable usage row, before an audio result was
    // durably completed. With no result to recover it must hold, never repeat the paid call.
    const job = h.queue.listJobs().find(j => j.id === made.id)!;
    await writeFile(join(h.dir, "jobs.jsonl"), JSON.stringify({ ...job, status: "submitting", providerJobId: null, finalization: undefined }) + "\n");
    h.ledger.length = 0;
    const restored = h.create();
    try {
      await restored.start();
      assert.equal(restored.listJobs()[0]!.status, "needs-reconciliation");
      assert.deepEqual(restored.listJobs()[0]!.speechUsage, { inputTextTokens: 3, outputAudioTokens: 250 });
      assert.equal(h.submissions(), 1);
    } finally { restored.dispose(); }
  } finally { h.queue.dispose(); }
});

it("merges separately reported input and output counts across polls", async () => {
  const h = await harness();
  let polls = 0;
  h.client.poll = async () => ++polls === 1
    ? { state: "running", speechUsage: { inputTextTokens: 3 } }
    : { state: "succeeded", speechUsage: { inputTextTokens: undefined, outputAudioTokens: 250 } };
  try {
    await h.queue.enqueue(input);
    await until(() => h.ledger.length === 1, "partial usage", 30000);
    assert.equal(h.ledger[0]!.actualMicroUsd, 2252);
    assert.deepEqual(h.ledger[0]!.speechUsage, { inputTextTokens: 3, outputAudioTokens: 250 });
  } finally { h.queue.dispose(); }
});

it("settles a witnessed unary failure with reported usage without polling or retrying", async () => {
  const h = await harness();
  h.client.submit = async () => ({ remoteId: "incomplete-read", error: "The model reached its output limit",
    speechUsage: { inputTextTokens: 3, outputAudioTokens: 250 } });
  h.client.poll = async () => { throw new Error("A witnessed unary failure must not be polled"); };
  try {
    await h.queue.enqueue(input);
    await until(() => h.ledger.length === 1, "incomplete unary speech", 30000);
    assert.equal(h.queue.listJobs()[0]!.status, "failed");
    assert.equal(h.queue.listJobs()[0]!.attempt, 1);
    assert.equal(h.ledger[0]!.actualMicroUsd, 2252);
    assert.equal(h.ledger[0]!.actualSource, "usage-derived");
  } finally { h.queue.dispose(); }
});

it("does not flush empty or unchanged usage snapshots on every poll", async () => {
  const h = await harness();
  const rows: number[] = [];
  h.client.poll = async () => {
    rows.push((await readFile(join(h.dir, "jobs.jsonl"), "utf8")).trim().split("\n").length);
    return rows.length < 5
      ? { state: "running", speechUsage: rows.length < 3 ? {} : { inputTextTokens: 3 } }
      : { state: "succeeded", speechUsage: { outputAudioTokens: 250 } };
  };
  try {
    await h.queue.enqueue(input);
    await until(() => h.ledger.length === 1, "unchanged usage", 30000);
    assert.deepEqual(rows.map(n => n - rows[0]!), [0, 0, 0, 1, 1]);
    assert.equal(h.ledger[0]!.actualMicroUsd, 2252);
  } finally { h.queue.dispose(); }
});

it("retains known earlier cost when a resubmission expires before provider I/O", async () => {
  const h = await harness({ inputTextTokens: 3, outputAudioTokens: 250 }, "succeeded", true);
  try {
    await h.queue.enqueue(input);
    await until(() => h.ledger.length === 1, "first result", 30000);
    h.queue.dispose();
    const job = h.queue.listJobs()[0]!;
    await writeFile(join(h.dir, "jobs.jsonl"), JSON.stringify({ ...job, status: "needs-reconciliation", providerJobId: null, finalization: undefined }) + "\n");
    h.ledger.length = 0;
    const restored = h.create();
    try {
      await restored.start();
      h.expire();
      await restored.resolveHeld(job.id, "resubmit");
      await until(() => h.ledger.length === 1, "expired retry", 30000);
      assert.equal(h.submissions(), 1);
      assert.equal(h.ledger[0]!.actualMicroUsd, 2252);
      assert.equal(h.ledger[0]!.actualSource, "usage-derived");
    } finally { restored.dispose(); }
  } finally { h.queue.dispose(); }
});

it("a poll returning usage during cancellation cannot resurrect the job", async () => {
  const h = await harness();
  let answer: ((result: Awaited<ReturnType<DispatchClient["poll"]>>) => void) | undefined;
  let cancelled: (() => void) | undefined;
  h.client.poll = () => new Promise(resolve => { answer = resolve; });
  h.client.cancel = () => new Promise(resolve => { cancelled = resolve; });
  try {
    const job = await h.queue.enqueue(input);
    await until(() => answer !== undefined, "poll waiting", 30000);
    const stopping = h.queue.cancel(job.id);
    await until(() => cancelled !== undefined, "remote cancel waiting", 30000);
    answer!({ state: "succeeded", speechUsage: { inputTextTokens: 3, outputAudioTokens: 250 } });
    cancelled!();
    await stopping;
    assert.equal(h.queue.listJobs()[0]!.status, "cancelled");
    assert.equal(h.ledger.length, 1);
    assert.equal(h.ledger[0]!.outcome, "cancelled");
    const rows = (await readFile(join(h.dir, "jobs.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Job);
    assert.equal(rows.at(-1)!.status, "cancelled");
  } finally { answer?.({ state: "cancelled" }); cancelled?.(); h.queue.dispose(); }
});

it("explicit resubmission preserves earlier charges and keeps any unmeasured attempt unknown", async () => {
  for (const earlier of [{ inputTextTokens: 3, outputAudioTokens: 250 }, {}]) {
    const h = await harness({ inputTextTokens: 3, outputAudioTokens: 250 }, "succeeded", true);
    try {
      const made = await h.queue.enqueue(input);
      await until(() => h.ledger.length === 1, "first result", 30000);
      h.queue.dispose();
      const job = h.queue.listJobs().find(j => j.id === made.id)!;
      await writeFile(join(h.dir, "jobs.jsonl"), JSON.stringify({ ...job, speechUsage: earlier, status: "needs-reconciliation", providerJobId: null, finalization: undefined }) + "\n");
      h.ledger.length = 0;
      const restored = h.create();
      try {
        await restored.start();
        await restored.resolveHeld(job.id, "resubmit");
        await until(() => h.ledger.length === 1, "second paid attempt", 30000);
        assert.equal(h.submissions(), 2);
        assert.equal(h.ledger[0]!.actualMicroUsd, "inputTextTokens" in earlier ? 4504 : null);
        assert.deepEqual(h.ledger[0]!.speechAttempts?.[0]?.usage, earlier);
      } finally { restored.dispose(); }
    } finally { h.queue.dispose(); }
  }
});

it("aggregates archived provider charges with reported or usage-derived retry costs", async () => {
  for (const mode of ["reported", "usage", "expired"] as const) {
    const h = await harness({ inputTextTokens: 3, outputAudioTokens: 250 }, "succeeded", true);
    h.client.declarations.reportsCost = true;
    h.client.submit = async () => ({ remoteId: "first", artifacts: [], costMicroUsd: 1000 });
    try {
      await h.queue.enqueue(input);
      await until(() => h.ledger.length === 1, "first reported charge", 30000);
      h.queue.dispose();
      const job = h.queue.listJobs()[0]!;
      assert.equal(h.ledger[0]!.actualMicroUsd, 1000);
      await writeFile(join(h.dir, "jobs.jsonl"), JSON.stringify({ ...job, status: "needs-reconciliation", providerJobId: null, finalization: undefined }) + "\n");
      h.ledger.length = 0;
      h.client.submit = async () => ({ remoteId: "second", artifacts: [], ...(mode === "reported" ? { costMicroUsd: 2000 } : { speechUsage: { inputTextTokens: 3, outputAudioTokens: 250 } }) });
      const restored = h.create();
      try {
        await restored.start();
        if (mode === "expired") h.expire();
        await restored.resolveHeld(job.id, "resubmit");
        await until(() => h.ledger.length === 1, "aggregate reported charge", 30000);
        assert.equal(h.ledger[0]!.speechAttempts?.[0]?.providerCostMicroUsd, 1000);
        assert.equal(h.ledger[0]!.actualMicroUsd, mode === "expired" ? 1000 : mode === "reported" ? 3000 : 3252);
        assert.equal(h.ledger[0]!.actualSource, mode === "usage" ? "mixed-measured" : "provider-reported");
      } finally { restored.dispose(); }
    } finally { h.queue.dispose(); }
  }
});

it("cancellation waits for accepted usage to finish flushing and keeps the reported cost", async () => {
  let release: (() => void) | undefined;
  let reached = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(undefined, "succeeded", true, async job => {
    if (job.status === "submitting" && job.speechUsage !== undefined) { reached = true; await gate; }
  });
  h.client.declarations.reportsCost = true;
  h.client.submit = async () => ({ remoteId: "accepted", artifacts: [], costMicroUsd: 1234.6, speechUsage: { inputTextTokens: 3, outputAudioTokens: 250 } });
  const cancelledIds: string[] = [];
  h.client.cancel = async (_key, id) => { cancelledIds.push(id); };
  try {
    const job = await h.queue.enqueue(input);
    await until(() => reached, "usage flushing", 30000);
    let finished = false;
    const cancellation = h.queue.cancel(job.id).then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    release!();
    await cancellation;
    assert.deepEqual(cancelledIds, ["accepted"]);
    assert.equal(h.ledger[0]!.actualMicroUsd, 1235);
    assert.equal(h.ledger[0]!.actualSource, "provider-reported");
    assert.deepEqual(h.ledger[0]!.speechUsage, { inputTextTokens: 3, outputAudioTokens: 250 });
    const rows = (await readFile(join(h.dir, "jobs.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Job);
    assert.equal(rows.at(-1)!.status, "cancelled");
    assert.equal(rows.at(-1)!.providerCostMicroUsd, 1235);
  } finally { release?.(); h.queue.dispose(); }
});

it("ledger recovery trusts a persisted charge after the provider declaration changes", async () => {
  const h = await harness(undefined, "succeeded", true);
  h.client.declarations.reportsCost = true;
  h.client.submit = async () => ({ remoteId: "reported", artifacts: [], costMicroUsd: 1234.6 });
  try {
    await h.queue.enqueue(input);
    await until(() => h.ledger.length === 1, "first ledger", 30000);
    assert.equal(h.ledger[0]!.actualMicroUsd, 1235);
    h.queue.dispose();
    h.ledger.length = 0;
    h.client.declarations.reportsCost = false;
    const restored = h.create();
    try {
      await restored.start();
      assert.equal(h.ledger[0]!.actualMicroUsd, 1235);
      assert.equal(h.ledger[0]!.actualSource, "provider-reported");
    } finally { restored.dispose(); }
  } finally { h.queue.dispose(); }
});


it("captures an accepted submit while cancellation is flushing without reviving the job", async () => {
  let release: (() => void) | undefined;
  let reached = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(undefined, "succeeded", true, async job => {
    if (job.status === "cancelled" && !reached) { reached = true; await gate; }
  });
  let answer: ((result: Awaited<ReturnType<DispatchClient["submit"]>>) => void) | undefined;
  h.client.submit = () => new Promise(resolve => { answer = resolve; });
  const cancelledIds: string[] = [];
  h.client.cancel = async (_key, id) => { cancelledIds.push(id); };
  try {
    const job = await h.queue.enqueue(input);
    await until(() => answer !== undefined, "submit waiting", 30000);
    const cancellation = h.queue.cancel(job.id);
    await until(() => reached, "cancelled row flushing", 30000);
    answer!({ remoteId: "accepted-during-cancel", artifacts: [], speechUsage: { inputTextTokens: 3, outputAudioTokens: 250 } });
    await until(() => cancelledIds.includes("accepted-during-cancel"), "cancel accepted request", 30000);
    release!();
    await cancellation;
    assert.equal(h.ledger.length, 1);
    assert.equal(h.ledger[0]!.actualMicroUsd, 2252);
    assert.equal(h.ledger[0]!.outcome, "cancelled");
    const rows = (await readFile(join(h.dir, "jobs.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Job);
    assert.equal(rows.at(-1)!.status, "cancelled");
    assert.equal(rows.at(-1)!.providerJobId, "accepted-during-cancel");
    assert.deepEqual(rows.at(-1)!.speechUsage, { inputTextTokens: 3, outputAudioTokens: 250 });
  } finally { release?.(); answer?.({ remoteId: "cleanup" }); h.queue.dispose(); }
});

for (const lookup of [false, true]) it(`recovers a persisted accepted id before lookup or resubmission (lookup: ${lookup})`, async () => {
  const h = await harness({ inputTextTokens: 3, outputAudioTokens: 250 }, "succeeded", false);
  try {
    await h.queue.enqueue(input);
    await until(() => h.ledger.length === 1, "first result", 30000);
    h.queue.dispose();
    const job = h.queue.listJobs()[0]!;
    await writeFile(join(h.dir, "jobs.jsonl"), JSON.stringify({ ...job, status: "submitting", finalization: undefined }) + "\n");
    h.ledger.length = 0;
    let lookups = 0;
    h.client.declarations.supportsIdempotencyKey = lookup;
    h.client.declarations.supportsLookupByKey = lookup;
    h.client.lookupByKey = async () => { lookups++; return null; };
    const restored = h.create();
    try {
      await restored.start();
      await until(() => h.ledger.length === 1, "recovered result", 30000);
      assert.equal(h.submissions(), 1);
      assert.equal(lookups, 0);
      assert.equal(h.ledger[0]!.actualMicroUsd, 2252);
    } finally { restored.dispose(); }
  } finally { h.queue.dispose(); }
});


it("holds a lost inline result without polling or repeating a paid submission", async () => {
  const h = await harness({ inputTextTokens: 3, outputAudioTokens: 250 }, "succeeded", true);
  try {
    await h.queue.enqueue(input);
    await until(() => h.ledger.length === 1, "first inline result", 30000);
    h.queue.dispose();
    const job = h.queue.listJobs()[0]!;
    assert.equal(job.providerResultKind, "inline");
    await writeFile(join(h.dir, "jobs.jsonl"), JSON.stringify({ ...job, status: "submitting", finalization: undefined }) + "\n");
    h.ledger.length = 0;
    let polls = 0;
    h.client.poll = async () => { polls++; return { state: "failed", error: "inline only" }; };
    const restored = h.create();
    try {
      await restored.start();
      assert.equal(restored.listJobs()[0]!.status, "needs-reconciliation");
      assert.match(restored.listJobs()[0]!.error!, /inline result was not saved/);
      assert.equal(polls, 0);
      assert.equal(h.submissions(), 1);
      assert.equal(h.ledger.length, 0);
    } finally { restored.dispose(); }
  } finally { h.queue.dispose(); }
});

// Design turn 185: a grouped read is one request, quoted once with every turn's style and capped at the service limits.
it("quotes a grouped read once, its words and every turn's style, and sends its turns as they were quoted", async () => {
  const h = await harness({ inputTextTokens: 20, outputAudioTokens: 300 }, "succeeded", true);
  try {
    const turns = [{ text: "The first block.", instructions: "Whisper." }, { text: "The second block.", instructions: "Shout." }];
    const text = turns.map((turn) => turn.text).join(" ");
    const quote = quoteGroupedSpeech(model, turns, { at: initial });
    const sent: unknown[] = [];
    h.client.submit = async (_key, request) => { sent.push(request.params["turns"]); return { remoteId: "remote-1", artifacts: [], speechUsage: { inputTextTokens: 20, outputAudioTokens: 300 } }; };
    const job = await h.queue.enqueue({ ...input, params: { text, turns }, estimatedMicroUsd: quote.expectedMicroUsd });
    assert.deepEqual(job.speechQuote, quote);
    assert.ok(job.speechQuote!.quantities.inputTextTokens! > quoteSpeech(model, text, { at: initial }).quantities.inputTextTokens!, "every style is counted");
    assert.equal(job.speechQuote!.authorisedMicroUsd, 151552, "one request, capped at the service limits");
    await until(() => h.ledger.length === 1, "grouped settlement", 30000);
    assert.deepEqual(sent, [turns]);
  } finally { h.queue.dispose(); }
});
