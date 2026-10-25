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
}

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
