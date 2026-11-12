// Local protocol stand-in: no models, transcript storage, external requests or provider keys.
import http from "node:http";
const mode = process.env.MODE ?? "healthy";
if (process.env.IGNORE_STOP === "1") process.on("SIGTERM", () => {});
const wav = Buffer.alloc(46);
wav.write("RIFF"); wav.writeUInt32LE(38, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(2, 40);
http.createServer(async (request, response) => {
  if (mode === "never-healthy") { response.writeHead(503); response.end("fixture unavailable"); return; }
  if (request.url === "/health") {
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ok: true, version: "fixture", protocolVersion: Number(process.env.PROTOCOL_VERSION ?? 1),
      architecture: process.arch, engines: ["kokoro", "whisper"], engineStatus: { kokoro: { ready: true }, whisper: { ready: true } } })); return;
  }
  for await (const _ of request) { /* Drain without retaining text or audio. */ }
  if (request.url === "/tts") { response.setHeader("Content-Type", "audio/wav"); response.end(wav); return; }
  if (request.url === "/stt") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ text: "synthetic fixture" })); return; }
  if (request.url === "/voices") { response.setHeader("Content-Type", "application/json"); response.end("[]"); return; }
  response.writeHead(404); response.end();
}).listen(Number(process.env.PORT), "127.0.0.1");
