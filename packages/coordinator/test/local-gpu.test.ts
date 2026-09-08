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
    listModels: async () => [{id:"ollama/gemma4",displayName:"Gemma",provider:"ollama"}],
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
    await adapter.createSession({purpose:"ask",title:"unknown-default"});
    await adapter.dispatchAsync({sessionId:"unknown-default",parts:[]});
    for (const title of ["failed-catalogue", "missing-catalogue"]) {
      raw.listModels = title === "failed-catalogue" ? async () => { throw new Error("model discovery unavailable"); } : undefined;
      await adapter.createSession({purpose:"ask",title});
      await adapter.dispatchAsync({sessionId:title,parts:[]});
    }
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
    await until(() => ["unknown-default", "failed-catalogue", "missing-catalogue"].every(id => sent.includes(id)),
      "unknown defaults and unavailable discovery reserve the card without blocking the turn");
  } finally { generation(); finish?.(); gpu.stop(); stop.abort(); await observe; await adapter.dispose!(); }
});

it("keeps pending recovery reservations alive when cancellation is not acknowledged", async () => {
  for (const held of [false, true]) {
    const dir = await tempDir("arke-gpu-recovery-cancel-");
    let recovering = false, finishUnload: (() => void) | undefined, recoverySignal: AbortSignal | undefined;
    const gpu = new LocalGpu(async (engine, signal) => {
      if (recovering && engine === "Ollama") {
        recoverySignal = signal;
        await new Promise<void>(resolve => { finishUnload = resolve; });
      }
    });
    const client = new FakeProvider();
    client.poll = async () => {
      if (held) throw new Error("HTTP 401 credential rejected while polling");
      return {state:"running"};
    };
    const options: ConstructorParameters<typeof JobQueue>[0] = {
      journalPath:join(dir,"jobs.jsonl"), clients:{comfyui:client}, getKey:async()=>"", emit:()=>{},
      landInWorld:async(_world,work)=>{await work(dir);return true;},
      ledger:{readJobIds:async()=>new Set(),has:async()=>false,append:async()=>{}},
      acquireLocalGpu:(_job,signal,waiting)=>gpu.acquire("ComfyUI",signal,waiting), pollIntervalMs:1, baseIntervalMs:1,
    };
    let queue = new JobQueue(options);
    await queue.start();
    try {
      const job = await queue.enqueue({worldId:"01J8F3K2QW9VZX4N7M0RTYB6HC",target:{kind:"shot",id:"sh_12"},
        capability:"image",provider:"comfyui",model:"test",params:{},estimatedMicroUsd:0});
      await until(() => held ? Boolean(queue.queueStatus("comfyui").paused) : queue.listJobs()[0]?.status === "running", "running job");
      queue.dispose(); await queue.waitForIdle(); await queue.drain();
      recovering = true;
      queue = new JobQueue(options);
      await queue.start();
      await until(() => recoverySignal !== undefined, "recovery handover started");
      let writingStarted = false;
      const writing = gpu.acquire("Ollama", new AbortController().signal).then(release => { writingStarted = true; return release; });
      void writing.catch(() => {}); // Let teardown reject the waiter if an assertion fails.
      const cancel = client.cancel.bind(client);
      client.cancel = async () => { throw new Error("cancel connection lost"); };
      await queue.cancel(job.id);
      assert.equal(queue.listJobs()[0]?.status, "running");
      assert.equal(recoverySignal!.aborted, false);
      assert.equal(writingStarted, false);
      if (!held) {
        finishUnload!();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(writingStarted, false);
      }
      client.cancel = cancel;
      await queue.cancel(job.id);
      assert.equal(queue.listJobs()[0]?.status, "cancelled");
      finishUnload!();
      (await writing)();
      assert.equal(client.submitCount, 1);
    } finally { finishUnload?.(); gpu.stop(); queue.dispose(); await queue.waitForIdle(); await queue.drain(); }
  }
});

it("retains a fault-held generation's GPU through resumed polling and unacknowledged cancellation", async () => {
  for (const outcome of ["resume", "cancel", "recovery"] as const) {
    const dir=await tempDir("arke-gpu-held-");
    const unloaded: string[]=[];
    const gpu=new LocalGpu(async engine => {unloaded.push(engine);});
    const client=new FakeProvider();
    client.pollError=new Error("HTTP 401 credential rejected while polling");
    const options: ConstructorParameters<typeof JobQueue>[0]={journalPath:join(dir,"jobs.jsonl"),clients:{comfyui:client},getKey:async()=>"",emit:()=>{},
      landInWorld:async(_world,work)=>{await work(dir);return true;},
      ledger:{readJobIds:async()=>new Set(),has:async()=>false,append:async()=>{}},
      acquireLocalGpu:(_job,signal,waiting)=>gpu.acquire("ComfyUI",signal,waiting),pollIntervalMs:1,baseIntervalMs:1};
    let queue=new JobQueue(options);
    await queue.start();
    try {
      const job=await queue.enqueue({worldId:"01J8F3K2QW9VZX4N7M0RTYB6HC",target:{kind:"shot",id:"sh_12"},capability:"image",provider:"comfyui",model:"test",params:{},estimatedMicroUsd:0});
      await until(()=>queue.queueStatus("comfyui").paused,"provider hold");
      await queue.waitForIdle();
      if(outcome==="recovery") {
        queue.dispose();await queue.drain();
        queue=new JobQueue(options);
        await queue.start();await queue.waitForIdle();
      }
      let writingStarted=false;
      const writing=gpu.acquire("Ollama",new AbortController().signal).then(release=>{writingStarted=true;return release;});
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(writingStarted,false);
      assert.deepEqual(unloaded,outcome==="recovery"?["Ollama","Ollama"]:["Ollama"]);
      if(outcome!=="cancel") {
        client.pollError=null;
        queue.resume("comfyui");
        await until(()=>queue.listJobs().find(j=>j.id===job.id)?.status==="succeeded","resumed job settles");
      } else {
        const cancel=client.cancel.bind(client);
        client.cancel=async()=>{throw new Error("cancel connection lost");};
        await queue.cancel(job.id);
        assert.equal(queue.listJobs().find(j=>j.id===job.id)?.status,"running");
        assert.equal(writingStarted,false);
        client.cancel=cancel;
        await queue.cancel(job.id);
        assert.equal(queue.listJobs().find(j=>j.id===job.id)?.status,"cancelled");
      }
      (await writing)();
      assert.equal(client.submitCount,1);
      assert.deepEqual(unloaded,outcome==="recovery"?["Ollama","Ollama","ComfyUI"]:["Ollama","ComfyUI"]);
    } finally {gpu.stop();queue.dispose();await queue.waitForIdle();await queue.drain();}
  }
});
