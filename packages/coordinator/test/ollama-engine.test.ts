import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { it } from "node:test";
import { OllamaEngineService } from "../src/local-ai/ollama.js";
import { ChildSupervisor, type SupervisedSpec } from "../src/supervisor.js";
import { OLLAMA_VERSION } from "../src/setup/catalogue.js";
import { tempDir } from "./tmp.js";

const signal = () => new AbortController().signal;
const managed = { engineUrl: null, modelsDir: null };

it("holds activation throughout managed-file installation, then allows verified publication to start it", async () => {
  const workers: Worker[] = [];
  const service = new OllamaEngineService({ appRoot: await tempDir("ollama-file-fence-"), port: 24113, exists: () => true, registerBackstop: () => () => {},
    supervise: spec => { const worker = new Worker(spec); workers.push(worker); return worker as unknown as ChildSupervisor; } });
  let release: (() => void) | undefined;
  try {
    await service.applySettings(managed); assert.equal(workers.length, 1);
    release = await service.reserveInstallation(); assert.equal(workers[0]!.stops, 1);
    await service.refresh(); assert.equal(workers.length, 1); assert.equal(service.baseUrl(), null);
    await assert.rejects(service.reserveInstallation(), /already changing/);
    release(); release(); await service.refresh(); assert.equal(workers.length, 2); assert.equal(service.status().state, "ready");
  } finally { release?.(); await service.dispose(); }
});

it("selects the pre-bootstrap endpoint without starting a managed child before recovery composition", async () => {
  const workers: Worker[] = [];
  const service = new OllamaEngineService({ appRoot: await tempDir("ollama-bootstrap-"), port: 24112, exists: () => true, registerBackstop: () => () => {},
    supervise: spec => { const worker = new Worker(spec); workers.push(worker); return worker as unknown as ChildSupervisor; } });
  try {
    await service.applySettings(managed, { deferManagedStart: true });
    assert.equal(service.endpoint(), "http://127.0.0.1:24112"); assert.equal(service.status().state, "starting"); assert.equal(service.baseUrl(), null); assert.equal(workers.length, 0);
    await service.applySettings(managed); assert.equal(workers.length, 1); assert.equal(service.status().state, "ready");
  } finally { await service.dispose(); }
});

it("a managed-file installation leaves the explicitly selected personal endpoint available", async () => {
  const service = new OllamaEngineService({ appRoot: await tempDir("ollama-personal-install-"), port: 24115,
    fetch: async () => Response.json({ version: "personal" }),
  });
  let release: (() => void) | undefined;
  try {
    await service.applySettings({ ...managed, engineUrl: "http://127.0.0.1:11434" });
    release = await service.reserveInstallation(); await service.refresh();
    assert.equal(service.baseUrl(), "http://127.0.0.1:11434"); assert.equal(service.status().state, "ready");
  } finally { release?.(); await service.dispose(); }
});

it("retains the installation's GPU lane after unconfirmed exit until its owner confirms stop", async () => {
  const workers: Worker[] = []; let releases = 0;
  const service = new OllamaEngineService({ appRoot: await tempDir("ollama-install-cleanup-"), port: 24114, exists: () => true, registerBackstop: () => () => {},
    supervise: spec => { const worker = new Worker(spec); workers.push(worker); return worker as unknown as ChildSupervisor; } });
  try {
    await service.applySettings(managed); workers[0]!.refuseStop = true;
    await assert.rejects(service.reserveInstallation(() => { releases++; }), /exit unconfirmed/);
    assert.equal(releases, 0); assert.equal(workers.length, 1); assert.equal(service.baseUrl(), null);
    workers[0]!.refuseStop = false; await service.stopManaged(); assert.equal(releases, 1);
    await service.stopManaged(); assert.equal(releases, 1);
  } finally { workers.forEach(worker => { worker.refuseStop = false; }); await service.dispose(); }
  assert.equal(releases, 1);
});

it("an older health check cannot overwrite a newer failure for the same selected service", async () => {
  let mode: "ready" | "held" | "failed" = "ready";
  let answer!: (response: Response) => void;
  const service = new OllamaEngineService({ appRoot: await tempDir("ollama-health-order-"), port: 24110,
    fetch: async () => mode === "held" ? new Promise<Response>(resolve => { answer = resolve; })
      : mode === "failed" ? Response.json({}, { status: 503 }) : Response.json({ version: "existing" }),
  });
  try {
    await service.applySettings({ ...managed, engineUrl: "http://127.0.0.1:11434" });
    mode = "held";
    const previous = service.refresh();
    mode = "failed";
    await service.refresh();
    assert.equal(service.status().state, "failed");
    answer(Response.json({ version: "existing" }));
    await previous;
    assert.equal(service.status().state, "failed");
  } finally { await service.dispose(); }
});

it("rechecks an explicit service during setup and stops polling on disposal", async () => {
  let healthy = true, calls = 0;
  const service = new OllamaEngineService({ appRoot: await tempDir("ollama-health-"), port: 24109, externalHealthIntervalMs: 30,
    fetch: async () => { calls++; if (!healthy) throw new Error("offline"); return Response.json({ version: "existing" }); },
  });
  try {
    await service.applySettings({ ...managed, engineUrl: "http://127.0.0.1:11434" });
    assert.equal(service.status().state, "ready");
    healthy = false;
    const deadline = Date.now() + 5000;
    while (service.status().state !== "failed" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.status().state, "failed");
  } finally { await service.dispose(); }
  const stopped = calls;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(calls, stopped);
});

class Worker extends EventEmitter {
  status = "starting";
  reason: string | undefined;
  stops = 0;
  refuseStop = false;
  constructor(readonly spec: SupervisedSpec) { super(); }
  async start() {
    const valid = await this.spec.validateHealth!(Response.json({ version: OLLAMA_VERSION }));
    assert.equal(valid, true);
    this.status = "healthy"; this.emit("status");
  }
  async stopAndConfirm() { this.stops++; if (this.refuseStop) throw new Error("exit unconfirmed"); this.status = "stopped"; }
  quiesce() {}
}

it("shutdown cancels an admitted startup before disposal waits on its serial activation", { timeout: 5000 }, async () => {
  let finish!: () => void;
  class StartingWorker extends Worker {
    override start() { return new Promise<void>(resolve => { finish = resolve; }); }
    override quiesce() { finish(); }
  }
  let worker: StartingWorker | undefined;
  const service = new OllamaEngineService({ appRoot: await tempDir("ollama-stop-start-"), port: 24111, exists: () => true,
    registerBackstop: () => () => {}, supervise: spec => (worker = new StartingWorker(spec)) as unknown as ChildSupervisor,
  });
  const starting = service.applySettings(managed);
  while (!worker) await new Promise(resolve => setTimeout(resolve, 5));
  service.beginShutdown();
  await starting;
  assert.equal(worker.stops, 0, "startup was cancelled without killing an admitted inference owner early");
  await service.dispose();
  assert.equal(worker.stops, 1);
  await service.applySettings(managed);
  assert.equal(worker.stops, 1, "closed service never activates again");
});

it("defaults to its owned runtime and never probes a personal service when absent", async () => {
  let calls = 0;
  const service = new OllamaEngineService({ appRoot: await tempDir("ollama-absent-"), port: 24100,
    exists: () => false, fetch: async () => { calls++; throw new Error("unexpected network"); } });
  try {
    await service.applySettings(managed);
    assert.equal(service.status().state, "absent");
    assert.equal(service.baseUrl(), null);
    assert.equal(calls, 0);
    await assert.rejects(service.list(signal()), /not ready/);
  } finally { await service.dispose(); }
});

it("owns only its portable child, private endpoint and model root; an explicit URL is never spawned", async () => {
  const root = await tempDir("ollama-owned-");
  const workers: Worker[] = [], urls: string[] = [];
  const service = new OllamaEngineService({ appRoot: root, port: 24101, exists: () => true,
    registerBackstop: () => () => {},
    supervise: spec => { const worker = new Worker(spec); workers.push(worker); return worker as unknown as ChildSupervisor; },
    fetch: async url => { urls.push(String(url)); return Response.json({ version: "personal-version" }); },
  });
  try {
    await service.applySettings(managed);
    assert.equal(service.status().state, "ready");
    assert.equal(service.baseUrl(), "http://127.0.0.1:24101");
    assert.equal(workers[0]!.spec.command, join(root, "ollama-runtime", "ollama.exe"));
    assert.equal(workers[0]!.spec.env?.OLLAMA_MODELS, join(root, "models", "ollama"));
    assert.equal(workers[0]!.spec.env?.OLLAMA_NO_CLOUD, "1");
    assert.equal(workers[0]!.spec.inheritEnv, false);
    assert.equal(workers[0]!.spec.env?.OPENAI_API_KEY, undefined);
    assert.deepEqual(await workers[0]!.spec.validateHealth!(Response.json({ version: "wrong" })),
      { ok: false, reason: `The managed Ollama runtime must be ${OLLAMA_VERSION}. Repair its installation.` });
    workers[0]!.refuseStop = true;
    await assert.rejects(service.applySettings({ ...managed, engineUrl: "http://localhost:11434" }), /unconfirmed/);
    assert.equal(urls.length, 0);
    assert.equal(service.status().source, "managed");
    workers[0]!.refuseStop = false;
    await service.applySettings({ ...managed, engineUrl: "http://localhost:11434/" });
    assert.deepEqual(urls, ["http://localhost:11434/api/version"]);
    assert.equal(service.status().source, "user-url");
    assert.equal(service.status().version, "personal-version");
    assert.equal(workers.length, 1);
    await service.stopManaged();
    assert.equal(workers[0]!.stops, 2);
  } finally { await service.dispose(); }
});

it("pulls and removes through the selected API, requiring download confirmation", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  let confirmed = true;
  const service = new OllamaEngineService({ appRoot: await tempDir("ollama-api-"), port: 24102,
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).endsWith("/api/version")) return Response.json({ version: "external" });
      if (String(url).endsWith("/api/tags")) return Response.json({ models: [{ name: "gemma4:12b" }] });
      if (String(url).endsWith("/api/pull")) return new Response('{"completed":3,"total":9}\n' + (confirmed ? '{"status":"success"}' : ''));
      return new Response(null, { status: 200 });
    } });
  try {
    await service.applySettings({ ...managed, engineUrl: "http://127.0.0.1:24567" });
    assert.deepEqual(await service.list(signal()), ["gemma4:12b"]);
    const progress: number[] = [];
    await service.pull("gemma4:12b", signal(), (done, total) => progress.push(done, total));
    assert.deepEqual(progress, [3, 9]);
    confirmed = false;
    await assert.rejects(service.pull("gemma4:12b", signal(), () => {}), /confirming success/);
    await service.remove("gemma4:12b", signal());
    assert.ok(requests.every(row => row.url.startsWith("http://127.0.0.1:24567/")));
    assert.deepEqual(requests.at(-1)!.body, { model: "gemma4:12b" });
  } finally { await service.dispose(); }
});

it("ignores an old external health response after selecting a different runtime", async () => {
  let hold = false, finish!: (response: Response) => void;
  const service = new OllamaEngineService({ appRoot: await tempDir("ollama-health-race-"), port: 24103,
    fetch: async url => {
      if (String(url).includes(":24567/") && hold) return new Promise<Response>(resolve => { finish = resolve; });
      return Response.json({ version: String(url).includes(":24567/") ? "old" : "new" });
    } });
  try {
    await service.applySettings({ ...managed, engineUrl: "http://127.0.0.1:24567" });
    hold = true;
    const stale = service.refresh();
    await service.applySettings({ ...managed, engineUrl: "http://127.0.0.1:24568" });
    finish(Response.json({ version: "stale" }));
    await stale;
    assert.equal(service.status().version, "new");
    assert.equal(service.baseUrl(), "http://127.0.0.1:24568");
  } finally { await service.dispose(); }
});

it("does not publish a previous service's completed pull as installed on the new service", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const service = new OllamaEngineService({ appRoot: await tempDir("ollama-pull-race-"), port: 24104,
    fetch: async url => String(url).endsWith("/api/pull")
      ? new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }))
      : Response.json({ version: "external" }) });
  try {
    await service.applySettings({ ...managed, engineUrl: "http://127.0.0.1:24567" });
    const pull = service.pull("llama3.1:8b", signal(), () => {});
    const rejected = assert.rejects(pull, /selection changed during download/);
    await service.applySettings({ ...managed, engineUrl: "http://127.0.0.1:24568" });
    stream.enqueue(new TextEncoder().encode('{"status":"success"}\n')); stream.close();
    await rejected;
  } finally { await service.dispose(); }
});
