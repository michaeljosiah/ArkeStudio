import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { until } from "./wait.js";

/**
 * A pin change runs the new release's migrations, forward only, over a profile people have signed
 * in to, and the other protocol tests all start from an empty one. So: make the profile with the
 * outgoing release, then open it with the pinned one. Set ARKE_TEST_OPENCODE2_PREVIOUS to the
 * outgoing executable to run this. Synthetic credentials and a scripted provider, so nothing here
 * refreshes a token or spends anything, and it does not prove a vendor still honours a sign-in.
 */
const MODEL = "arke-smoke";
const SYNTHETIC_KEY = "synthetic-upgrade-key";
const SYNTHETIC_OAUTH = "synthetic-upgrade-oauth-access";

interface Engine {
  child: ChildProcess;
  request: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: { version?: string; data?: unknown } }>;
}

async function start(executable: string, profile: string, cwd: string): Promise<Engine> {
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const address = socket.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, { HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: join(profile, ".config"), XDG_DATA_HOME: join(profile, ".local", "share") });
  const child = spawn(executable, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let password: string | null = null, pending = "", failed = false;
  child.on("error", () => { failed = true; }); child.stderr!.resume();
  child.stdout!.on("data", data => {
    pending += String(data);
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
    for (const line of lines) { const match = /^server password (\S+)$/.exec(line.trim()); if (match) password = match[1]!; }
  });
  try {
    await until(() => password !== null || failed || child.exitCode !== null, "the runtime to launch", 45_000);
    assert.ok(password && !failed && child.exitCode === null, `the runtime exited with ${child.exitCode}`);
  } catch (error) { child.kill(); throw error; }
  const request: Engine["request"] = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  };
  return { child, request };
}

async function stop(engine: Engine): Promise<void> {
  // A killed child reports a signal and keeps a null exit code, and its exit event has gone.
  if (engine.child.exitCode !== null || engine.child.signalCode !== null) return;
  const exited = once(engine.child, "exit"); engine.child.kill(); await exited;
}

type Row = { id: string; methods?: Array<{ type?: string; id?: string }>; connections?: Array<{ type?: string; id?: string }> };
const integrations = async (engine: Engine) => (await engine.request("GET", "/api/integration")).body.data as Row[];
const assistantText = async (engine: Engine, session: string) => {
  const rows = (await engine.request("GET", `/api/session/${session}/message`)).body.data as Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  return rows.filter(row => row.type === "assistant").flatMap(row => row.content ?? []).filter(part => part.type === "text").map(part => part.text).join("|");
};

async function databaseFile(profile: string): Promise<string> {
  const directory = join(profile, ".local", "share", "opencode");
  const names = await readdir(directory);
  const name = names.find(entry => /^opencode.*\.db$/.test(entry));
  assert.ok(name, `no database in ${names.join(", ")}`);
  return join(directory, name);
}

it("keeps sign-ins and sessions when the pinned runtime opens the outgoing release's profile", {
  skip: !process.env["ARKE_TEST_OPENCODE2"] || !process.env["ARKE_TEST_OPENCODE2_PREVIOUS"], timeout: 180_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "arke-profile-upgrade-"));
  const cwd = join(profile, "session"); await mkdir(cwd);
  let replies = 0;
  const provider = httpServer((req, res) => {
    let body = "";
    req.on("data", data => { body += String(data); });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, modified_at: "2026-11-05T00:00:00Z", size: 1, digest: MODEL, details: { format: "gguf", family: "gemma", parameter_size: "12B", quantization_level: "Q4_K_M" } }] })); return; }
      if (req.url === "/api/show") { res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "general.architecture": "gemma", "gemma.context_length": 262144 } })); return; }
      if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      const parsed = JSON.parse(body) as { tools?: unknown[] };
      if (parsed.tools?.length) replies++;
      const chunk = (delta: unknown, finish: string | null) => ({ id: "chatcmpl_upgrade", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(chunk({ content: parsed.tools?.length ? `Reply ${replies}.` : "Title" }, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const providerAddress = provider.address(); assert.ok(providerAddress && typeof providerAddress !== "string");
  await mkdir(join(profile, ".config", "opencode"), { recursive: true });
  await writeFile(join(profile, ".config", "opencode", "opencode.json"), JSON.stringify({ providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${providerAddress.port}/v1` } } } }));
  await writeFile(join(cwd, "opencode.json"), JSON.stringify({ default_agent: "build" }));
  const directory = cwd.replaceAll("\\", "/");
  const location = { directory };
  const scoped = new URLSearchParams({ "location[directory]": directory });
  const engines: Engine[] = [];
  const launch = async (executable: string) => { const engine = await start(executable, profile, cwd); engines.push(engine); return engine; };
  const prompt = async (engine: Engine, session: string, text: string, expected: number) => {
    const sent = await engine.request("POST", `/api/session/${session}/prompt`, { id: `msg_${Date.now().toString(16)}${"d".repeat(20)}`, text });
    assert.equal(sent.status, 200);
    await until(() => replies >= expected, `reply ${expected} to reach the provider`, 30_000);
  };
  const waitForModel = async (engine: Engine) => {
    for (let waited = 0; waited < 30_000; waited += 100) {
      const models = await engine.request("GET", `/api/model?${scoped}`);
      if ((models.body.data as Array<{ id: string }> | undefined)?.some(model => model.id === MODEL)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail("the scripted model never appeared");
  };
  try {
    // The outgoing release makes the profile: a stored key and a conversation.
    const previous = await launch(process.env["ARKE_TEST_OPENCODE2_PREVIOUS"]!);
    const previousVersion = (await previous.request("GET", "/api/info")).body.version;
    // The integration list fills in after spawn; a connection before then is refused.
    for (let waited = 0; waited < 30_000 && !(await integrations(previous))?.some(row => row.id === "anthropic"); waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
    const connected = await previous.request("POST", "/api/integration/anthropic/connect/key", { key: SYNTHETIC_KEY });
    assert.ok(connected.status < 300, `connect/key answered ${connected.status}: ${JSON.stringify(connected.body)}`);
    await waitForModel(previous);
    const session = (await previous.request("POST", "/api/session", { location, model: { providerID: "ollama", id: MODEL } })).body.data as { id: string };
    await prompt(previous, session.id, "First message.", 1);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const stored = (await integrations(previous)).find(row => row.id === "anthropic")?.connections?.find(row => row.type === "credential");
    assert.ok(stored?.id, "the outgoing release lists the stored key");
    const methodID = (await integrations(previous)).find(row => row.id === "openai")?.methods?.find(row => row.type === "oauth")?.id;
    assert.ok(methodID, "the outgoing release offers a sign-in");
    await stop(previous);

    // The outgoing release's database, as it left it: an OAuth row beside the key, by hand, because
    // only a vendor can issue one and that is the row a person would be signed out by losing.
    const { DatabaseSync } = await import("node:sqlite");
    const database = await databaseFile(profile);
    const before = new DatabaseSync(database);
    const keyRow = before.prepare("SELECT * FROM credential").get() as Record<string, string | number | null>;
    assert.ok(String(keyRow["value"] ?? keyRow["data"]).includes(SYNTHETIC_KEY), JSON.stringify(Object.keys(keyRow)));
    const column = "value" in keyRow ? "value" : "data";
    const oauth = { ...keyRow, id: `${keyRow["id"]}oauth`, integration_id: "openai", [column]: JSON.stringify({ type: "oauth", methodID, access: SYNTHETIC_OAUTH, refresh: "synthetic-refresh", expires: Date.now() + 86_400_000 }) };
    const names = Object.keys(oauth);
    before.prepare(`INSERT INTO credential (${names.map(name => `"${name}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map(name => oauth[name] as string | number | null));
    before.close();

    // The pinned release opens it. Everything must survive the migrations.
    const pinned = await launch(process.env["ARKE_TEST_OPENCODE2"]!);
    const pinnedVersion = (await pinned.request("GET", "/api/info")).body.version;
    assert.notEqual(pinnedVersion, previousVersion, "this test compares two releases");
    const upgraded = await integrations(pinned);
    assert.ok(upgraded.find(row => row.id === "anthropic")?.connections?.some(row => row.type === "credential" && row.id === stored.id), "a stored key survives");
    assert.ok(upgraded.find(row => row.id === "openai")?.connections?.some(row => row.type === "credential"), "a stored sign-in survives");
    assert.equal(await assistantText(pinned, session.id), "Reply 1.", "an old conversation still reads");
    await waitForModel(pinned);
    await prompt(pinned, session.id, "Second message.", 2);
    await until(() => replies >= 2, "the upgraded session to answer");
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal((await assistantText(pinned, session.id)).split("|").sort().join("|"), "Reply 1.|Reply 2.", "an old conversation carries on");
    await stop(pinned);

    const after = new DatabaseSync(database, { readOnly: true });
    const rows = after.prepare("SELECT * FROM credential").all() as Array<Record<string, unknown>>;
    after.close();
    assert.ok(rows.some(row => JSON.stringify(row).includes(SYNTHETIC_KEY)), "the key's bytes are unchanged");
    assert.ok(rows.some(row => JSON.stringify(row).includes(SYNTHETIC_OAUTH)), "the sign-in's bytes are unchanged");

    // Going back is what an app rollback would do. It need not work, but what it does is on record.
    const rolledBack = await launch(process.env["ARKE_TEST_OPENCODE2_PREVIOUS"]!).catch((error: unknown) => error instanceof Error ? error.message : String(error));
    if (typeof rolledBack === "string") { console.log(`[profile-upgrade] rollback did not launch: ${rolledBack}`); return; }
    const reopened = await integrations(rolledBack);
    console.log(`[profile-upgrade] rollback launched; key listed: ${reopened.find(row => row.id === "anthropic")?.connections?.some(row => row.type === "credential")}; sign-in listed: ${reopened.find(row => row.id === "openai")?.connections?.some(row => row.type === "credential")}`);
    const old = await rolledBack.request("GET", `/api/session/${session.id}/message`);
    console.log(`[profile-upgrade] rollback reads the conversation: ${old.status}, rows ${(old.body.data as unknown[] | undefined)?.length ?? "none"}`);
  } finally {
    for (const engine of engines) await stop(engine);
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
