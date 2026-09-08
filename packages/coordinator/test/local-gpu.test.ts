import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { HarnessAdapter, HarnessEvent } from "@arke-studio/contracts";
import { LocalGpu } from "../src/local-ai/gpu.js";
import { withLocalGpu } from "../src/harness/local-gpu.js";
import { JobQueue } from "../src/queue/dispatcher.js";
import { FakeProvider, pngBytes } from "./queue/fake-provider.js";
import { tempDir } from "./tmp.js";
import { until } from "./wait.js";

it("hands over in order, awaits unloading, and cancels waiting work without taking the card", async () => {
  const unloaded: string[] = [];
  const gpu = new LocalGpu(async (engine) => { unloaded.push(engine); });
  const held = await gpu.acquire("Ollama", new AbortController().signal);
  const cancelled = new AbortController();
  const waits: Array<string | null> = [];
  const first = gpu.acquire("ComfyUI", cancelled.signal, (reason) => waits.push(reason));
  const rejected = assert.rejects(first, /cancelled/);
  const next = gpu.acquire("ComfyUI", new AbortController().signal);
  assert.deepEqual(unloaded, ["ComfyUI"]);
  assert.ok(waits.includes("Waiting for the graphics card: Ollama"));
  cancelled.abort(new Error("cancelled"));
  await rejected;
  held();
  const release = await next;
  assert.deepEqual(unloaded, ["ComfyUI", "Ollama"]);
  const stopped = assert.rejects(gpu.acquire("Ollama", new AbortController().signal), /stopping/);
  gpu.stop();
  await stopped;
  release();
  await assert.rejects(gpu.acquire("Ollama", new AbortController().signal), /stopping/);

  let finish!: () => void;
  const gated = new LocalGpu(() => new Promise<void>((resolve) => { finish = resolve; }));
  let acquired = false;
  const acquiring = gated.acquire("Ollama", new AbortController().signal).then((done) => { acquired = true; return done; });
  await until(() => finish !== undefined, "unload started");
  assert.equal(acquired, false);
  finish(); (await acquiring)(); gated.stop();

  let attempts = 0;
  const faulty = new LocalGpu(async () => { if (++attempts === 1) throw new Error("Ollama could not release its models"); });
  await assert.rejects(faulty.acquire("ComfyUI", new AbortController().signal), /Ollama/);
  (await faulty.acquire("ComfyUI", new AbortController().signal))();
  faulty.stop();
});

it("keeps a generation queued and unattempted behind writing, and never submits a cancelled waiter", async () => {
  const dir = await tempDir("arke-gpu-queue-");
  const gpu = new LocalGpu(async () => {});
  const writing = await gpu.acquire("Ollama", new AbortController().signal);
  const client = new FakeProvider();
  client.artifacts = [{ name: "image.png", contentType: "image/png", data: pngBytes() }];
  const queue = new JobQueue({
    journalPath: join(dir, "jobs.jsonl"), clients: { comfyui: client }, getKey: async () => "",
    emit: () => {}, ledger: { readJobIds: async () => new Set(), has: async () => false, append: async () => {} },
    landInWorld: async (_id, work) => { await work(dir); return true; },
    acquireLocalGpu: (_job, signal, waiting) => gpu.acquire("ComfyUI", signal, waiting),
    pollIntervalMs: 1, baseIntervalMs: 1,
  });
  await queue.start();
  try {
    const input = { worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", target: { kind: "shot" as const, id: "sh_12" },
      capability: "image" as const, provider: "comfyui", model: "test", params: {}, estimatedMicroUsd: 0 };
    const cancelled = await queue.enqueue(input);
    const kept = await queue.enqueue(input);
    await until(() => queue.listJobs().some((job) => job.waitingFor), "GPU wait line");
    assert.equal(client.submitCount, 0);
    assert.ok(queue.listJobs().every((job) => job.status === "queued" && job.attempt === 0));
    await queue.cancel(cancelled.id);
    writing();
    await until(() => queue.listJobs().find((job) => job.id === kept.id)?.status === "succeeded", "generation completion");
    assert.equal(client.submitCount, 1);
    assert.equal(queue.listJobs().find((job) => job.id === cancelled.id)?.status, "cancelled");
    assert.ok(!(await readFile(join(dir, "jobs.jsonl"), "utf8")).includes("waitingFor"));
  } finally { writing(); gpu.stop(); queue.dispose(); await queue.waitForIdle(); await queue.drain(); }
});

it("holds the card for an async harness turn, reports its wait, and lets an explicit cloud turn pass", async () => {
  const gpu = new LocalGpu(async () => {});
  const generation = await gpu.acquire("ComfyUI", new AbortController().signal);
  const sent: string[] = [];
  let finish!: () => void;
  const raw: HarnessAdapter = {
    id: "test", capabilities: () => new Set(), readiness: () => ({ ready: true }),
    createSession: async (input) => ({ sessionId: input.title! }),
    sendMessage: async (input) => {
      sent.push(input.sessionId);
      if (input.sessionId === "local") await new Promise<void>((resolve) => { finish = resolve; });
      return { sessionId: input.sessionId, correlationId: "test" };
    },
    dispatchAsync: async () => { throw new Error("sendMessage owns completion"); },
    streamEvents: (signal) => ({ async *[Symbol.asyncIterator]() {
      if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "session.ended", sessionId: "test", reason: "cancelled" } as const;
    } }),
  };
  const adapter = withLocalGpu(raw, gpu);
  const stop = new AbortController();
  const seen: HarnessEvent[] = [];
  const observe = (async () => { for await (const event of adapter.streamEvents(stop.signal)) seen.push(event); })();
  try {
    for (const [title, model] of [["local", "ollama/gemma4"], ["cloud", "anthropic/claude"]]) {
      adapter.prepareSession!({ preparationId: title!, model: model! });
      await adapter.createSession({ purpose: "ask", title, preparationId: title });
    }
    await adapter.dispatchAsync({ sessionId: "local", parts: [] });
    await adapter.sendMessage({ sessionId: "cloud", parts: [] });
    await until(() => seen.some((event) => event.type === "tool.activity" && event.summary.includes("ComfyUI")), "writing wait line");
    assert.deepEqual(sent, ["cloud"]);
    generation();
    await until(() => sent.includes("local"), "local turn admitted");
    let nextAcquired = false;
    const next = gpu.acquire("ComfyUI", new AbortController().signal).then((release) => { nextAcquired = true; return release; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nextAcquired, false);
    finish(); (await next)();
  } finally { generation(); finish?.(); gpu.stop(); stop.abort(); await observe; await adapter.dispose!(); }
});
