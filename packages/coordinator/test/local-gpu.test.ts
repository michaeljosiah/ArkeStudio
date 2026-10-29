import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { HarnessAdapter, HarnessEvent } from "@arke-studio/contracts";
import { LocalGpu } from "../src/local-ai/gpu.js";
import { withLocalGpu } from "../src/harness/local-gpu.js";
import { JobQueue, type DispatchClient } from "../src/queue/dispatcher.js";
import { Coordinator } from "../src/coordinator.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { FakeProvider, pngBytes } from "./queue/fake-provider.js";
import { makeTempRoot } from "./world/helpers.js";
import { tempDir } from "./tmp.js";
import { until } from "./wait.js";
import type { LocalSetupService } from "../src/setup/local-setup.js";

it("coordinator model removal uses the inference fence until the runtime confirms deletion", async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root);
  let calls = 0, finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "test", changeLogPath: join(root, "log.jsonl"),
    setup: { which: async () => null, probeUrl: async () => false, diskFreeMb: async () => 100_000,
      fetchStream: async () => { throw new Error("No download expected"); },
      run: async (_command, args) => { assert.deepEqual(args, ["rm", "fixture:model"]); calls++; await pending; return { code: 0, output: "" }; },
    },
    setupExtraEntries: [{ id: "reviewed-model", displayName: "Fixture", purpose: "Test", optional: true, engine: "ollama", sizeMb: 1,
      spec: { kind: "pull", command: "fixture", args: ["pull", "fixture:model"] } }],
  });
  const { localGpu: gpu, setup } = coordinator as unknown as { localGpu: LocalGpu; setup: LocalSetupService };
  try {
    const active = await gpu.acquire("Ollama", new AbortController().signal);
    await setup.remove("reviewed-model"); assert.equal(calls, 0); active();
    const removing = setup.remove("reviewed-model"); await until(() => calls === 1, "runtime deletion entered");
    assert(gpu.isBusy("Ollama"));
    let inferred = false; const next = gpu.acquire("Ollama", new AbortController().signal).then(release => { inferred = true; release(); });
    await Promise.resolve(); assert.equal(inferred, false);
    finish(); await removing; await next; assert(inferred); assert.equal(calls, 1);
  } finally { finish(); await coordinator.stop(); await provider.close(); }
});

it("model removal refuses active inference and holds the idle lane without an eviction", async () => {
  const unloaded: string[] = [], gpu = new LocalGpu(async engine => { unloaded.push(engine); });
  const signal = new AbortController().signal;
  const active = await gpu.acquire("Ollama", signal);
  assert.throws(() => gpu.reserveFileChange("Ollama"), /Finish or cancel/);
  active(); unloaded.length = 0;
  const release = gpu.reserveFileChange("Ollama");
  assert.throws(() => gpu.reserveFileChange("Ollama"), /Finish or cancel/);
  let entered = false;
  const next = gpu.acquire("ComfyUI", signal).then(done => { entered = true; done(); });
  await Promise.resolve(); assert.equal(entered, false); assert.deepEqual(unloaded, []);
  release(); release(); await next; assert(entered); assert.deepEqual(unloaded, ["Ollama"]);
  gpu.stop(); assert.throws(() => gpu.reserveFileChange("Ollama"), /stopping/);
});

it("runs queued creative work before background explanations without preempting the current owner", async () => {
  const gpu = new LocalGpu(async () => {}, ["Ollama", "ComfyUI", "Ming"]), signal = new AbortController().signal;
  const owner = await gpu.acquire("ComfyUI", signal), order: string[] = [];
  const next = (name: string, priority: "normal" | "background") => gpu.acquire("Ollama", signal, () => {}, priority).then(release => { order.push(name); release(); });
  const work = [next("explain-1", "background"), next("creative-1", "normal"), next("explain-2", "background"), next("creative-2", "normal")];
  assert.deepEqual(order, []); assert(gpu.isBusy("ComfyUI"));
  owner(); await Promise.all(work); assert.deepEqual(order, ["creative-1", "creative-2", "explain-1", "explain-2"]); gpu.stop();
});

it("cancels a queued background explanation without releasing the admitted owner or bypassing retained cleanup", async () => {
  const gpu = new LocalGpu(async () => {}), owner = await gpu.acquire("ComfyUI", new AbortController().signal), stop = new AbortController();
  const explanation = assert.rejects(gpu.acquire("Ollama", stop.signal, () => {}, "background"), /explanation cancelled/);
  stop.abort(new Error("explanation cancelled")); await explanation; assert(gpu.isBusy("ComfyUI"));
  let admitted = false; const creative = gpu.acquire("Ollama", new AbortController().signal).then(release => { admitted = true; release(); });
  assert.equal(admitted, false); owner(); await creative; assert(admitted); gpu.stop();
});

it("carries a prepared Studio session's background priority through the shared harness wrapper", async () => {
  const gpu = new LocalGpu(async () => {}), signal = new AbortController().signal, owner = await gpu.acquire("ComfyUI", signal), sent: string[] = [];
  const raw: HarnessAdapter = { id: "test", capabilities: () => new Set(), readiness: () => ({ ready: true }),
    createSession: async input => ({ sessionId: input.title! }),
    sendMessage: async input => { sent.push(input.sessionId); return { sessionId: input.sessionId, correlationId: "test" }; },
    dispatchAsync: async () => { throw new Error("Only the shared wrapper dispatches"); }, streamEvents: () => ({ async *[Symbol.asyncIterator]() {} }) };
  const adapter = withLocalGpu(raw, gpu);
  try {
    for (const title of ["explanation", "creative"]) {
      adapter.prepareSession!({ preparationId: title, model: "ollama/test", inferencePriority: title === "explanation" ? "background" : "normal" });
      await adapter.createSession({ purpose: "ask", title, preparationId: title });
    }
    const background = adapter.sendMessage({ sessionId: "explanation", parts: [] }), creative = adapter.sendMessage({ sessionId: "creative", parts: [] });
    assert.deepEqual(sent, []); owner(); await Promise.all([background, creative]); assert.deepEqual(sent, ["creative", "explanation"]);
  } finally { owner(); gpu.stop(); await adapter.dispose?.(); }
});

it("keeps a Ming batch on the card through cancellation and confirmed process cleanup", async () => {
  const unloaded: string[] = [];
  let finishCleanup!: () => void;
  const gpu = new LocalGpu(async engine => {
    unloaded.push(engine);
    if (engine === "Ming") await new Promise<void>(resolve => { finishCleanup = resolve; });
  }, ["Ollama", "ComfyUI", "Ming"]);
  const cancel = new AbortController();
  let started = false;
  const batch = gpu.runMingBatch(async signal => {
    started = true;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted();
  }, cancel.signal);
  const rejected = assert.rejects(batch, /cancelled/);
  await until(() => started, "Ming started after releasing other engines");
  assert.deepEqual(unloaded, ["Ollama", "ComfyUI"]);
  cancel.abort(new Error("cancelled"));
  await until(() => finishCleanup !== undefined, "Ming cleanup started");
  let admitted = false;
  const writing = gpu.acquire("Ollama", new AbortController().signal).then(release => { admitted = true; return release; });
  assert.equal(admitted, false);
  finishCleanup(); await rejected;
  // Handover rechecks every other participant, even after a previous cleanup.
  await until(() => unloaded.filter(engine => engine === "Ming").length === 2, "handover confirmation");
  finishCleanup(); (await writing)(); gpu.stop();
});

it("refuses the next job when Ming cannot confirm release", async () => {
  const gpu = new LocalGpu(async engine => { if (engine === "Ming") throw new Error("Ming exit unconfirmed"); }, ["Ollama", "ComfyUI", "Ming"]);
  await assert.rejects(gpu.runMingBatch(async () => "done", new AbortController().signal), /unconfirmed/);
  assert.equal(gpu.isBusy("Ming"), true);
  const next = assert.rejects(gpu.acquire("ComfyUI", new AbortController().signal), /stopping/);
  gpu.stop(); await next;
});

it("a newly authorized Ming reading confirms the old retained cleanup without replaying its work", async () => {
  let refuse = true, readings = 0, confirmations = 0;
  const gpu = new LocalGpu(async engine => {
    if (engine === "Ming") { confirmations++; if (refuse) throw new Error("Ming exit unconfirmed"); }
  }, ["Ollama", "ComfyUI", "Ming"]);
  try {
    await assert.rejects(gpu.runMingBatch(async () => { readings++; }, new AbortController().signal), /unconfirmed/);
    assert.equal(readings, 1); assert(gpu.isBusy("Ming"));
    await assert.rejects(gpu.runMingBatch(async () => { readings++; }, new AbortController().signal), /unconfirmed/);
    assert.equal(readings, 1, "new work stayed unsubmitted while cleanup was unknown");
    refuse = false;
    await gpu.runMingBatch(async () => { assert(confirmations >= 3); readings++; }, new AbortController().signal);
    assert.equal(readings, 2); assert(!gpu.isBusy("Ming"));
  } finally { gpu.stop(); }
});

it("drains and closes the world even when a cancelled Ming batch cannot confirm cleanup", async () => {
  const { root } = await makeTempRoot();
  let closed = false, started = false, refuse = true;
  class Provider extends FsWorldProvider {
    override async close() { await super.close(); closed = true; }
  }
  const provider = new Provider(root);
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "test",
    changeLogPath: join(root, "log.jsonl"), ming: {
      run: async (_command, signal) => { started = true; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted(); },
      unload: async () => { if (refuse) throw new Error("Ming exit unconfirmed"); },
      dispose: async () => { if (refuse) throw new Error("Ming exit unconfirmed"); },
    } });
  try {
    await coordinator.start(0);
    const batch = coordinator.generateMingBatch({ python: process.execPath, worker: join(root, "unused.py"), args: [], cacheRoot: root }, new AbortController().signal);
    const rejected = assert.rejects(batch, /unconfirmed/);
    await until(() => started, "batch entered");
    await assert.rejects(coordinator.stop(), /cleanup did not confirm/);
    await rejected;
    assert.equal(closed, true, "runtime failure did not skip world/provider close");
  } finally { refuse = false; await coordinator.stop(); await provider.close(); }
});

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

it("sends repeated default-model Claude turns without discovery or waiting for the graphics card", async () => {
  const gpu = new LocalGpu(async () => {});
  const generation = await gpu.acquire("ComfyUI", new AbortController().signal);
  let discoveries = 0;
  const sent: string[] = [];
  const raw: HarnessAdapter = {
    id: "claude", capabilities: () => new Set(["models"]), readiness: () => ({ ready: true }),
    listModels: async () => { discoveries++; throw new Error("Discovery is unavailable"); },
    createSession: async () => ({ sessionId: "default-claude" }),
    sendMessage: async input => {
      sent.push(input.sessionId);
      return { sessionId: input.sessionId, correlationId: "test" };
    },
    dispatchAsync: async () => { throw new Error("sendMessage owns completion"); },
    streamEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
  };
  const adapter = withLocalGpu(raw, gpu);
  let turns: Promise<void> | undefined;
  try {
    const session = await adapter.createSession({ purpose: "ask" });
    turns = (async () => {
      await adapter.sendMessage({ sessionId: session.sessionId, parts: [] });
      await adapter.sendMessage({ sessionId: session.sessionId, parts: [] });
    })();
    void turns.catch(() => {});
    await until(() => sent.length === 2, "Claude turns pass while ComfyUI still holds the GPU");
    await turns;
    assert.equal(discoveries, 0);
    assert.deepEqual(sent, [session.sessionId, session.sessionId]);
  } finally {
    generation(); gpu.stop();
    await turns?.catch(() => {});
    await adapter.dispose!();
  }
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

it("hands back the Ollama models this run used when quitting, only those, and never waits long on it", async () => {
  for (const scenario of ["used", "unused", "named-nothing", "unresponsive"] as const) {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root);
    const unloads: Array<{ signal: AbortSignal; only: ReadonlySet<string> | undefined }> = [];
    const ollama: DispatchClient = Object.assign(new FakeProvider(), {
      unload: (signal?: AbortSignal, only?: ReadonlySet<string>) => {
        unloads.push({ signal: signal!, only });
        // A server that never answers, and a client that ignores the abort: only the race ends it.
        return scenario === "unresponsive" ? new Promise<void>(() => {}) : Promise.resolve();
      },
      // What the dispatches asked for. Another application's model is loaded too, and is not here.
      usedModels: () => new Set(scenario === "named-nothing" ? [] : ["gemma4:12b"]),
    });
    const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "changes.jsonl"), appVersion: "test", dispatchClients: { ollama } });
    const gpu = (coordinator as unknown as { localGpu: LocalGpu }).localGpu;
    if (scenario !== "unused") (await gpu.acquire("Ollama", new AbortController().signal))();
    const handovers = unloads.length;
    const started = Date.now();
    try { await coordinator.stop(); } finally { await provider.close(); }
    assert.equal(unloads.length - handovers, scenario === "unused" || scenario === "named-nothing" ? 0 : 1, scenario);
    if (scenario === "used") assert.deepEqual([...unloads.at(-1)!.only!], ["gemma4:12b"], "only what this run named (issue 1289)");
    if (scenario === "unresponsive") {
      assert.ok(Date.now() - started < 5_000, "quitting is not held by an unresponsive Ollama");
      assert.equal(unloads.at(-1)!.signal.aborted, true);
    }
  }
});

it("reports the local model a harness turn names, and the adapter's own ending reaches a listener before the wrapper's error", async () => {
  const named: string[] = [];
  const heard: HarnessEvent[] = [];
  const listeners = new Set<(event: HarnessEvent) => void>();
  // The adapter, as far as the wrapper sees it: the turn ends with a stated reason, then
  // its send rejects with the same words.
  const raw: HarnessAdapter = {
    id: "opencode", capabilities: () => new Set(), readiness: () => ({ ready: true }),
    createSession: async () => ({ sessionId: "s" }),
    sendMessage: async (input) => {
      const detail = "This message and its tool results do not fit the model's context window.";
      for (const listener of listeners) listener({ type: "session.ended", sessionId: input.sessionId, reason: "budget-exceeded", detail });
      throw new Error(detail);
    },
    dispatchAsync: async () => { throw new Error("sendMessage owns completion"); },
    streamEvents: (signal) => ({ async *[Symbol.asyncIterator]() {
      const queue: HarnessEvent[] = []; let wake: (() => void) | null = null;
      const listener = (event: HarnessEvent) => { queue.push(event); wake?.(); };
      listeners.add(listener);
      try {
        while (!signal?.aborted) {
          if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; signal?.addEventListener("abort", () => resolve(), { once: true }); });
          while (queue.length > 0) yield queue.shift()!;
        }
      } finally { listeners.delete(listener); }
    } }),
  };
  const gpu = new LocalGpu(async () => {});
  const adapter = withLocalGpu(raw, gpu, () => {}, (model) => named.push(model));
  adapter.prepareSession?.({ preparationId: "p", model: "ollama/gemma4:12b" });
  const { sessionId } = await adapter.createSession({ purpose: "authoring", agent: "sheet-editor", preparationId: "p" });
  const stop = new AbortController();
  const observe = (async () => { for await (const event of adapter.streamEvents(stop.signal)) { heard.push(event); if (event.type === "session.error") return; } })();
  try {
    await adapter.dispatchAsync({ sessionId, parts: [{ type: "text", text: "too long" }] });
    await observe;
    assert.deepEqual(named, ["gemma4:12b"], "the model the turn named, for quitting's release");
    const types = heard.map((event) => event.type);
    assert.ok(types.indexOf("session.ended") >= 0 && types.indexOf("session.ended") < types.indexOf("session.error"), types.join(", "));
  } finally { stop.abort(); gpu.stop(); await adapter.dispose?.(); }
});
