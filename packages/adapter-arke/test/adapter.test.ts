import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessEventSchema, type HarnessEvent } from "@arke-studio/contracts";
import { TRIMMED_TOOL_RESULT } from "../src/context.js";
import { ArkeAdapter, loopbackBaseUrl } from "../src/index.js";
import { callTool, FakeOllama, reply, say } from "./fake-ollama.js";

async function fixture(t: test.TestContext, options: { maxStepsPerTurn?: number; catalogueDeadlineMs?: number; maxContextTokens?: number } = {}) {
  const ollama = new FakeOllama(); await ollama.start();
  const base = await mkdtemp(join(tmpdir(), "arke-harness-")); const root = join(base, "proposal");
  await mkdir(root); await writeFile(join(base, "secret.txt"), "SECRET_MUST_NOT_LEAK");
  const adapter = new ArkeAdapter({ baseUrl: ollama.url, ...options });
  const events: HarnessEvent[] = [];
  const listening = new AbortController();
  void (async () => { for await (const event of adapter.streamEvents(listening.signal)) events.push(event); })();
  t.after(async () => { listening.abort(); await adapter.dispose(); await ollama.stop(); await rm(base, { recursive: true, force: true }); });
  let prepared = 0;
  const session = async (agent: string, config: Record<string, unknown> = {}) => {
    const preparationId = `prep-${++prepared}`;
    adapter.prepareSession({ preparationId, ...config });
    return (await adapter.createSession({ purpose: "authoring", agent, cwd: root, preparationId })).sessionId;
  };
  const ended = (sessionId: string) => new Promise<HarnessEvent>((resolve) => {
    const poll = () => { const found = events.find((e) => e.type === "session.ended" && e.sessionId === sessionId); if (found) resolve(found); else setTimeout(poll, 5); };
    poll();
  });
  return { ollama, adapter, root, base, events, session, ended };
}

test("lists pulled models in the contract's terms, and names a tool-calling one the default", async (t) => {
  const f = await fixture(t);
  f.ollama.models = [
    { name: "nomic-embed-text", capabilities: ["embedding"] },
    { name: "short:8b", capabilities: ["completion", "tools"], context: 131072 },
    { name: "chatty:7b", capabilities: ["completion"], context: 262144 },
    { name: "qwen3-vl:8b", capabilities: ["completion", "tools", "vision"], context: 1048576 },
  ];
  await f.adapter.init();
  assert.equal(f.adapter.readiness().ready, true);
  assert.deepEqual(await f.adapter.listModels(), [
    { id: "chatty:7b", provider: "ollama", displayName: "chatty:7b", inputModalities: ["text"], inputTokenLimit: 32768, tools: false },
    { id: "qwen3-vl:8b", provider: "ollama", displayName: "qwen3-vl:8b", inputModalities: ["text", "image"], inputTokenLimit: 32768, tools: true, isDefault: true },
  ], "only models stating 256k or more; the limit is the window a session will get; a model that cannot call tools says so");
});

test("a turn streams, completes, and ends with a stated reason; every event parses", async (t) => {
  const f = await fixture(t);
  const id = await f.session("world-builder");
  f.ollama.script.push(reply("The harbour town is Saltlight."));
  const receipt = await f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "Name the town." }], correlationId: "c-1" });
  assert.equal(receipt.correlationId, "c-1");
  await f.ended(id);
  const own = f.events.filter((e) => "sessionId" in e && e.sessionId === id);
  assert.deepEqual(own.map((e) => e.type), ["session.created", "message.delta", "message.delta", "message.completed", "session.ended"]);
  assert.deepEqual(own.at(-2), { type: "message.completed", sessionId: id, correlationId: "c-1", text: "The harbour town is Saltlight." });
  assert.deepEqual(own.at(-1), { type: "session.ended", sessionId: id, reason: "completed" });
  for (const event of f.events) HarnessEventSchema.parse(event);
  assert.equal(f.adapter.usageTokens(id), 110);
  const request = f.ollama.chats[0]!;
  assert.equal(request.model, "gemma4:12b");
  assert.equal(request.stream, true);
  assert.deepEqual(request.options, { num_ctx: 32768 }, "the model's own context, held to the ceiling");
  assert.equal(f.adapter.knownInputTokenLimit(id), 32768);
  const messages = request.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]!.role, "system");
  assert.deepEqual(messages.at(-1), { role: "user", content: "Name the town." });
});

test("only the tools the confinement permits are offered", async (t) => {
  const f = await fixture(t);
  const authoring = await f.session("sheet-editor");
  f.ollama.script.push(reply("ok"));
  await f.adapter.sendMessage({ sessionId: authoring, parts: [{ type: "text", text: "hi" }] });
  const readOnly = await f.session("world-builder");
  f.ollama.script.push(reply("ok"));
  await f.adapter.sendMessage({ sessionId: readOnly, parts: [{ type: "text", text: "hi" }] });
  const names = (i: number) => (f.ollama.chats[i]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  assert.deepEqual(names(0), ["read", "list", "search", "write", "edit"]);
  assert.deepEqual(names(1), ["read", "list", "search"], "a read-only role is never shown a way to write");
});

test("the loop runs a tool inside the session, answers the model, and reports the activity", async (t) => {
  const f = await fixture(t);
  const id = await f.session("sheet-editor");
  f.ollama.script.push(callTool("write", { path: "notes/town.md", content: "Saltlight" }), reply("Written."));
  await f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "Write it down." }] });
  assert.equal(await readFile(join(f.root, "notes", "town.md"), "utf8"), "Saltlight");
  assert.ok(f.events.some((e) => e.type === "tool.activity" && e.sessionId === id && e.tool === "arke.write"));
  const second = f.ollama.chats[1]!.messages as Array<{ role: string; content: string; tool_name?: string; tool_calls?: unknown }>;
  assert.ok(second.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls)), "the model's call is in the history it is shown");
  assert.deepEqual(second.at(-1), { role: "tool", tool_name: "write", content: "Updated town.md." });
  assert.deepEqual(f.events.findLast((e) => e.type === "message.completed" && e.sessionId === id), { type: "message.completed", sessionId: id, correlationId: (f.events.find((e) => e.type === "message.delta") as { correlationId: string }).correlationId, text: "Written." });
});

test("a call outside the confinement is refused, reported, and changes nothing", async (t) => {
  const f = await fixture(t);
  const id = await f.session("world-builder");
  f.ollama.script.push(callTool("write", { path: "x.md", content: "bad" }), callTool("read", { path: "../secret.txt" }), reply("Could not."));
  await f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "Try it." }] });
  await assert.rejects(stat(join(f.root, "x.md")), "nothing was written");
  assert.equal(f.events.filter((e) => e.type === "tool.refused" && e.sessionId === id).length, 2);
  const told = (f.ollama.chats.at(-1)!.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "tool");
  assert.deepEqual(told.map((m) => m.content), ["Denied by Arke Studio confinement.", "Denied by Arke Studio confinement."]);
  assert.ok(!JSON.stringify(f.ollama.chats).includes("SECRET_MUST_NOT_LEAK"), "the file outside the session never reached the model");
});

test("interrupt stops the generation itself and ends the turn as cancelled", async (t) => {
  const f = await fixture(t);
  const id = await f.session("world-builder");
  f.ollama.script.push({ hang: true, chunks: [{ message: { role: "assistant", content: "Once upon" }, done: false }] });
  const sent = f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "Tell me." }] });
  while (!f.events.some((e) => e.type === "message.delta" && e.sessionId === id)) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.adapter.interrupt(id);
  await assert.rejects(sent, /Stopped/);
  assert.deepEqual(await f.ended(id), { type: "session.ended", sessionId: id, reason: "cancelled", detail: "Stopped." });
  while (f.ollama.aborted === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(!f.events.some((e) => e.type === "message.completed" && e.sessionId === id), "half a reply is not a reply");
});

test("a turn that keeps calling tools ends at its step limit, with the reason stated", async (t) => {
  const f = await fixture(t, { maxStepsPerTurn: 2 });
  const id = await f.session("sheet-editor");
  f.ollama.script.push(callTool("list", {}), callTool("list", {}), reply("never reached"));
  await assert.rejects(f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "Look around." }] }), /limit of 2/);
  const ending = await f.ended(id);
  assert.equal(ending.type === "session.ended" && ending.reason, "budget-exceeded");
  assert.equal(f.ollama.chats.length, 2);
});

test("a refused request is a session error with Ollama's reason, and a stream that stops short is not a reply", async (t) => {
  const f = await fixture(t);
  const id = await f.session("world-builder");
  f.ollama.script.push({ status: 404, error: "model 'gemma4:12b' not found" });
  await assert.rejects(f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "hi" }] }), /not found/);
  assert.ok(f.events.some((e) => e.type === "session.error" && e.sessionId === id && /not found/.test(e.message)));
  f.ollama.script.push({ chunks: [{ message: { role: "assistant", content: "half" }, done: false }] });
  await assert.rejects(f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "again" }] }), /before it finished/);
});

test("the chosen model is the one asked for; one not pulled, or under 256k, is refused before any session exists", async (t) => {
  const f = await fixture(t);
  f.ollama.models.push({ name: "qwen3:8b", capabilities: ["completion", "tools"], context: 262144 }, { name: "short:8b", capabilities: ["completion", "tools"], context: 131072 });
  const id = await f.session("canon-qa", { model: "ollama/qwen3:8b" });
  f.ollama.script.push(reply("ok"));
  await f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "hi" }] });
  assert.equal(f.ollama.chats[0]!.model, "qwen3:8b");
  assert.deepEqual(f.ollama.chats[0]!.options, { num_ctx: 32768 });
  await assert.rejects(f.session("world-builder", { model: "ollama/absent:1b" }), /not pulled/);
  await assert.rejects(f.session("canon-qa", { model: "ollama/short:8b" }), /under 256k tokens/, "pulled, but not offered, and told why");
});

test("a window that cannot hold the role's prompt is refused before a session exists, not truncated on every turn", async (t) => {
  const f = await fixture(t, { maxContextTokens: 8192 });
  await assert.rejects(f.session("world-builder"), /too small for this role's instructions/);
});

test("Ollama is reached on this machine only, unless a remote host is an explicit setting", () => {
  assert.equal(loopbackBaseUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(loopbackBaseUrl("http://localhost:11434/"), "http://localhost:11434");
  assert.throws(() => loopbackBaseUrl("http://10.0.0.5:11434"), /this machine/);
  assert.throws(() => new ArkeAdapter({ baseUrl: "http://gpu-box:11434" }), /this machine/);
  assert.equal(loopbackBaseUrl("http://gpu-box:11434", true), "http://gpu-box:11434");
  assert.throws(() => loopbackBaseUrl("http://user:pw@127.0.0.1:11434"), /plain host/);
});

test("a turn stopped between tool calls leaves every call answered, so the next turn's history is well formed", async (t) => {
  const f = await fixture(t);
  const id = await f.session("sheet-editor");
  f.ollama.script.push({ hang: true });
  const sent = f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "Go." }] });
  while (f.ollama.chats.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.adapter.interrupt(id);
  await assert.rejects(sent, /Stopped/);
  // The window between two calls of one reply cannot be hit from outside, so set it up directly:
  // a reply asked for two tools and the turn stopped after the first was answered.
  const session = (f.adapter as unknown as { sessions: Map<string, { messages: Array<Record<string, unknown>> }> }).sessions.get(id)!;
  session.messages.push(
    { role: "assistant", content: "", tool_calls: [{ function: { name: "list", arguments: {} } }, { function: { name: "read", arguments: { path: "a.md" } } }] },
    { role: "tool", tool_name: "list", content: "(empty)" },
  );
  (f.adapter as unknown as { answerUnrun(session: unknown): void }).answerUnrun(session);
  f.ollama.script.push(reply("Again."));
  await f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "Again." }] });
  const history = f.ollama.chats.at(-1)!.messages as Array<{ role: string; content: string; tool_name?: string }>;
  assert.deepEqual(history.slice(-3), [
    { role: "tool", tool_name: "list", content: "(empty)" },
    { role: "tool", tool_name: "read", content: "Not run: the turn was stopped first." },
    { role: "user", content: "Again." },
  ]);
});

test("a prompt-only role is sent no tools, so a model that cannot call them can still answer", async (t) => {
  const f = await fixture(t);
  const id = await f.session("conversation-namer");
  f.ollama.script.push(reply('{"title":"Saltlight"}'));
  await f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "Name it." }] });
  assert.equal(f.ollama.chats[0]!.tools, undefined);
});

test("a reply cut off at the length limit is not a finished reply", async (t) => {
  const f = await fixture(t);
  const id = await f.session("world-builder");
  f.ollama.script.push({ chunks: [
    { message: { role: "assistant", content: '{"reply":"The town' }, done: false },
    { message: { role: "assistant", content: "" }, done: true, done_reason: "length", prompt_eval_count: 10, eval_count: 10 },
  ] });
  await assert.rejects(f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "hi" }] }), /length limit/);
  const ending = await f.ended(id);
  assert.equal(ending.type === "session.ended" && ending.reason, "budget-exceeded");
  assert.ok(!f.events.some((e) => e.type === "message.completed" && e.sessionId === id));
});

test("losing Ollama mid-session is visible in readiness and the revision", async (t) => {
  const f = await fixture(t);
  await f.adapter.init();
  const id = await f.session("world-builder");
  const revision = f.adapter.lifecycleRevision();
  await f.ollama.stop();
  await assert.rejects(f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "hi" }] }), /not answering/);
  assert.equal(f.adapter.readiness().ready, false);
  assert.ok(f.adapter.lifecycleRevision() > revision, "a health loop polling the revision sees the change");
});

test("events emitted before the first pull still reach a subscriber", async (t) => {
  const f = await fixture(t);
  const id = await f.session("world-builder");
  const listening = new AbortController(); t.after(() => listening.abort());
  const stream = f.adapter.streamEvents(listening.signal);
  f.ollama.script.push(reply("Quick."));
  await f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "hi" }] });
  const seen: string[] = [];
  for await (const event of stream) { seen.push(event.type); if (event.type === "session.ended") break; }
  assert.deepEqual(seen, ["message.delta", "message.delta", "message.completed", "session.ended"]);
});

test("Ollama dropping the connection mid-reply is the runtime lost, not a turn gone wrong", async (t) => {
  const f = await fixture(t);
  await f.adapter.init();
  const id = await f.session("world-builder");
  const revision = f.adapter.lifecycleRevision();
  f.ollama.script.push({ drop: true, chunks: [{ message: { role: "assistant", content: "Once" }, done: false }] });
  await assert.rejects(f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "hi" }] }), /stopped answering/);
  assert.equal(f.adapter.readiness().ready, false);
  assert.ok(f.adapter.lifecycleRevision() > revision);
});

test("a model whose inspection stalls is not offered, since its window cannot be confirmed; the others are read", async (t) => {
  const f = await fixture(t);
  f.ollama.models = [
    { name: "stuck:1b", stall: true },
    { name: "gemma4:12b", capabilities: ["completion", "tools", "vision"], context: 262144 },
  ];
  await f.adapter.init();
  assert.deepEqual(await f.adapter.listModels(), [
    { id: "gemma4:12b", provider: "ollama", displayName: "gemma4:12b", inputModalities: ["text", "image"], inputTokenLimit: 32768, tools: true, isDefault: true },
  ]);
});

test("the catalogue's own deadline lists what it has not read as unknown instead of failing", async (t) => {
  const f = await fixture(t, { catalogueDeadlineMs: 300 });
  f.ollama.models = [
    ...Array.from({ length: 9 }, (_, i) => ({ name: `stuck-${i}:1b`, stall: true })),
    { name: "gemma4:12b", capabilities: ["completion", "tools"], context: 262144 },
  ];
  const started = Date.now();
  assert.deepEqual(await f.adapter.listModels(), [], "nothing unread is offered, and the listing still answers");
  assert.ok(Date.now() - started < 2_000, "at the catalogue's own deadline, not after every stalled inspection");
});

test("a research preparation is not granted web tools this harness cannot provide", async (t) => {
  const f = await fixture(t);
  for (const config of [{ researchWeb: true }, {}]) {
    const id = await f.session("world-builder", config);
    f.ollama.script.push(reply("ok"));
    await f.adapter.sendMessage({ sessionId: id, parts: [{ type: "text", text: "hi" }] });
  }
  const [asked, plain] = f.ollama.chats as Array<{ tools?: unknown; messages: Array<{ content: string }> }>;
  assert.deepEqual(asked!.tools, plain!.tools);
  assert.equal(asked!.messages[0]!.content, plain!.messages[0]!.content, "the prompt promises nothing the plain session lacks");
});

const text = (value: string) => ({ parts: [{ type: "text" as const, text: value }] });

test("each request begins with the previous one's bytes, so Ollama's prompt cache stays warm", async (t) => {
  const f = await fixture(t);
  const id = await f.session("sheet-editor");
  f.ollama.script.push(callTool("list", {}), reply("Nothing yet."), reply("Still nothing."));
  await f.adapter.sendMessage({ sessionId: id, ...text("Look around.") });
  await f.adapter.sendMessage({ sessionId: id, ...text("And now?") });
  const sent = f.ollama.chats.map((chat) => JSON.stringify(chat.messages));
  assert.equal(sent.length, 3);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i]!.startsWith(sent[i - 1]!.slice(0, -1)), `request ${i} extends request ${i - 1}`);
  const tools = new Set(f.ollama.chats.map((chat) => JSON.stringify(chat.tools)));
  assert.equal(tools.size, 1, "the tool list is byte-identical on every call");
});

test("file tools are described compactly, keeping the rule a model must know", async (t) => {
  const f = await fixture(t);
  const id = await f.session("sheet-editor");
  f.ollama.script.push(reply("ok"));
  await f.adapter.sendMessage({ sessionId: id, ...text("hi") });
  const tools = f.ollama.chats[0]!.tools as Array<{ function: { name: string; description: string } }>;
  assert.ok(tools.every((tool) => tool.function.description.length <= 90), "short enough to be cheap on a cold turn");
  assert.match(tools.find((tool) => tool.function.name === "write")!.function.description, /Only proposal files/);
});

test("a long session is trimmed to its window: old tool results first, the instructions never", async (t) => {
  const f = await fixture(t, { maxContextTokens: 8192 });
  await writeFile(join(f.root, "long.md"), "the long file ".repeat(640));
  const id = await f.session("sheet-editor");
  f.ollama.script.push(callTool("read", { path: "long.md" }), reply("Read it."), reply("Noted."));
  await f.adapter.sendMessage({ sessionId: id, ...text("Read long.md.") });
  await f.adapter.sendMessage({ sessionId: id, ...text("a long question ".repeat(300)) });
  const last = f.ollama.chats.at(-1)!.messages as Array<{ role: string; content: string }>;
  const first = f.ollama.chats[0]!.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(last[0], first[0], "the system prompt is untouched");
  assert.ok(last.some((m) => m.content === TRIMMED_TOOL_RESULT));
  assert.ok(!JSON.stringify(last).includes("the long file the long file"), "the old file read is gone");
  assert.equal(last.at(-1)!.content, "a long question ".repeat(300));
});

test("a message that cannot fit the window ends the turn with that reason, and nothing is sent", async (t) => {
  const f = await fixture(t, { maxContextTokens: 8192 });
  const id = await f.session("sheet-editor");
  await assert.rejects(f.adapter.sendMessage({ sessionId: id, ...text("Q".repeat(30_000)) }), /do not fit the model's context window/);
  assert.equal(f.ollama.chats.length, 0);
  const ending = await f.ended(id);
  assert.equal(ending.type === "session.ended" && ending.reason, "budget-exceeded");
});

test("a tool call written as the reply is run as a call", async (t) => {
  const f = await fixture(t);
  const id = await f.session("sheet-editor");
  f.ollama.script.push(say('{"name":"write","arguments":{"path":"town.md","content":"Saltlight"}}'), reply("Written."));
  await f.adapter.sendMessage({ sessionId: id, ...text("Write it.") });
  assert.equal(await readFile(join(f.root, "town.md"), "utf8"), "Saltlight");
  assert.ok(f.events.some((e) => e.type === "tool.activity" && e.sessionId === id && e.tool === "arke.write"));
  const history = f.ollama.chats[1]!.messages as Array<{ role: string; content: string; tool_calls?: unknown }>;
  assert.deepEqual(history.at(-2), { role: "assistant", content: "", tool_calls: [{ function: { name: "write", arguments: { path: "town.md", content: "Saltlight" } } }] });
  assert.equal((f.events.findLast((e) => e.type === "message.completed" && e.sessionId === id) as { text: string }).text, "Written.");
});

test("an unreadable call is sent back once with the reason; a second ends the turn, and nothing is written", async (t) => {
  const f = await fixture(t);
  const id = await f.session("sheet-editor");
  f.ollama.script.push(say("<tool_call>{name: write, path: town.md}</tool_call>"), reply("Done in words instead."));
  await f.adapter.sendMessage({ sessionId: id, ...text("Write it.") });
  const asked = f.ollama.chats[1]!.messages as Array<{ role: string; content: string }>;
  assert.match(asked.at(-1)!.content, /could not be read: the text inside <tool_call> is not valid JSON/);
  f.ollama.script.push(say("<tool_call>{bad}</tool_call>"), say("<tool_call>{still bad}</tool_call>"));
  await assert.rejects(f.adapter.sendMessage({ sessionId: id, ...text("Try again.") }), /could not be read/);
  await assert.rejects(stat(join(f.root, "town.md")));
});

test("a structured reply is a reply, even to a role that has tools", async (t) => {
  const f = await fixture(t);
  const id = await f.session("world-builder");
  f.ollama.script.push(say('{"reply":"Saltlight it is.","operations":[]}'));
  await f.adapter.sendMessage({ sessionId: id, ...text("Name it.") });
  assert.equal((f.events.findLast((e) => e.type === "message.completed" && e.sessionId === id) as { text: string }).text, '{"reply":"Saltlight it is.","operations":[]}');
});

test("releasing residency unloads what was loaded, except a model a turn is using", async (t) => {
  const f = await fixture(t);
  const id = await f.session("world-builder");
  f.ollama.script.push(reply("ok"));
  await f.adapter.sendMessage({ sessionId: id, ...text("hi") });
  await f.adapter.releaseResidency();
  assert.deepEqual(f.ollama.generates, [{ model: "gemma4:12b", keep_alive: 0 }]);
  await f.adapter.releaseResidency();
  assert.equal(f.ollama.generates.length, 1, "nothing loaded since, so nothing to release");
  f.ollama.script.push(reply("again"), { hang: true, chunks: [{ message: { role: "assistant", content: "Once" }, done: false }] });
  await f.adapter.sendMessage({ sessionId: id, ...text("again") });
  const busy = f.adapter.sendMessage({ sessionId: id, ...text("long") }).catch(() => {});
  while (f.ollama.chats.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.adapter.releaseResidency();
  assert.equal(f.ollama.generates.length, 1, "the model generating right now stays loaded");
  await f.adapter.interrupt(id); await busy;
});

test("a prompt-only role falls back to a model seen to answer when none calls tools", async (t) => {
  const f = await fixture(t);
  f.ollama.models = [{ name: "chatty:7b", capabilities: ["completion"], context: 262144 }];
  const id = await f.session("conversation-namer");
  f.ollama.script.push(reply('{"title":"Saltlight"}'));
  await f.adapter.sendMessage({ sessionId: id, ...text("Name it.") });
  assert.equal(f.ollama.chats[0]!.model, "chatty:7b");
  await assert.rejects(f.session("sheet-editor"), /no model with a 256k context window that calls tools/);
});

test("a session still being created when the adapter is disposed is never published", async (t) => {
  const f = await fixture(t, { catalogueDeadlineMs: 200 });
  f.ollama.models = [{ name: "stuck:1b", stall: true }, { name: "gemma4:12b", capabilities: ["completion", "tools"], context: 262144 }];
  const creating = f.session("canon-qa");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.adapter.dispose();
  await assert.rejects(creating, /disposed/);
  assert.ok(!f.events.some((e) => e.type === "session.created"));
});

test("a model loaded by a turn that was then stopped is still released", async (t) => {
  const f = await fixture(t);
  const id = await f.session("world-builder");
  f.ollama.script.push({ hang: true });
  const sent = f.adapter.sendMessage({ sessionId: id, ...text("Tell me.") }).catch(() => {});
  while (f.ollama.chats.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.adapter.interrupt(id); await sent;
  await f.adapter.releaseResidency();
  assert.deepEqual(f.ollama.generates, [{ model: "gemma4:12b", keep_alive: 0 }]);
});

test("a model that states its 256k window but no capability list is offered, as unknown, and never the default", async (t) => {
  const f = await fixture(t);
  f.ollama.models = [
    { name: "plain:12b", context: 262144 },
    { name: "gemma4:12b", capabilities: ["completion", "tools"], context: 262144 },
  ];
  assert.deepEqual(await f.adapter.listModels(), [
    { id: "plain:12b", provider: "ollama", displayName: "plain:12b", inputModalities: ["text"], inputTokenLimit: 32768 },
    { id: "gemma4:12b", provider: "ollama", displayName: "gemma4:12b", inputModalities: ["text"], inputTokenLimit: 32768, tools: true, isDefault: true },
  ]);
});

test("a turn that starts while a release is on the wire waits for it, so its model is not unloaded under it", async (t) => {
  const f = await fixture(t);
  const id = await f.session("world-builder");
  f.ollama.script.push(reply("first"), reply("second"));
  await f.adapter.sendMessage({ sessionId: id, ...text("one") });
  f.ollama.generateDelayMs = 150;
  const releasing = f.adapter.releaseResidency();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await f.adapter.sendMessage({ sessionId: id, ...text("two") });
  await releasing;
  assert.deepEqual(f.ollama.log, ["chat", "unload:start", "unload:end", "chat"]);
});

test("a prompt-only role does not fall back to a model whose capabilities Ollama did not list", async (t) => {
  const f = await fixture(t);
  f.ollama.models = [{ name: "plain:12b", context: 262144 }, { name: "chatty:7b", capabilities: ["completion"], context: 262144 }];
  const id = await f.session("conversation-namer");
  f.ollama.script.push(reply('{"title":"Saltlight"}'));
  await f.adapter.sendMessage({ sessionId: id, ...text("Name it.") });
  assert.equal(f.ollama.chats[0]!.model, "chatty:7b", "the first model seen to complete, not the first row");
  f.ollama.models = [{ name: "plain:12b", context: 262144 }];
  await assert.rejects(f.session("conversation-namer"), /no 256k-context model known to answer/, "offered for choosing, not chosen");
});

test("when Ollama counts more prompt tokens than the estimate, the session trusts the estimate less from then on", async (t) => {
  const f = await fixture(t, { maxContextTokens: 8192 });
  const id = await f.session("canon-qa");
  // Ollama reports a prompt far larger than anything the estimate would give for this one.
  f.ollama.script.push(reply("ok", { prompt: 5_000, output: 5 }), reply("again"));
  await f.adapter.sendMessage({ sessionId: id, ...text("hi") });
  await writeFile(join(f.root, "notes.md"), "the long file ".repeat(300));
  // Now a turn that fits on the raw estimate but not once scaled by what Ollama reported.
  await assert.rejects(f.adapter.sendMessage({ sessionId: id, ...text("a long question ".repeat(200)) }), /do not fit the model's context window/);
});
