import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { applyProviderPlans, PAID_PLANS, quoteSpeech, type Job, type LedgerEntry, type ManifestModel, type SpeechUsage } from "@arke-studio/contracts";
import { GoogleClient, ProviderFreeLimitError, ProviderPaymentRequiredError } from "@arke-studio/providers";
import { JobQueue, type DispatchClient, type EnqueueInput, type JobQueueOptions } from "../../src/queue/dispatcher.js";
import { classifyError } from "../../src/queue/classify.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";

// Design turn 182: reads on a key the author marked free, through the queue.

const gemini: ManifestModel = { id: "gemini-3.8-flash-tts", provider: "google", capability: "voice-tts", displayName: "Gemini 3.8 Flash TTS",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {},
  pricing: { kind: "perToken", microUsdPerMillionInput: 500000, microUsdPerMillionOutput: 9000000,
    speech: { tier: "standard", maxInputTokens: 8192, maxOutputTokens: 16384, audioTokensPerSecond: 25, rates: [
      { version: "gemini-3.8-flash-standard-2026-09-27", effectiveFrom: "2026-09-27T00:00:00.000Z", microUsdPerMillionInput: 500000, microUsdPerMillionOutput: 9000000 },
    ] } } };
const voxtral: ManifestModel = { id: "voxtral-mini-tts", provider: "mistral", capability: "voice-tts", displayName: "Voxtral TTS",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perCharacter", microUsdPerCharacter: 16 } };
const manifest = { manifestVersion: 1, generated: "2026-10-02", models: [gemini, voxtral] };
const freeGoogle = applyProviderPlans(manifest, { ...PAID_PLANS, google: "free" });
const creditMistral = applyProviderPlans(manifest, { ...PAID_PLANS, mistral: "free-credit" });
const now = "2026-10-02T09:14:00.000Z";
const read = (model: ManifestModel, text = "Hello"): EnqueueInput => ({ worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", target: { kind: "voice-preview", id: "free" },
  capability: "voice-tts", provider: model.provider, model: model.id, params: { text },
  estimatedMicroUsd: quoteSpeech(model, text, { at: now }).authorisedMicroUsd });

async function harness(rows: { models: ManifestModel[] }, submit: (request: Parameters<DispatchClient["submit"]>[1]) => Promise<Awaited<ReturnType<DispatchClient["submit"]>>>, extra: Partial<JobQueueOptions> = {}) {
  const dir = await tempDir("arke-free-plan-");
  const ledger: LedgerEntry[] = [];
  const billed: Job[] = [];
  let current = rows;
  let beforeSubmit: (() => void) | null = null;
  let submissions = 0;
  const client = (usage?: SpeechUsage): DispatchClient => ({
    declarations: { supportsIdempotencyKey: false, supportsLookupByKey: false, supportsListRecent: false, reportsCost: false },
    submit: async (_key, request) => { submissions++; return submit(request); },
    poll: async () => ({ state: "succeeded", ...(usage ? { speechUsage: usage } : {}) }), fetchArtifacts: async () => [], cancel: async () => {},
  });
  const queue = new JobQueue({ journalPath: join(dir, "jobs.jsonl"), clients: { google: client(), mistral: client() }, getKey: async () => "test",
    emit: () => {}, clock: () => now,
    speechModel: (provider, id) => current.models.find((model) => model.provider === provider && model.id === id),
    onFreePlanBilled: (job) => { billed.push(job); },
    beforeSubmit: async () => { beforeSubmit?.(); },
    ledger: { readJobIds: async () => new Set(ledger.map(e => e.jobId)), has: async id => ledger.some(e => e.jobId === id), append: async entry => { ledger.push(entry); } },
    landInWorld: async (_id, fn) => { await fn(dir); return true; }, baseIntervalMs: 1, pollIntervalMs: 1, maxAttempts: 3, ...extra });
  await queue.start();
  return { queue, ledger, billed, submissions: () => submissions, switchTo: (next: { models: ManifestModel[] }) => { beforeSubmit = () => { current = next; }; } };
}

it("records a free-plan read at $0 with its usage, asking for no authorisation", async () => {
  const h = await harness(freeGoogle, async () => ({ remoteId: "google-inline:1", acceptedAt: now, artifacts: [], speechUsage: { inputTextTokens: 4, outputAudioTokens: 300 } }));
  try {
    const input = read(freeGoogle.models[0]!);
    assert.equal(input.estimatedMicroUsd, 0);
    await h.queue.enqueue(input);
    await until(() => h.ledger.length === 1, "free settlement", 30000);
    assert.equal(h.ledger[0]!.actualMicroUsd, 0);
    assert.equal(h.ledger[0]!.actualSource, "free-plan");
    assert.equal(h.ledger[0]!.speechQuote?.plan, "free-plan");
    assert.deepEqual(h.ledger[0]!.speechUsage, { inputTextTokens: 4, outputAudioTokens: 300 });
    assert.equal(h.billed.length, 0);
  } finally { h.queue.dispose(); }
});

it("never sends a read quoted free once the plan is switched back to paid", async () => {
  const h = await harness(freeGoogle, async () => ({ remoteId: "google-inline:1", acceptedAt: now, artifacts: [] }));
  try {
    h.switchTo(manifest);
    const job = await h.queue.enqueue(read(freeGoogle.models[0]!));
    await until(() => h.ledger.length === 1, "refused at dispatch", 30000);
    assert.equal(h.submissions(), 0);
    assert.match(h.queue.listJobs().find(j => j.id === job.id)!.error!, /pricing changed/);
  } finally { h.queue.dispose(); }
});

it("says a free-plan read Google refused for payment is billed, and never pauses for it", async () => {
  const h = await harness(freeGoogle, async () => { throw new ProviderPaymentRequiredError("Google asked for payment for this request (HTTP 402 payment_required)"); });
  try {
    const job = await h.queue.enqueue(read(freeGoogle.models[0]!));
    await until(() => h.queue.listJobs().find(j => j.id === job.id)?.status === "failed", "billed read", 30000);
    const failed = h.queue.listJobs().find(j => j.id === job.id)!;
    assert.match(failed.error!, /^Google billed this read · key looks paid/);
    assert.equal(failed.failureClass, "terminal");
    assert.equal(h.billed.length, 1);
    assert.equal(h.submissions(), 1);
  } finally { h.queue.dispose(); }
});

it("leaves a paid key's payment refusal to the provider-fault path", () => {
  assert.equal(classifyError(new ProviderPaymentRequiredError("Google asked for payment for this request (HTTP 402 payment_required)")), "provider-fault");
});

it("does not retry the free tier's daily limit", async () => {
  assert.equal(classifyError(new ProviderFreeLimitError("Google free limit reached (HTTP 429 free daily quota)")), "terminal");
  const h = await harness(freeGoogle, async () => { throw new ProviderFreeLimitError("Google free limit reached (HTTP 429 free daily quota)"); });
  try {
    const job = await h.queue.enqueue(read(freeGoogle.models[0]!));
    await until(() => h.queue.listJobs().find(j => j.id === job.id)?.status === "failed", "free limit", 30000);
    assert.match(h.queue.listJobs().find(j => j.id === job.id)!.error!, /Google free limit reached/);
    assert.equal(h.submissions(), 1);
    assert.equal(h.billed.length, 0);
  } finally { h.queue.dispose(); }
});

// What the live service sent on 2026-10-02, through the real Google client: the per-minute code
// on the daily limit. Each of ~190 queued reads was retried four times against it.
const OBSERVED_DAILY = { error: { message: "Rate limit exceeded for model gemini-3.8-flash-tts (limit: 10 requests per day on Free Tier). Please retry in 45m28s or upgrade your tier at https://ai.dev/rate-limit.", code: "too_many_requests" } };
const SHORT = { error: { message: "Rate limit exceeded for model gemini-3.8-flash-tts (limit: 10 requests per minute). Please retry in 1s.", code: "too_many_requests" } };
const google = (body: unknown) => (request: Parameters<DispatchClient["submit"]>[1]) =>
  new GoogleClient(async () => Response.json(body, { status: 429 })).submit("test", request as never) as never;
const spoken = (text: string): EnqueueInput => { const input = read(freeGoogle.models[0]!, text); return { ...input, params: { ...input.params, voiceId: "Kore" } }; };

it("fails a read at the day's limit once, and the rest of the batch without sending them", async () => {
  const h = await harness(freeGoogle, google(OBSERVED_DAILY), { baseConcurrency: 1 });
  try {
    const jobs: Job[] = [];
    for (const text of ["One.", "Two.", "Three."]) jobs.push(await h.queue.enqueue(spoken(text)));
    const row = (id: string) => h.queue.listJobs().find((job) => job.id === id)!;
    await until(() => jobs.every((job) => row(job.id).status === "failed"), "the batch ends", 30000);
    assert.equal(h.submissions(), 1, "one request met the limit; the rest never left");
    assert.match(row(jobs[0]!.id).error!, /^Google free limit reached \(HTTP 429 free daily quota · 10 a day · resets \d{4}-/);
    for (const job of jobs.slice(1)) {
      assert.match(row(job.id).error!, /^Google free limit reached · 10 a day · resets \d{4}-\S+ · not sent$/);
      assert.equal(row(job.id).failureClass, "terminal");
      assert.equal(row(job.id).attempt, 0, "never submitted");
    }
    const limit = h.queue.freeLimitFor("google", freeGoogle.models[0]!.id);
    assert.equal(limit?.limit, 10);
    assert.ok(Date.parse(limit!.resetsAt) > Date.now() + 45 * 60_000);
    // Google's free quota is per model: another model's day is its own.
    assert.equal(h.queue.freeLimitFor("google", "gemini-3.8-flash-lite-tts"), null);
    // A new key is another project's quota.
    h.queue.forgetFreeLimits("google");
    assert.equal(h.queue.freeLimitFor("google", freeGoogle.models[0]!.id), null);
  } finally { h.queue.dispose(); }
});

it("still retries a genuine short rate limit", async () => {
  const h = await harness(freeGoogle, google(SHORT), { baseConcurrency: 1, backoffBaseMs: 1, backoffCapMs: 5 });
  try {
    const job = await h.queue.enqueue(spoken("Once more."));
    await until(() => h.queue.listJobs().find((row) => row.id === job.id)?.status === "failed", "retries spent", 30000);
    assert.equal(h.submissions(), 3, "every attempt the queue allows");
    assert.match(h.queue.listJobs().find((row) => row.id === job.id)!.error!, /gave up after 3 attempts/);
    assert.equal(h.queue.freeLimitFor("google", freeGoogle.models[0]!.id), null);
  } finally { h.queue.dispose(); }
});

it("draws a free-credit read from the allowance at its estimate, with the characters it drew", async () => {
  const h = await harness(creditMistral, async () => ({ remoteId: "mistral-1", acceptedAt: now }));
  try {
    const input = read(creditMistral.models[1]!, "Hello there");
    assert.equal(input.estimatedMicroUsd, 11 * 16);
    await h.queue.enqueue(input);
    await until(() => h.ledger.length === 1, "credit settlement", 30000);
    assert.equal(h.ledger[0]!.actualSource, "free-credit");
    assert.equal(h.ledger[0]!.actualMicroUsd, 11 * 16);
    assert.equal(h.ledger[0]!.speechQuote?.quantities.characters, 11);
  } finally { h.queue.dispose(); }
});

it("asks again about a free-credit read once the author says the key is paid", async () => {
  const h = await harness(creditMistral, async () => ({ remoteId: "mistral-1", acceptedAt: now }));
  try {
    h.switchTo(manifest);
    const job = await h.queue.enqueue(read(creditMistral.models[1]!, "Hello there"));
    await until(() => h.queue.listJobs().find(j => j.id === job.id)?.status === "failed", "refused at dispatch", 30000);
    assert.equal(h.submissions(), 0);
    assert.match(h.queue.listJobs().find(j => j.id === job.id)!.error!, /pricing changed/);
  } finally { h.queue.dispose(); }
});
