import assert from "node:assert/strict";
import { it } from "node:test";
import { privateControlFiles, privateWireBody } from "../src/v2/private-control.js";

const request = { model: "ollama/qualified-model", system: "REVIEWED_SYSTEM", prompt: "REVIEWED_PRIVATE_QUESTION", outputTokenLimit: 4096 };
const chunk = (delta: unknown, finish_reason: string | null = null, usage?: unknown) => ({ model: "qualified-model", id: "RAW_PROVIDER_METADATA",
  choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
const stream = (...rows: unknown[]) => rows.map(row => `data: ${typeof row === "string" ? row : JSON.stringify(row)}\n\n`).join("");
const complete = () => stream(chunk({ role: "assistant", content: "PRIVATE_RESPONSE" }), chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 5 }), "[DONE]");

async function control() {
  const source = privateControlFiles(request, "generate")[1]!.contents;
  // Execute the exact fixed application source emitted to native; request text remains data.
  const module = new Function(source.replace(/^export default /, "return "))();
  const hooks = new Map<string, (event: Record<string, unknown>) => Promise<void>>();
  const options = { body: privateWireBody(request) };
  await module.setup({ options, session: { hook: async (name: string, callback: (event: Record<string, unknown>) => Promise<void>) => { hooks.set(name, callback); } } });
  await hooks.get("model.request")!({ kind: "generate", model: { providerID: "ollama", id: "qualified-model" }, baseURL: "http://127.0.0.1:11434/v1" });
  const event = { request: new Request("http://127.0.0.1:11434/v1/chat/completions", { method: "POST", body: "unreviewed", headers: { authorization: "Bearer synthetic", "x-session-id": "native" } }) };
  await hooks.get("http.request")!(event);
  assert.deepEqual(await event.request.clone().json(), privateWireBody(request));
  return { source, hooks, options, response: (body: ConstructorParameters<typeof Response>[0], status = 200, contentType = "text/event-stream") => ({ kind: "generate", request: event.request,
    response: new Response(body, { status, headers: { "content-type": contentType, "x-provider-private": "RAW_PROVIDER_METADATA" } }) }) };
}

it("isolates the transient control identity and only admits a complete canonical stream", async () => {
  const candidate = await control();
  assert.match(candidate.source, /private-control\.v1\.transient\.[a-f0-9]{64}/);
  assert(!candidate.source.includes(request.prompt)); assert(!candidate.source.includes(request.system));
  assert(!privateControlFiles(request)[1]!.contents.includes('hook("http.response"'));
  await assert.rejects(async () => candidate.hooks.get("model.request")!({ kind: "primary", model: { providerID: "ollama", id: "qualified-model" }, baseURL: "http://127.0.0.1:11434/v1" }), /Private model request mismatch/);
  const event = candidate.response(complete()); const original = event.response;
  await candidate.hooks.get("http.response")!(event);
  assert(original.bodyUsed); assert.notEqual(event.response, original);
  const output = await event.response.text(); assert(output.includes("PRIVATE_RESPONSE")); assert(output.includes('"finish_reason":"stop"'));
  assert(output.includes('"total_tokens":15')); assert(!output.includes("RAW_PROVIDER_METADATA")); assert.deepEqual([...event.response.headers.keys()], ["content-type"]);
  await assert.rejects(candidate.hooks.get("http.response")!(candidate.response(complete())), { message: "Private response refused" });
  const retry: Record<string, unknown> = {}; await candidate.hooks.get("retry")!(retry); assert.deepEqual(retry.decision, { retry: false });
  await assert.rejects(candidate.hooks.get("http.request")!({ request: new Request("http://127.0.0.1:11434/v1/chat/completions", { method: "POST", body: "replay" }) }), /Private request refused/);
  assert.throws(() => privateControlFiles(undefined, "generate"), /reviewed manifest/);
});

it("keeps the captured model/token policy despite options mutation and leaves missing usage unknown", async () => {
  const candidate = await control(); candidate.options.body.model = "changed"; candidate.options.body.max_completion_tokens = 0;
  const event = candidate.response(stream(chunk({ content: "PRIVATE_RESPONSE" }), chunk({}, "stop"), "[DONE]"));
  await candidate.hooks.get("http.response")!(event); const output = await event.response.text();
  assert(output.includes('"model":"qualified-model"')); assert(!output.includes('"usage"'));
});

it("strips the pinned Ollama reasoning delta and preserves complete response and total usage", async () => {
  const candidate = await control();
  const event = candidate.response(stream(
    chunk({ role: "assistant", reasoning: "PRIVATE_THOUGHTS_MUST_NOT_REACH_SDK" }),
    chunk({ reasoning: "MORE_PRIVATE_THOUGHTS", content: "" }),
    chunk({ content: "PRIVATE_RESPONSE" }), chunk({}, "stop"),
    { model: "qualified-model", choices: [], usage: { prompt_tokens: 635, completion_tokens: 217 } }, "[DONE]"));
  await candidate.hooks.get("http.response")!(event);
  const output = await event.response.text(); assert(output.includes("PRIVATE_RESPONSE")); assert(output.includes('"total_tokens":852'));
  assert(!output.includes("THOUGHTS")); assert(!output.includes("reasoning")); assert(!output.includes("RAW_PROVIDER_METADATA"));
});

it("bounds fragmented reads without waiting for an uncooperative cancellation callback", async () => {
  let cancelled = false;
  const candidate = await control(), body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array([32])); },
    cancel() { cancelled = true; return new Promise(() => {}); } });
  await assert.rejects(candidate.hooks.get("http.response")!(candidate.response(body)), { message: "Private response refused" }); assert(cancelled);
});

const invalid = [
  ["truncation", stream(chunk({ content: "PRIVATE_RESPONSE" }), chunk({}, "length"), "[DONE]")],
  ["tools", stream(chunk({ tool_calls: [{ function: { name: "unreviewed" } }] }), chunk({}, "tool_calls"), "[DONE]")],
  ["nontext reasoning", stream(chunk({ reasoning: { instruction: "PRIVATE_UNTRUSTED_REASONING" } }), chunk({}, "stop"), "[DONE]")],
  ["unknown reasoning field", stream(chunk({ reasoning_content: "PRIVATE_UNTRUSTED_REASONING" }), chunk({}, "stop"), "[DONE]")],
  ["reasoning after finish", stream(chunk({}, "stop"), chunk({ reasoning: "PRIVATE_UNTRUSTED_REASONING" }), "[DONE]")],
  ["refusal", stream(chunk({ refusal: "PRIVATE_RESPONSE" }), chunk({}, "stop"), "[DONE]")],
  ["missing finish", stream(chunk({ content: "PRIVATE_RESPONSE" }), "[DONE]")],
  ["missing done", stream(chunk({ content: "PRIVATE_RESPONSE" }), chunk({}, "stop"))],
  ["trailing content", complete() + stream(chunk({ content: "PRIVATE_RESPONSE" }))],
  ["second finish", stream(chunk({}, "stop"), chunk({}, "stop"), "[DONE]")],
  ["wrong model", stream({ ...chunk({ content: "PRIVATE_RESPONSE" }), model: "changed" }, chunk({}, "stop"), "[DONE]")],
  ["multiple choices", stream({ ...chunk({ content: "PRIVATE_RESPONSE" }), choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] }, chunk({}, "stop"), "[DONE]")],
  ["bad tokens", stream(chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 4097 }), "[DONE]")],
  ["nonfinite tokens", stream(chunk({}, "stop", { prompt_tokens: -1, completion_tokens: 5 }), "[DONE]")],
  ["duplicate usage", stream(chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 5 }), { model: "qualified-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }, "[DONE]")],
  ["body bound", "x".repeat(1024 * 1024 + 1)],
  ["decoded text bound", stream(chunk({ content: "é".repeat(192 * 1024 / 2 + 1) }), chunk({}, "stop"), "[DONE]")],
  ["frame bound", ": heartbeat\n\n".repeat(16385) + complete()],
  ["invalid JSON", "data: PRIVATE_PROVIDER_ERROR\n\n"],
] as const;
for (const [name, body] of invalid) it(`refuses transient ${name} without leaving a reusable raw response`, async () => {
  const candidate = await control(), event = candidate.response(body), original = event.response;
  await assert.rejects(candidate.hooks.get("http.response")!(event), { message: "Private response refused" });
  assert(original.bodyUsed); assert.equal(event.response, original);
});

it("redacts failed HTTP, invalid UTF-8 and reader failures, and supports standard split/CRLF frames", async () => {
  for (const [status, contentType] of [[503, "application/json"], [200, "application/json"]] as const) {
    const candidate = await control(), event = candidate.response("PRIVATE_PROVIDER_ERROR", status, contentType);
    await assert.rejects(candidate.hooks.get("http.response")!(event), { message: "Private response refused" }); assert(event.response.bodyUsed);
  }
  for (const body of [new Uint8Array([0xff]), new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("PRIVATE_PROVIDER_ERROR")); } })]) {
    const candidate = await control(); await assert.rejects(candidate.hooks.get("http.response")!(candidate.response(body)), { message: "Private response refused" });
  }
  const candidate = await control(), bytes = new TextEncoder().encode(complete().replaceAll("\n", "\r\n"));
  const event = candidate.response(new ReadableStream<Uint8Array>({ start(controller) { for (let n = 0; n < bytes.length; n += 7) controller.enqueue(bytes.slice(n, n + 7)); controller.close(); } }));
  await candidate.hooks.get("http.response")!(event); assert((await event.response.text()).includes("PRIVATE_RESPONSE"));
});
