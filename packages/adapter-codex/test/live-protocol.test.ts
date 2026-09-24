import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/codex-adapter.js";
import { discoverCodex } from "../src/discovery.js";
import { object, type JsonObject } from "../src/rpc.js";
import type { HarnessEvent } from "@arke-studio/contracts";

/**
 * Opt-in release smoke: a real user-installed binary, isolated profile and model metadata,
 * but every generation request goes to this scripted localhost provider. No credentials are
 * copied and no paid turn is sent. The captured request is the actual model-visible tool set.
 */
test("verified real app-server confines every selected model profile and delivers image content directly", {
  skip: !process.env.ARKE_CODEX_SMOKE_COMMAND || !process.env.ARKE_CODEX_SMOKE_CATALOG,
  timeout: 120_000,
}, async t => {
  const discovery = await discoverCodex({ configuredPath: process.env.ARKE_CODEX_SMOKE_COMMAND });
  assert.ok(discovery.found, discovery.reason ?? "Codex unavailable");
  const root = await mkdtemp(join(tmpdir(), "arke-codex-protocol-"));
  const profile = join(root, "profile"); const proposal = join(root, "proposal");
  await mkdir(profile); await mkdir(proposal);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZklEQVR42u3QQREAAAQAMEm89T/9yOHssQKLzprPQoAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECLhvAVR6kdJApJA8AAAAAElFTkSuQmCC";
  await writeFile(join(proposal, "frame.png"), Buffer.from(png, "base64"));
  const sentinel = "ARKE_OUTSIDE_SENTINEL_MUST_NOT_APPEAR";
  await writeFile(join(root, "outside.txt"), sentinel);
  await writeFile(join(proposal, "AGENTS.md"), "ARKE_UNREQUESTED_PROJECT_INSTRUCTIONS");
  await mkdir(join(profile, "skills", "unrequested"), { recursive: true });
  await writeFile(join(profile, "skills", "unrequested", "SKILL.md"), "---\nname: unrequested\ndescription: ARKE_UNREQUESTED_SKILL\n---\nDo something unrelated.");
  const metadata = object(JSON.parse(await readFile(process.env.ARKE_CODEX_SMOKE_CATALOG!, "utf8")));
  assert.ok(Array.isArray(metadata.models));
  await writeFile(join(profile, "models.json"), JSON.stringify({ models: metadata.models }));
  const captured: JsonObject[] = []; let call = 0; let mode: "image" | "question" | "code" = "image"; let phaseCall = 0;
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const data of req) raw += data;
      const body = object(JSON.parse(raw)); captured.push(body); call++; phaseCall++;
      const response = { id: `resp_${call}`, object: "response", created_at: 1, status: "completed", model: body.model,
        output: phaseCall === 1
          ? [mode === "code"
            ? { type: "custom_tool_call", id: `fc_${call}`, call_id: `call_${call}`, namespace: "functions", name: "exec", input: 'text("ARKE_CODE_MODE_HELPER_OK"); text({process:typeof process, require:typeof require});' }
            : { type: "function_call", id: `fc_${call}`, call_id: `call_${call}`, namespace: mode === "image" ? "arke" : "functions", name: mode === "image" ? "read" : "request_user_input_async", arguments: mode === "image" ? '{"path":"frame.png"}' : '{"questions":[{"title":"This protocol probe must be refused."}]}' }]
          : [{ id: `msg_${call}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Image inspected.", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: response.output[0] },
        { type: "response.output_item.done", output_index: 0, item: response.output[0] },
        { type: "response.completed", response },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await writeFile(join(profile, "config.toml"), [
    'model_provider = "arke-probe"', `model_catalog_json = ${JSON.stringify(join(profile, "models.json"))}`,
    '[model_providers.arke-probe]', 'name = "Arke protocol smoke"', `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false',
    '[mcp_servers."unsafe.name"]', `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify(["-e", `require('node:fs').writeFileSync(${JSON.stringify(join(root, "escaped.txt"))}, 'MCP_SHOULD_NOT_START')`])}`,
    'enabled = true',
  ].join("\n"));
  const requestsFromServer: string[] = [];
  const adapter = new CodexAdapter({ command: discovery.found.command, args: discovery.found.args,
    onTrace: line => { if (line.at === "codex.server-request") requestsFromServer.push(String(line.method)); },
    env: { ...process.env, CODEX_HOME: profile, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, requestTimeoutMs: 15_000 });
  t.after(async () => {
    await adapter.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    // Codex's short-lived helper closes SQLite handles asynchronously after process exit.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await adapter.init();
  const events: HarnessEvent[] = []; const eventAbort = new AbortController();
  const drain = (async () => { for await (const event of adapter.streamEvents(eventAbort.signal)) events.push(event); })();
  t.after(async () => { eventAbort.abort(); await drain; });
  const models = await adapter.listModels();
  assert.ok(models.length >= 2, "The smoke needs current Codex model metadata for at least two different tool profiles.");
  for (const model of models) {
    mode = "image"; phaseCall = 0;
    const preparationId = `probe-${model.id}`; adapter.prepareSession({ preparationId, model: `${model.provider}/${model.id}` });
    const session = await adapter.createSession({ preparationId, cwd: proposal, purpose: "ask", agent: "world-builder" });
    const before = captured.length;
    await adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "Read frame.png with arke.read, then say image inspected." }] });
    const requests = captured.slice(before); assert.equal(requests.length, 2, model.id);
    const initial = requests[0]!;
    const additional = Array.isArray(initial.input) ? initial.input.find(value => object(value).type === "additional_tools") : undefined;
    const tools = (Array.isArray(initial.tools) ? initial.tools : object(additional).tools) as unknown[];
    assert.ok(Array.isArray(tools));
    let questionTool = false;
    for (const raw of tools) {
      const tool = object(raw); assert.ok(["arke", "functions"].includes(String(tool.name)), `Unexpected namespace ${String(tool.name)} for ${model.id}`);
      if (tool.name === "arke") {
        assert.deepEqual((tool.tools as unknown[]).map(value => object(value).name).sort(), ["list", "read", "search"]);
      } else {
        const nested = tool.tools as unknown[];
        assert.ok(nested.every(value => ["exec", "wait", "request_user_input_async"].includes(String(object(value).name))), JSON.stringify(nested.map(value => object(value).name)));
        questionTool ||= nested.some(value => object(value).name === "request_user_input_async");
        for (const value of nested) {
          const description = object(value).description;
          const nestedNames = typeof description === "string" ? [...description.matchAll(/^### `([^`]+)`/gm)].map(match => match[1]) : [];
          assert.ok(nestedNames.every(name => name === "clock__curr_time"), `Unexpected nested tools for ${model.id}: ${nestedNames.join(", ")}`);
        }
      }
    }
    const delivered = JSON.stringify(requests[1]);
    assert.ok(delivered.includes('"type":"input_image"'), JSON.stringify((requests[1]!.input as unknown[])?.filter(value => object(value).type === "function_call_output"))); assert.ok(delivered.includes(png));
    assert.doesNotMatch(delivered, new RegExp(sentinel));
    assert.ok(!delivered.includes("ARKE_UNREQUESTED_PROJECT_INSTRUCTIONS") && !delivered.includes("ARKE_UNREQUESTED_SKILL"), JSON.stringify({ project: delivered.includes("ARKE_UNREQUESTED_PROJECT_INSTRUCTIONS"), skill: delivered.includes("ARKE_UNREQUESTED_SKILL") }));
    if (questionTool) {
      mode = "question"; phaseCall = 0;
      await new Promise<void>(resolve => setImmediate(resolve));
      const beforeEvents = events.length;
      await assert.rejects(adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "Exercise the unavailable question tool, then finish." }] }), /question tool is not available/);
      await new Promise<void>(resolve => setImmediate(resolve));
      const refusal = events.slice(beforeEvents);
      assert.ok(refusal.some(event => event.type === "tool.refused"));
      assert.ok(refusal.some(event => event.type === "session.error"));
      assert.equal(refusal.some(event => event.type === "message.completed"), false);
    }
    if (model.id === models[0]!.id) {
      // Exercise the sibling helper too: direct image calls alone do not start code mode.
      mode = "code"; phaseCall = 0;
      await adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "Exercise the pure JavaScript helper, then finish." }] });
      const helperOutput = JSON.stringify((captured.at(-1)!.input as unknown[]).filter(value => object(value).type === "custom_tool_call_output"));
      assert.ok(helperOutput.includes("ARKE_CODE_MODE_HELPER_OK"), helperOutput);
      assert.ok(helperOutput.includes('process\\\":\\\"undefined') && helperOutput.includes('require\\\":\\\"undefined'), helperOutput);
    }
    t.diagnostic(`${model.id}: confined tools and direct image delivery verified${questionTool ? "; native asynchronous question refused and turn failed explicitly" : ""}.`);
  }
  assert.equal(await readFile(join(root, "outside.txt"), "utf8"), sentinel);
  await assert.rejects(access(join(root, "escaped.txt")), /ENOENT/);
});
