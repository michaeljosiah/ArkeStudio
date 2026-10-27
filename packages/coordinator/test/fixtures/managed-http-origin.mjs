// Synthetic provider for process/socket qualification. No models, user profile or GPU.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const server = createServer(async (request, response) => {
  if (request.url === "/health" || request.url === "/api/version") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: process.env.SERVICE_VERSION ?? "fixture" })); return;
  }
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1024 ** 2) { request.destroy(); return; } chunks.push(chunk); }
  const body = Buffer.concat(chunks).toString("utf8");
  if (process.env.ORIGIN_MARKER) appendFileSync(process.env.ORIGIN_MARKER, JSON.stringify({ path: request.url, body, headers: request.headers, clientPort: request.socket.remotePort }) + "\n");
  const mode = body ? JSON.parse(body).mode : "ok";
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
