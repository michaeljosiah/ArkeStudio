#!/usr/bin/env node
/**
 * Phase 5 of issue 1247: the local writing lanes, measured on real hardware.
 *
 * Runs the same short writing conversation through each lane — Arke's own local harness and the
 * bundled OpenCode — on each model asked for, and reports what the issue said decides the
 * default: time to first token, turn time, prompt tokens Ollama actually processed per call
 * (which is how prompt caching shows up), tokens per second, the context window each request
 * really ran with, and how long it takes to get the graphics card back.
 *
 * Measured at Ollama, not inside either harness, so both lanes are judged by the same ruler: a
 * small recording proxy sits on Ollama's usual port and forwards to Ollama moved one port up.
 * OpenCode's Ollama address is fixed, so this is the only way to see its requests without
 * changing it. Nothing is sent anywhere but this machine.
 *
 * Setup and usage: docs/development/local-harness-benchmark.md. In short:
 *
 *   1. Quit Arke Studio, then stop Ollama and start it on port 11435:
 *        PowerShell:  $env:OLLAMA_HOST="127.0.0.1:11435"; ollama serve
 *        bash:        OLLAMA_HOST=127.0.0.1:11435 ollama serve
 *   2. From the repository root, in another terminal:
 *        node --import tsx scripts/bench-local-harness.mjs --models gemma4:12b,gemma4:26b
 *
 * Options:
 *   --models <a,b>        Ollama models to run (required). Local needs 64k; OpenCode needs 256k.
 *   --lanes <a,b>         arke, opencode, or both (default both).
 *   --turns <n>           Turns per conversation (default 6; the script cycles its prompts).
 *   --runs <n>            Repeat each lane x model this many times (default 1).
 *   --upstream <url>      Where Ollama really is (default http://127.0.0.1:11435).
 *   --proxy-port <n>      Where the recording proxy listens (default 11434, which OpenCode needs).
 *   --opencode <path>     The OpenCode v2 binary, if discovery does not find it.
 *   --idle-wait <s>       How long to watch for a model unloading on its own after a run
 *                         (default 30; Ollama's default keep_alive is 5 minutes).
 *   --out <file>          Where to write the raw results (default bench-local-harness-<time>.json).
 */
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";

const { values } = parseArgs({
  options: {
    models: { type: "string" },
    lanes: { type: "string", default: "arke,opencode" },
    turns: { type: "string", default: "6" },
    runs: { type: "string", default: "1" },
    upstream: { type: "string", default: "http://127.0.0.1:11435" },
    "proxy-port": { type: "string", default: "11434" },
    opencode: { type: "string" },
    "idle-wait": { type: "string", default: "30" },
    out: { type: "string" },
  },
});
if (!values.models) {
  console.error("--models is required, e.g. --models gemma4:12b,gemma4:26b");
  process.exit(2);
}
const MODELS = values.models.split(",").map((m) => m.trim()).filter(Boolean);
const ASKED_LANES = values.lanes.split(",").map((l) => l.trim()).filter(Boolean);
const LANES = ASKED_LANES.filter((l) => l === "arke" || l === "opencode");
// A mistyped option must not produce an empty "successful" report someone pastes into the issue.
if (MODELS.length === 0) { console.error("--models named no model."); process.exit(2); }
const unknownLanes = ASKED_LANES.filter((l) => !LANES.includes(l));
if (LANES.length === 0 || unknownLanes.length > 0) {
  console.error(`--lanes takes arke, opencode or both${unknownLanes.length ? `; not ${unknownLanes.join(", ")}` : ""}.`);
  process.exit(2);
}
const TURNS = Number(values.turns);
const RUNS = Number(values.runs);
const UPSTREAM = new URL(values.upstream);
const PROXY_PORT = Number(values["proxy-port"]);
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
const IDLE_WAIT_MS = Number(values["idle-wait"]) * 1000;
const OUT = values.out ?? `bench-local-harness-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

/**
 * A short conversation of the kind a writer has: read a sheet, change it, talk about it. Tool
 * use and plain replies both, so prompt caching across tool rounds and across turns both show.
 */
const PROMPTS = [
  "Read sheets/maren.md and tell me in two sentences who Maren is.",
  "Add one line to sheets/maren.md saying she was born at slack water, in the same style as the rest.",
  "What did you change, exactly?",
  "Read sheets/saltlight.md. How does Maren fit into the town?",
  "Suggest one tension between Maren and the harbour master, in three sentences. Do not edit anything.",
  "Summarise what we have established in this conversation in one short paragraph.",
];

const SEED = {
  "sheets/maren.md": "# Maren Holt\n\nKeeper of the Saltlight bell. Speaks rarely, remembers every tide.\n\n- Age: 34\n- Lives above the bell tower\n",
  "sheets/saltlight.md": "# Saltlight\n\nA harbour town that rings its bell at every slack water. The harbour master decides when the bell may ring.\n",
};

// ---------------------------------------------------------------------------------------------
// The recording proxy. Every chat request is timed from the moment it arrives to its first byte,
// its first word of content, and its end; the final chunk's own counts are kept as Ollama gave
// them. `context` names the lane, model, run and turn a request belongs to.

const context = { lane: null, model: null, run: 0, turn: 0 };
const calls = [];

function recordStream(record, contentType) {
  let pending = "";
  const native = contentType.includes("ndjson") || record.path === "/api/chat";
  return (chunk) => {
    const now = performance.now();
    if (record.firstByteMs === null) record.firstByteMs = now - record.started;
    pending += chunk.toString("utf8");
    let at;
    while ((at = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, at).trim();
      pending = pending.slice(at + 1);
      if (!line) continue;
      if (native) readNative(record, line, now);
      else if (line.startsWith("data:")) readSse(record, line.slice(5).trim(), now);
    }
  };
}

function readNative(record, line, now) {
  let chunk;
  try { chunk = JSON.parse(line); } catch { return; }
  const content = chunk.message?.content;
  const called = Array.isArray(chunk.message?.tool_calls) && chunk.message.tool_calls.length > 0;
  if (record.firstTokenMs === null && ((typeof content === "string" && content.length > 0) || called)) record.firstTokenMs = now - record.started;
  if (chunk.done === true) {
    record.promptTokens = chunk.prompt_eval_count ?? null;
    record.promptEvalMs = nsToMs(chunk.prompt_eval_duration);
    record.outputTokens = chunk.eval_count ?? null;
    record.evalMs = nsToMs(chunk.eval_duration);
    record.loadMs = nsToMs(chunk.load_duration);
    record.doneReason = chunk.done_reason ?? null;
  }
}

function readSse(record, data, now) {
  if (data === "[DONE]") return;
  let chunk;
  try { chunk = JSON.parse(data); } catch { return; }
  const delta = chunk.choices?.[0]?.delta;
  const said = (typeof delta?.content === "string" && delta.content.length > 0) || (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0);
  if (record.firstTokenMs === null && said) record.firstTokenMs = now - record.started;
  // The OpenAI-compatible route reports usage only when the client asks for it; when it does not,
  // the prompt count stays unknown rather than guessed.
  if (chunk.usage) {
    record.promptTokens = chunk.usage.prompt_tokens ?? null;
    record.outputTokens = chunk.usage.completion_tokens ?? null;
  }
}

const nsToMs = (ns) => (typeof ns === "number" ? ns / 1e6 : null);

function startProxy() {
  const server = createServer((req, res) => {
    const body = [];
    req.on("data", (part) => body.push(part));
    req.on("end", () => {
      const raw = Buffer.concat(body);
      const path = (req.url ?? "/").split("?")[0];
      const isChat = path === "/api/chat" || path === "/v1/chat/completions";
      let record = null;
      if (isChat) {
        let parsed = {};
        try { parsed = JSON.parse(raw.toString("utf8")); } catch { /* recorded without the body's details */ }
        record = {
          ...context, path, model: parsed.model ?? context.model, started: performance.now(),
          requestBytes: raw.length, messages: Array.isArray(parsed.messages) ? parsed.messages.length : null,
          tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
          numCtx: parsed.options?.num_ctx ?? null, stream: parsed.stream !== false,
          firstByteMs: null, firstTokenMs: null, totalMs: null,
          promptTokens: null, promptEvalMs: null, outputTokens: null, evalMs: null, loadMs: null, doneReason: null, status: null,
        };
        calls.push(record);
      }
      const upstream = httpRequest({
        hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: req.url, method: req.method,
        headers: { ...req.headers, host: UPSTREAM.host },
      }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        const observe = record ? recordStream(record, String(up.headers["content-type"] ?? "")) : null;
        if (record) record.status = up.statusCode ?? null;
        up.on("data", (chunk) => { observe?.(chunk); res.write(chunk); });
        up.on("end", () => { if (record) record.totalMs = performance.now() - record.started; res.end(); });
      });
      upstream.on("error", (error) => {
        if (record) { record.status = 502; record.totalMs = performance.now() - record.started; }
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error.message ?? error) }));
      });
      upstream.end(raw);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PROXY_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---------------------------------------------------------------------------------------------
// Ollama, asked directly (not through the proxy) for what is loaded and to unload it.

async function ollama(path, body) {
  const response = await fetch(new URL(path, UPSTREAM), body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Ollama ${path} answered HTTP ${response.status}`);
  return response.json();
}

const loaded = async () => ((await ollama("/api/ps")).models ?? []);

async function unloadAll() {
  for (const model of await loaded()) await ollama("/api/generate", { model: model.name, keep_alive: 0 });
}

async function untilUnloaded(limitMs) {
  const started = performance.now();
  while (performance.now() - started < limitMs) {
    if ((await loaded()).length === 0) return performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The lanes. Both are driven through the same harness contract the app uses, assembled the way
// the app assembles them, so what is measured is what a person gets.

const { assembleHarness } = await import("../packages/coordinator/src/harness/v2-launch.ts");
const { OllamaClient } = await import("../packages/providers/src/clients/ollama.ts");
const { meetsArkeModelMinimum, meetsLocalModelMinimum } = await import("../packages/contracts/src/harness.ts");
const { createPreparedSession } = await import("../packages/coordinator/src/harness/session-files.ts");

async function openLane(lane, appRoot) {
  if (lane === "arke") {
    // Arke's harness is pointed at the proxy directly; it is loopback, so the adapter accepts it.
    const wiring = await assembleHarness({ appRoot, engine: "arke", arke: { baseUrl: PROXY_URL } });
    const adapter = wiring.adapter;
    await adapter.init();
    return { adapter, close: async () => { await adapter.dispose(); }, release: () => adapter.releaseResidency() };
  }
  const wiring = await assembleHarness({ appRoot, engine: "opencode", ...(values.opencode ? { v2: { configuredPath: values.opencode } } : {}) });
  if (!wiring.adapter || !wiring.supervisor) throw new Error(`OpenCode is not available: ${wiring.logLines.join("; ")}`);
  if (!wiring.publishLocalModels) throw new Error("OpenCode v1 was found; the local lane needs the bundled v2 (pass --opencode).");
  // What the coordinator would publish: Ollama's listing, held to the 256k minimum. OpenCode
  // reaches Ollama at 127.0.0.1:11434, which is the proxy.
  const pulled = await new OllamaClient((url, init) => fetch(url, init), PROXY_URL).listModels();
  await wiring.publishLocalModels(pulled.filter(meetsLocalModelMinimum));
  const adapter = wiring.adapter;
  const close = async () => { await adapter.dispose?.().catch(() => {}); await wiring.supervisor.stop(); };
  await wiring.supervisor.start();
  // From here the child is running: any failure stops it, or every later run would add another.
  try {
    const deadline = Date.now() + 90_000;
    while (!adapter.readiness().ready) {
      if (Date.now() > deadline) throw new Error(`OpenCode did not become ready: ${adapter.readiness().reason ?? "no reason given"}`);
      await adapter.init?.().catch(() => {});
      if (!adapter.readiness().ready) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return {
    adapter,
    close,
    // What the coordinator's GPU hand-back does for this lane: unload whatever Ollama holds.
    release: unloadAll,
  };
}

async function runConversation(lane, model, run) {
  const appRoot = await mkdtemp(join(tmpdir(), `arke-bench-${lane}-`));
  const cwd = join(appRoot, "proposal");
  for (const [path, text] of Object.entries(SEED)) {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), text, "utf8");
  }
  const result = { lane, model, run, turns: [], residency: null, error: null };
  let opened;
  try {
    await unloadAll();
    Object.assign(context, { lane, model, run, turn: 0 });
    opened = await openLane(lane, appRoot);
    const { adapter } = opened;
    // The app's own session path, for both lanes: it writes whatever files the harness reads
    // (OpenCode's session config — agent, prompt, tools, confinement) and loads skill bodies,
    // so each lane runs the conversation exactly as configured in use.
    const reference = `ollama/${model}`;
    const { sessionId } = await createPreparedSession(adapter, cwd,
      { agent: "sheet-editor", model: reference, agents: { "sheet-editor": { model: reference } } },
      { purpose: "authoring", agent: "sheet-editor" });
    // Failures that arrive as events rather than as a rejected send — OpenCode reports a provider
    // or model failure this way — are pinned to the turn they happen in.
    const listening = new AbortController();
    let failure = null;
    void (async () => {
      for await (const event of adapter.streamEvents(listening.signal)) {
        if (event.sessionId !== sessionId || failure !== null) continue;
        if (event.type === "session.error") failure = event.message;
        else if (event.type === "session.ended" && event.reason !== "completed") failure = event.detail ?? event.reason;
      }
    })().catch(() => {});
    for (let turn = 1; turn <= TURNS; turn++) {
      context.turn = turn;
      failure = null;
      const started = performance.now();
      let error = null;
      try {
        await adapter.sendMessage({ sessionId, correlationId: randomUUID(), parts: [{ type: "text", text: PROMPTS[(turn - 1) % PROMPTS.length] }] });
      } catch (caught) { error = String(caught?.message ?? caught); }
      // Timed at the send's own settling. The pause after it only lets a trailing failure event
      // arrive, and is no part of the turn.
      const ended = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 50));
      error ??= failure;
      // First output of the turn, as seen at Ollama: the same ruler for both lanes, and no
      // reliance on how each adapter labels its events.
      const firsts = calls
        .filter((c) => c.lane === lane && c.model?.replace(/^ollama\//, "") === model && c.run === run && c.turn === turn && c.firstTokenMs !== null)
        .map((c) => c.started + c.firstTokenMs);
      const first = firsts.length > 0 ? Math.min(...firsts) : null;
      result.turns.push({ turn, firstTokenMs: first === null ? null : first - started, wallMs: ended - started, error });
      process.stdout.write(`  ${lane} ${model} run ${run} turn ${turn}: ${error ? `error: ${error}` : `${Math.round(ended - started)} ms`}\n`);
    }
    listening.abort();
    // The card back: first on its own (Ollama's keep_alive), then asked for, as the GPU lease does.
    const ps = await loaded();
    const naturalMs = await untilUnloaded(IDLE_WAIT_MS);
    let releaseMs = null;
    if (naturalMs === null) {
      const started = performance.now();
      await opened.release();
      const settled = await untilUnloaded(30_000);
      releaseMs = settled === null ? null : performance.now() - started;
    }
    result.residency = {
      loadedAfterRun: ps.map((m) => ({ name: m.name, sizeVram: m.size_vram ?? null, contextLength: m.context_length ?? null })),
      unloadedOnItsOwnMs: naturalMs, idleWaitMs: IDLE_WAIT_MS, releasedOnRequestMs: releaseMs,
    };
  } catch (caught) {
    result.error = String(caught?.message ?? caught);
    console.error(`  ${lane} ${model} run ${run}: ${result.error}`);
  } finally {
    await opened?.close().catch(() => {});
    await rm(appRoot, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// The report: medians per lane and model, with the first turn (a cold load) kept apart.

const median = (xs) => {
  const sorted = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const ms = (x) => (x === null ? "—" : `${Math.round(x)} ms`);
const num = (x) => (x === null ? "—" : String(Math.round(x)));

function summarise(results) {
  const rows = [];
  for (const lane of LANES) {
    for (const model of MODELS) {
      const runs = results.filter((r) => r.lane === lane && r.model === model);
      const turns = runs.flatMap((r) => r.turns.filter((t) => !t.error));
      const mine = calls.filter((c) => c.lane === lane && c.model?.replace(/^ollama\//, "") === model);
      const outTokens = mine.reduce((sum, c) => sum + (c.outputTokens ?? 0), 0);
      const outMs = mine.reduce((sum, c) => sum + (c.evalMs ?? 0), 0);
      rows.push({
        lane, model,
        failedRuns: runs.filter((r) => r.error).length,
        failedTurns: runs.flatMap((r) => r.turns.filter((t) => t.error)).length,
        coldFirstTokenMs: median(turns.filter((t) => t.turn === 1).map((t) => t.firstTokenMs)),
        warmFirstTokenMs: median(turns.filter((t) => t.turn > 1).map((t) => t.firstTokenMs)),
        turnMs: median(turns.map((t) => t.wallMs)),
        modelCallsPerTurn: turns.length ? mine.length / turns.length : null,
        promptTokensPerCall: median(mine.map((c) => c.promptTokens)),
        promptTokensPerCallWarm: median(mine.filter((c) => c.turn > 1).map((c) => c.promptTokens)),
        tokensPerSecond: outMs > 0 ? outTokens / (outMs / 1000) : null,
        numCtx: median(mine.map((c) => c.numCtx)) ?? median(runs.flatMap((r) => r.residency?.loadedAfterRun.map((m) => m.contextLength) ?? [])),
        unloadedOnItsOwnMs: median(runs.map((r) => r.residency?.unloadedOnItsOwnMs ?? null)),
        releasedOnRequestMs: median(runs.map((r) => r.residency?.releasedOnRequestMs ?? null)),
      });
    }
  }
  return rows;
}

function markdown(rows) {
  const head = "| Lane | Model | Cold first token | Warm first token | Turn | Prompt tokens / call (warm) | Tokens/s | Context | GPU free (asked) | Failures |";
  const rule = "|---|---|---|---|---|---|---|---|---|---|";
  const body = rows.map((r) => `| ${r.lane} | ${r.model} | ${ms(r.coldFirstTokenMs)} | ${ms(r.warmFirstTokenMs)} | ${ms(r.turnMs)} | ${num(r.promptTokensPerCallWarm)} | ${r.tokensPerSecond === null ? "—" : r.tokensPerSecond.toFixed(1)} | ${num(r.numCtx)} | ${r.unloadedOnItsOwnMs !== null ? `on its own in ${ms(r.unloadedOnItsOwnMs)}` : ms(r.releasedOnRequestMs)} | ${r.failedRuns} runs, ${r.failedTurns} turns |`);
  return [head, rule, ...body].join("\n");
}

// ---------------------------------------------------------------------------------------------

try {
  await ollama("/api/tags");
} catch {
  console.error(`Ollama is not answering at ${UPSTREAM.origin}. Start it there first (see the header of this script).`);
  process.exit(1);
}
for (const model of MODELS) {
  const shown = await ollama("/api/show", { model }).catch(() => null);
  const info = shown?.model_info ?? {};
  const arch = info["general.architecture"];
  const context = arch ? info[`${arch}.context_length`] : undefined;
  if (!shown) console.warn(`warning: ${model} is not pulled at ${UPSTREAM.origin}`);
  else {
    if (LANES.includes("opencode") && !meetsLocalModelMinimum({ contextLength: context })) console.warn(`warning: ${model} states a context of ${context ?? "nothing"}; OpenCode requires 256k and will refuse it`);
    if (LANES.includes("arke") && !meetsArkeModelMinimum({ contextLength: context })) console.warn(`warning: ${model} states a context of ${context ?? "nothing"}; Local requires 64k and will refuse it`);
  }
}

let proxy;
try {
  proxy = await startProxy();
} catch (error) {
  console.error(`Could not listen on ${PROXY_URL} (${error.code ?? error.message}). Is Ollama or Arke Studio still using it? Move Ollama to ${UPSTREAM.host} as described above.`);
  process.exit(1);
}
console.log(`Recording proxy on ${PROXY_URL} → Ollama at ${UPSTREAM.origin}`);

const results = [];
try {
  for (let run = 1; run <= RUNS; run++) {
    for (const model of MODELS) {
      for (const lane of LANES) {
        console.log(`\n${lane} · ${model} · run ${run}`);
        results.push(await runConversation(lane, model, run));
      }
    }
  }
} finally {
  proxy.close();
}

const rows = summarise(results);
await writeFile(OUT, `${JSON.stringify({ at: new Date().toISOString(), options: { models: MODELS, lanes: LANES, turns: TURNS, runs: RUNS, idleWaitMs: IDLE_WAIT_MS }, summary: rows, results, calls }, null, 2)}\n`);
console.log(`\n${markdown(rows)}\n\nRaw results: ${OUT}`);
console.log("Paste the table into issue #1247, with your GPU, its memory, and the Ollama version.");
