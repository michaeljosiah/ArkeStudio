// Synthetic provider for process/socket qualification. No models, user profile or GPU.
import { createServer } from "node:http";
import { appendFileSync, existsSync } from "node:fs";

let session;

const server = createServer(async (request, response) => {
  if (request.url === "/health" || request.url === "/api/version") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: process.env.SERVICE_VERSION ?? "fixture" })); return;
  }
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1024 ** 2) { request.destroy(); return; } chunks.push(chunk); }
  const body = Buffer.concat(chunks).toString("utf8");
  if (process.env.ORIGIN_MARKER) appendFileSync(process.env.ORIGIN_MARKER, JSON.stringify({ path: request.url, body, headers: request.headers, clientPort: request.socket.remotePort }) + "\n");
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (path === "/api/session" && request.method === "POST") {
    session = { ...JSON.parse(body), id: "writer-session" }; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: session })); return;
  }
  if (path.startsWith("/api/session/")) {
    if (request.method === "DELETE") { session = undefined; response.writeHead(204); response.end(); return; }
    if (!session) { response.writeHead(404); response.end("PRIVATE_NATIVE_ERROR_MUST_NOT_ESCAPE"); return; }
    if (path.endsWith("/agent")) { session.agent = JSON.parse(body).agent; response.writeHead(204); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    if (path.endsWith("/generate") && process.env.WRITER_RELEASE) {
      const deadline = Date.now() + 20_000;
      const timer = setInterval(() => { if (existsSync(process.env.WRITER_RELEASE) || Date.now() >= deadline) { clearInterval(timer); response.end(JSON.stringify({ data: { text: "private writer result" } })); } }, 10);
      response.once("close", () => clearInterval(timer)); return;
    }
    response.end(JSON.stringify({ data: path.endsWith("/generate") ? { text: "private writer result" } : path.endsWith("/message") || path.endsWith("/permission") ? [] : session })); return;
  }
  const mode = body ? JSON.parse(body).mode : "ok";
  if (process.env.NATIVE_PROVIDER_MODEL) {
    const model = process.env.NATIVE_PROVIDER_MODEL;
    response.writeHead(200, { "content-type": path === "/v1/chat/completions" ? "text/event-stream" : "application/json" });
    if (path === "/api/tags") { response.end(JSON.stringify({ models: [{ name: model, model, size: 1, digest: model, modified_at: "2026-10-27T00:00:00Z", details: { format: "gguf", family: "gemma", parameter_size: "12B", quantization_level: "Q4_K_M" } }] })); return; }
    if (path === "/api/show") { response.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "general.architecture": "gemma", "gemma.context_length": 262144 } })); return; }
    if (path === "/v1/chat/completions") {
      const chunk = (delta, finish_reason) => ({ id: "synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] });
      response.end(`data: ${JSON.stringify(chunk({ content: process.env.NATIVE_PROVIDER_REPLY }, null))}\n\ndata: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`); return;
    }
    response.end("{}"); return;
  }
  if (mode === "redirect") { response.writeHead(302, { location: "http://127.0.0.1:1/forbidden" }); response.end(); return; }
  const type = request.url === "/v1/chat/completions" ? "text/event-stream" : "application/json";
  if (mode === "declared") { response.writeHead(200, { "content-type": type, "content-length": 1024 ** 2 + 1 }); response.end("x"); return; }
  if (mode === "stream") { response.writeHead(200, { "content-type": type }); response.end("x".repeat(1024 ** 2 + 1)); return; }
  if (mode === "wrong-type") { response.writeHead(200, { "content-type": "text/plain" }); response.end("private upstream error must not escape"); return; }
  if (mode === "failed") { response.writeHead(500, { "content-type": type }); response.end("private upstream error must not escape"); return; }
  response.writeHead(200, { "content-type": type, "set-cookie": "private-provider-cookie=fixture", "x-internal-trace": "private-provider-trace" });
  if (mode === "hold") { response.write("data: waiting\n\n"); return; }
  response.end(type === "text/event-stream" ? "data: fixture-complete\n\ndata: [DONE]\n\n" : JSON.stringify({ models: [] }));
});
server.listen(Number(process.env.PORT), "127.0.0.1");
