import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import type { HarnessEvent } from "@arke-studio/contracts";
import { buildSessionConfigV2 } from "../src/v2/config.js";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { until } from "./wait.js";

/**
 * What the pinned engine does on its own, on the shipped binary with a scripted local provider and
 * no real credentials. A later bump that moves either default should fail here rather than in a
 * reply that lost its opening or an approval for a picture outside Arke's ledger.
 */
type Step = { text?: string; finish?: string; drop?: true; call?: { name: string; args: unknown } };

const MODEL = "arke-smoke";
const chunk = (delta: unknown, finish: string | null) => ({ id: "chatcmpl_defaults", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });

async function withEngine(run: (engine: {
  profile: string;
  script: (marker: string, steps: Step[]) => void;
  sent: (marker: string) => Array<{ messages?: unknown[]; tools?: Array<{ function: { name: string } }> }>;
  all: () => Array<{ messages?: unknown[] }>;
  adapter: OpenCodeV2Adapter;
  request: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: { data?: Record<string, unknown> } }>;
}) => Promise<void>, providerSettings: Record<string, unknown> = {}): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "arke-engine-defaults-"));
  const scripts = new Map<string, Step[]>();
  const received = new Map<string, Array<{ messages?: unknown[]; tools?: Array<{ function: { name: string } }> }>>();
  const all: Array<{ messages?: unknown[] }> = [];
  const provider = httpServer((req, res) => {
    let body = "";
    req.on("data", data => { body += String(data); });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") {
        res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, modified_at: "2026-11-05T00:00:00Z", size: 1, digest: MODEL,
          details: { format: "gguf", family: "gemma", parameter_size: "12B", quantization_level: "Q4_K_M" } }] })); return;
      }
      if (req.url === "/api/show") { res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "general.architecture": "gemma", "gemma.context_length": 262144 } })); return; }
      if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      const request = JSON.parse(body) as { messages?: unknown[]; tools?: Array<{ function: { name: string } }> };
      all.push(request);
      // The hidden title helper repeats the conversation but carries no tools.
      const marker = [...scripts.keys()].find(key => JSON.stringify(request.messages).includes(key));
      const isPrivate = marker?.startsWith("PRIVATE");
      const step = marker && (isPrivate || request.tools?.length) ? scripts.get(marker)![received.get(marker)?.length ?? 0] : undefined;
      if (marker && step) received.set(marker, [...received.get(marker) ?? [], request]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = step?.call
        ? { tool_calls: [{ index: 0, id: `call_${received.get(marker!)?.length ?? 0}`, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args) } }] }
        : { content: step?.text ?? "Smoke test" };
      res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
      if (step?.drop) { setTimeout(() => res.destroy(), 50); return; }
      res.write(`data: ${JSON.stringify({ ...chunk({}, step?.finish ?? (step?.call ? "tool_calls" : "stop")), usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const providerAddress = provider.address(); assert.ok(providerAddress && typeof providerAddress !== "string");
  await mkdir(join(profile, ".config", "opencode"), { recursive: true });
  await writeFile(join(profile, ".config", "opencode", "opencode.json"), JSON.stringify({ providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${providerAddress.port}/v1` }, ...providerSettings } } }));
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const address = socket.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, { HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: join(profile, ".config"), XDG_DATA_HOME: join(profile, ".local", "share") });
  const child = spawn(process.env["ARKE_TEST_OPENCODE2"]!, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: profile, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let password: string | null = null, pending = "", spawnError = false;
  child.on("error", () => { spawnError = true; }); child.stderr.resume();
  child.stdout.on("data", data => {
    pending += String(data);
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
    for (const line of lines) { const match = /^server password (\S+)$/.exec(line.trim()); if (match) password = match[1]!; }
  });
  const baseUrl = () => `http://127.0.0.1:${port}`;
  const adapter = new OpenCodeV2Adapter({ baseUrl, password: () => password });
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(baseUrl() + path, { method, headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  };
  try {
    await until(() => password !== null || spawnError || child.exitCode !== null, "the isolated pinned runtime launch", 35_000);
    assert.ok(password && !spawnError && child.exitCode === null);
    await adapter.init();
    await run({ profile, adapter, request, all: () => all, script: (marker, steps) => scripts.set(marker, steps), sent: marker => received.get(marker) ?? [] });
  } finally {
    await adapter.dispose();
    if (child.exitCode === null && !spawnError) { const exited = once(child, "exit"); child.kill(); await exited; }
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

it("reports the whole of a reply the engine continued by itself, and the failure when it gives up", {
  skip: !process.env["ARKE_TEST_OPENCODE2"], timeout: 90_000,
}, async () => {
  await withEngine(async ({ profile, adapter, script, sent }) => {
    const listening = new AbortController();
    const events: HarnessEvent[] = [];
    const pump = (async () => { for await (const event of adapter.streamEvents(listening.signal)) events.push(event); })();
    try {
      const turn = async (name: string, marker: string, steps: Step[]) => {
        script(marker, steps);
        const cwd = join(profile, name); await mkdir(cwd);
        const preparation = { preparationId: name, model: `ollama/${MODEL}` };
        await writeFile(join(cwd, "opencode.json"), JSON.stringify(buildSessionConfigV2({ ...preparation, defaultAgent: "sheet-editor" })));
        adapter.prepareSession(preparation);
        const session = await adapter.createSession({ purpose: "authoring", agent: "sheet-editor", cwd, preparationId: name });
        await adapter.dispatchAsync({ sessionId: session.sessionId, parts: [{ type: "text", text: `${marker} Write the long answer.` }] });
        await until(() => events.some(event => (event.type === "message.completed" || event.type === "session.error") && event.sessionId === session.sessionId), `${name} to settle`, 30_000);
        return events.filter(event => "sessionId" in event && event.sessionId === session.sessionId);
      };
      const continued = await turn("limit", "LIMIT-TURN", [{ text: "Part one. ", finish: "length" }, { text: "Part two. ", finish: "length" }, { text: "Part three." }]);
      assert.equal(sent("LIMIT-TURN").length, 3, "the engine continues twice behind one prompt");
      const whole = continued.find(event => event.type === "message.completed");
      assert.equal(whole?.type === "message.completed" && whole.text, "Part one. Part two. Part three.");

      const dropped = await turn("dropped", "DROPPED-TURN", [{ text: "Partial ", drop: true }, { text: "rest." }]);
      assert.equal(sent("DROPPED-TURN").length, 2, "the engine carries on from a stream lost after output");
      const rejoined = dropped.find(event => event.type === "message.completed");
      assert.equal(rejoined?.type === "message.completed" && rejoined.text, "Partial rest.");

      const exhausted = await turn("exhausted", "EXHAUSTED-TURN", [{ text: "One. ", finish: "length" }, { text: "Two. ", finish: "length" }, { text: "Three. ", finish: "length" }, { text: "Never." }]);
      assert.equal(sent("EXHAUSTED-TURN").length, 3, "two continuations are all the engine allows");
      const failure = exhausted.find(event => event.type === "session.error");
      assert.ok(failure?.type === "session.error" && failure.message.includes("output-limit"), JSON.stringify(exhausted));
      assert.equal(exhausted.some(event => event.type === "message.completed"), false, "a reply the engine gave up on is a failure, not a completion");
    } finally {
      listening.abort(); await pump;
    }
  });
});

it("refuses a private reply at the output limit with one provider request", {
  skip: !process.env["ARKE_TEST_OPENCODE2"], timeout: 60_000,
}, async () => {
  await withEngine(async ({ profile, adapter, script, sent }) => {
    script("PRIVATE-LIMIT", [{ text: "Truncated private reply.", finish: "length" }, { text: "MUST NOT BE REQUESTED" }]);
    const cwd = join(profile, "private"); await mkdir(cwd);
    const preparation = { agent: "studio-assistant", model: `ollama/${MODEL}`, preparationId: "private" };
    for (const file of adapter.sessionFiles(preparation, cwd)) {
      await mkdir(dirname(join(cwd, file.name)), { recursive: true }); await writeFile(join(cwd, file.name), file.contents);
    }
    adapter.prepareSession(preparation);
    const ref = await adapter.createSession({ purpose: "ask", agent: "studio-assistant", visibility: "private", cwd, preparationId: "private" });
    assert.ok(await ref.privateDestination!(new AbortController().signal));
    const stop = new AbortController(), events: HarnessEvent[] = [];
    const reading = (async () => { for await (const event of ref.privateEvents!(stop.signal)) { events.push(event); if (event.type === "message.completed" || event.type === "session.error") break; } })();
    try {
      await adapter.sendMessage({ sessionId: ref.sessionId, parts: [{ type: "text", text: "PRIVATE-LIMIT Return one short reply." }] }).catch(() => undefined);
      await until(() => events.some(event => event.type === "session.error" || event.type === "message.completed"), "the private turn to settle", 20_000);
    } finally { stop.abort(); await reading; }
    await new Promise(resolve => setTimeout(resolve, 500)); // bounded absence check for a continuation request
    assert.equal(sent("PRIVATE-LIMIT").length, 1, "the private control refuses the engine's continuation");
    assert.equal(events.some(event => event.type === "message.completed"), false, "a truncated private reply is a refusal, never a reply");
  });
});

/** The engine counts the whole repository around a session as inside it, so these run in one. */
it("pins the engine tools agents get, and keeps them inside their proposal", {
  skip: !process.env["ARKE_TEST_OPENCODE2"], timeout: 90_000,
}, async () => {
  await withEngine(async ({ profile, adapter, script, sent, request }) => {
    const world = join(profile, "world"); await mkdir(world);
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: world, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    git("init", "-q"); await writeFile(join(world, "canon.md"), "Canon."); git("add", "."); git("commit", "-qm", "world");
    const linked = join(profile, "linked"); git("worktree", "add", "-q", linked);
    const listening = new AbortController();
    const events: HarnessEvent[] = [];
    const pump = (async () => { for await (const event of adapter.streamEvents(listening.signal)) events.push(event); })();
    const run = async (name: string, agent: string, steps: Step[]) => {
      const marker = `SURFACE-${name}`;
      script(marker, [...steps, { text: "Done." }]);
      const cwd = join(world, ".proposals", name); await mkdir(cwd, { recursive: true });
      const preparation = { preparationId: name, model: `ollama/${MODEL}` };
      await writeFile(join(cwd, "opencode.json"), JSON.stringify(buildSessionConfigV2({ ...preparation, defaultAgent: agent })));
      adapter.prepareSession(preparation);
      const session = await adapter.createSession({ purpose: "authoring", agent, cwd, preparationId: name });
      await adapter.dispatchAsync({ sessionId: session.sessionId, parts: [{ type: "text", text: `${marker} Go.` }] });
      await until(() => events.some(event => (event.type === "message.completed" || event.type === "session.error") && event.sessionId === session.sessionId), `${name} to settle`, 30_000);
      assert.equal(sent(marker).length, steps.length + 1, `${name} should reach the end of its script`);
      const directory = (await request("GET", `/api/session/${session.sessionId}`)).body.data!["location"] as { directory: string };
      return { marker, cwd, directory: directory.directory, tools: (sent(marker)[0]!.tools ?? []).map(tool => tool.function.name).sort() };
    };
    try {
      // A new engine tool should stop here at the next bump, for someone to decide about it.
      const reader = await run("reader", "conversation-namer", [
        { call: { name: "execute", args: { code: "return await tools.opencode.session_move({ directory: '../..' });" } } },
        { call: { name: "opencode_session_move", args: { directory: "../.." } } },
        { call: { name: "opencode_worktree_create", args: { name: "arke-escape" } } },
      ]);
      assert.deepEqual(reader.tools, ["glob", "grep", "question", "read"]);
      assert.equal(reader.directory.replaceAll("\\", "/"), reader.cwd.replaceAll("\\", "/"), "a confined session stays in its proposal");
      assert.equal(git("worktree", "list").trim().split("\n").length, 2, "a confined agent adds no worktree");

      const writer = await run("writer", "sheet-editor", [
        { call: { name: "write", args: { path: "inside.md", content: "Inside." } } },
        { call: { name: "write", args: { path: "../../outside.md", content: "OUTSIDE" } } },
        { call: { name: "opencode_worktree_remove", args: { directory: linked.replaceAll("\\", "/"), force: true } } },
      ]);
      assert.deepEqual(writer.tools, ["edit", "glob", "grep", "opencode_worktree_remove", "question", "read", "skill", "write"]);
      assert.equal(await readFile(join(writer.cwd, "inside.md"), "utf8"), "Inside.", "edits inside the proposal still work");
      await assert.rejects(readFile(join(world, "outside.md"), "utf8"), "the repository around the session is not inside it");
      await access(linked);
      assert.equal(git("worktree", "list").trim().split("\n").length, 2, "worktree_remove stops at the edit rule");
      assert.ok(JSON.stringify(sent(writer.marker).at(-1)!.messages).includes("denied"), "the model is told, rather than left to guess");
    } finally {
      listening.abort(); await pump;
    }
  });
});

it("keeps the default-on image tool away from roster agents", {
  skip: !process.env["ARKE_TEST_OPENCODE2"], timeout: 60_000,
}, async () => {
  await withEngine(async ({ profile, script, sent, request, adapter }) => {
    const prompt = async (name: string, agent: string, config: Record<string, unknown>) => {
      const marker = `IMAGE-${name}`;
      script(marker, [{ text: "Done." }]);
      const cwd = join(profile, name); await mkdir(cwd);
      await writeFile(join(cwd, "opencode.json"), JSON.stringify(config));
      const location = { directory: cwd.replaceAll("\\", "/") };
      const query = new URLSearchParams({ "location[directory]": location.directory });
      for (let waited = 0; waited < 20_000; waited += 100) {
        const models = await request("GET", `/api/model?${query}`);
        if ((models.body.data as unknown as Array<{ id: string }>)?.some(model => model.id === MODEL)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const created = await request("POST", "/api/session", { location, model: { providerID: "ollama", id: MODEL } });
      const session = created.body.data!["id"] as string;
      await request("POST", `/api/session/${session}/agent`, { agent });
      await request("POST", `/api/session/${session}/prompt`, { id: `msg_${Date.now().toString(16)}${"b".repeat(20)}`, text: `${marker} Say done.` });
      await until(() => sent(marker).length > 0, `${name} to reach the provider`, 20_000);
      return (sent(marker)[0]!.tools ?? []).map(tool => tool.function.name);
    };
    const confined = buildSessionConfigV2({ model: `ollama/${MODEL}`, defaultAgent: "sheet-editor" });
    const roster = await prompt("roster", "sheet-editor", confined);
    assert.ok(roster.includes("read"), JSON.stringify(roster));
    assert.ok(!roster.includes("experimental_image_generate"), JSON.stringify(roster));
    // The control: without the rule the engine offers it, so the assertion above is not vacuous.
    const open = await prompt("open", "open-agent", { ...confined, default_agent: "open-agent", agents: { "open-agent": { description: "control", system: "control", model: `ollama/${MODEL}` } } });
    assert.ok(open.includes("experimental_image_generate"), JSON.stringify(open));
    assert.equal(adapter.readiness().ready, true);
  }, { models: { "arke-image": { type: "image", name: "Scripted image" } } });
});
