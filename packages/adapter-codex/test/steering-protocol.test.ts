import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRpc, object, type JsonObject } from "../src/rpc.js";
import { confinedConfig } from "../src/codex-adapter.js";
import { runCodexDiscoveryCommand } from "../src/discovery.js";

/** A protocol investigation, not a release capability: no login or remote model is used. */
test("real Codex steering correlates an active input with the actual next model request", {
  skip: !process.env.ARKE_CODEX_STEERING_COMMAND || !process.env.ARKE_CODEX_SMOKE_CATALOG,
  timeout: 90_000,
}, async t => {
  const command = process.env.ARKE_CODEX_STEERING_COMMAND!;
  const version = await runCodexDiscoveryCommand(command, ["--version"], 5000);
  assert.equal(version.status, 0);
  const hash = createHash("sha256").update(await readFile(command)).digest("hex");
  t.diagnostic(`${version.stdout.trim()}; sha256:${hash}`);
  const root = await mkdtemp(join(tmpdir(), "arke-steering-probe-"));
  const profile = join(root, "profile"); await mkdir(profile);
  const metadata = object(JSON.parse(await readFile(process.env.ARKE_CODEX_SMOKE_CATALOG!, "utf8")));
  assert.ok(Array.isArray(metadata.models));
  await writeFile(join(profile, "models.json"), JSON.stringify({ models: metadata.models }));
  const captured: JsonObject[] = [];
  const held: ServerResponse[] = [];
  const notifications: { method: string; params: JsonObject }[] = [];
  let automatic = false;
  const finish = (res: ServerResponse, index: number) => {
    const item = { id: `msg_${index}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Synthetic response.", annotations: [] }] };
    const response = { id: `resp_${index}`, object: "response", created_at: 1, status: "completed",
      model: captured[index]!.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    for (const event of [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }]) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  };
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      captured.push(object(JSON.parse(raw)));
      res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
      held.push(res);
      if (automatic) finish(res, captured.length - 1);
    } catch { res.writeHead(500).end(); }
  });
  let rpc: CodexRpc | undefined;
  t.after(async () => {
    await rpc?.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await writeFile(join(profile, "config.toml"), [
    'model_provider = "arke-probe"', `model_catalog_json = ${JSON.stringify(join(profile, "models.json"))}`,
    '[model_providers.arke-probe]', 'name = "Arke steering probe"', `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false',
  ].join("\n"));
  rpc = new CodexRpc({ command, env: { ...process.env, CODEX_HOME: profile,
    OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, requestTimeoutMs: 15_000,
    onNotification: (method, params) => notifications.push({ method, params }),
    onRequest: async () => { throw new Error("No tools are needed for this probe."); }, onFailure: () => {},
  });
  const until = async (predicate: () => boolean, reason: string) => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, reason);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await rpc.start();
  await rpc.request("initialize", { clientInfo: { name: "arke_steering_probe", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  await rpc.write({ method: "initialized" });
  const catalog = object(await rpc.request("model/list", { limit: 100 }));
  assert.ok(Array.isArray(catalog.data) && catalog.data.length);
  const model = object(catalog.data[0]).model;
  const started = object(await rpc.request("thread/start", { model, modelProvider: "arke-probe", cwd: root,
    ephemeral: true, environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [],
    sandbox: "read-only", approvalPolicy: "untrusted", baseInstructions: "Return a short synthetic reply.",
    developerInstructions: "", config: confinedConfig({}, false), dynamicTools: [],
  }));
  const threadId = object(started.thread).id; assert.equal(typeof threadId, "string");
  const turn = object(object(await rpc.request("turn/start", { threadId,
    input: [{ type: "text", text: "Initial synthetic direction." }], environments: [] })).turn);
  const turnId = turn.id; assert.equal(typeof turnId, "string");
  await until(() => captured.length === 1, "initial model request was not observed");
  await assert.rejects(rpc.request("turn/steer", { threadId, expectedTurnId: "wrong-turn",
    clientUserMessageId: "wrong-input", input: [{ type: "text", text: "MUST_NOT_REACH_MODEL" }] }));
  const correction = "ARKE_CORRECTION_USE_QUIET_BELLS";
  const receipt = object(await rpc.request("turn/steer", { threadId, expectedTurnId: turnId,
    clientUserMessageId: "correction-1", input: [{ type: "text", text: correction }] }));
  assert.equal(receipt.turnId, turnId, "steering must remain on the original execution");
  automatic = true;
  for (const [index, res] of held.entries()) if (!res.writableEnded) finish(res, index);
  await until(() => notifications.some(event => event.method === "turn/completed" && object(event.params.turn).id === turnId), "original turn did not complete");
  assert.ok(captured.length >= 2, "acceptance alone is not model inclusion");
  assert.ok(captured.slice(1).some(body => JSON.stringify(body.input).includes(correction)), "the model never received the correction");
  assert.ok(captured.every(body => !JSON.stringify(body.input).includes("MUST_NOT_REACH_MODEL")));
  const included = notifications.filter(event => event.method === "item/completed" && event.params.turnId === turnId &&
    object(event.params.item).type === "userMessage" && object(event.params.item).clientId === "correction-1");
  assert.equal(included.length, 1, "one correlated native user item is required");
  await assert.rejects(rpc.request("turn/steer", { threadId, expectedTurnId: turnId,
    clientUserMessageId: "late-input", input: [{ type: "text", text: "Must not start a successor." }] }));
  // Lose local observation of a receipt after writing the request. Recovery observes the
  // same client identity; it never repeats turn/steer or creates another native turn.
  automatic = false;
  const beforeLost = captured.length;
  const lostTurn = object(object(await rpc.request("turn/start", { threadId,
    input: [{ type: "text", text: "Lost receipt probe." }], environments: [] })).turn).id;
  await until(() => captured.length > beforeLost, "lost-receipt turn never reached the model");
  const receiptAbort = new AbortController();
  let lateReceipt: unknown;
  const lostReceipt = rpc.request("turn/steer", { threadId, expectedTurnId: lostTurn,
    clientUserMessageId: "lost-receipt-input", input: [{ type: "text", text: "ARKE_LOST_RECEIPT_CORRECTION" }] }, receiptAbort.signal, result => { lateReceipt = result; });
  receiptAbort.abort();
  await assert.rejects(lostReceipt, /cancelled/);
  await until(() => lateReceipt !== undefined, "the written steer request never reached native admission");
  assert.equal(object(lateReceipt).turnId, lostTurn);
  automatic = true;
  for (const [index, res] of held.entries()) if (!res.writableEnded && !res.destroyed) finish(res, index);
  await until(() => notifications.some(event => event.method === "turn/completed" && object(event.params.turn).id === lostTurn), "lost-receipt turn did not finish");
  assert.ok(captured.slice(beforeLost + 1).some(body => JSON.stringify(body.input).includes("ARKE_LOST_RECEIPT_CORRECTION")));
  assert.equal(notifications.filter(event => event.method === "item/completed" && event.params.turnId === lostTurn &&
    object(event.params.item).clientId === "lost-receipt-input").length, 1);

  automatic = false;
  const beforeInterrupt = captured.length;
  const interruptedTurn = object(object(await rpc.request("turn/start", { threadId,
    input: [{ type: "text", text: "Interrupt while the model is held." }], environments: [] })).turn).id;
  await until(() => captured.length > beforeInterrupt, "interrupt probe never reached the model");
  await rpc.request("turn/interrupt", { threadId, turnId: interruptedTurn });
  await until(() => notifications.some(event => event.method === "turn/completed" &&
    object(event.params.turn).id === interruptedTurn && object(event.params.turn).status === "interrupted"), "interrupt had no correlated terminal event");
  await assert.rejects(rpc.request("turn/steer", { threadId, expectedTurnId: interruptedTurn,
    clientUserMessageId: "after-interrupt", input: [{ type: "text", text: "Must not restart work." }] }));
  t.diagnostic("Active targeting, native client-id correlation, actual model inclusion, lost-receipt observation, interruption and stale-turn rejection verified. This is not full release qualification.");
});
