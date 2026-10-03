// The grouped-read probe (design turn 185): asks the running, installed Arke to read the same few
// consecutive blocks of a chapter as one request three ways, in the book's narrator, and prints
// what came back — (A) every turn its whole style, as solo reads; (B) the book and chapter notes
// once, each later turn only its own direction; (C) B with a run under one direction merged into
// one turn. The app holds the key and sends the requests; this script only presses the button
// over the DevTools protocol, so no credential ever passes through it. Three real, priced requests.
//
//   1. Quit Arke, then start it with DevTools on a local port:
//        "%LOCALAPPDATA%\Programs\Arke Studio\Arke Studio.exe" --remote-debugging-port=9333 --remote-allow-origins=*
//   2. Open the world (Na Love or Juju) whose book narrator is the designed voice to test.
//   3. node scripts/probe-grouped-read.mjs --production <production-slug> --chapter <chapter-file> [--from <block>] [--count 4] [--port 9333]
//
// It holds when each variant says succeeded and HTTP 200, its audio runs about as long as the
// blocks, its transcript has every block's words in order, and — listened to — the line keeps its
// speaker's delivery while the narration around it runs on as one reading. A transcript cannot
// hear a delivery; the listening is the proof, and the choice between A, B and C is the listener's.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const port = Number(option("port") ?? 9333);
const productionId = option("production");
const chapterFile = option("chapter");
const from = option("from");
const count = option("count") === undefined ? undefined : Number(option("count"));
if (productionId === undefined || chapterFile === undefined) {
  console.error("usage: node scripts/probe-grouped-read.mjs --production <slug> --chapter <chapter-file> [--from <block>] [--count 4] [--port 9333]");
  process.exit(2);
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json()).catch(() => null);
if (!Array.isArray(targets)) {
  console.error(`No DevTools endpoint on port ${port}. Start Arke with --remote-debugging-port=${port} --remote-allow-origins=*`);
  process.exit(1);
}
const page = targets.find((target) => target.type === "page" && typeof target.url === "string" && target.url.startsWith("file:"));
if (page === undefined) {
  console.error("Arke's window was not found among the DevTools targets.");
  process.exit(1);
}

const frame = { kind: "probe-grouped-read", productionId, chapterFile, ...(from !== undefined ? { from } : {}), ...(count !== undefined ? { count } : {}) };
// Runs in the app's page: the preload bridge sends the frame on the app's own authenticated
// socket and hands back every frame, from which the probe's answer is picked by its request id.
const expression = `new Promise((resolve) => {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = Date.now(), head = "";
  for (let i = 0; i < 10; i++) { head = alphabet[time % 32] + head; time = Math.floor(time / 32); }
  let tail = "";
  for (let i = 0; i < 16; i++) tail += alphabet[Math.floor(Math.random() * 32)];
  const requestId = head + tail;
  const timer = setTimeout(() => resolve({ outcome: "timeout", reason: "no answer in 10 minutes" }), 600000);
  window.arke.subscribe((data) => {
    try {
      const frame = JSON.parse(data);
      const event = frame && frame.kind === "event" ? frame.event : null;
      if (event && event.type === "probe.grouped-read" && event.requestId === requestId) { clearTimeout(timer); resolve(event); }
    } catch {}
  }, () => {});
  window.arke.send(JSON.stringify({ ...${JSON.stringify(frame)}, requestId }));
})`;

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("could not reach Arke's window")), { once: true });
});
const answer = await new Promise((resolve) => {
  socket.addEventListener("message", (message) => {
    const reply = JSON.parse(String(message.data));
    if (reply.id === 1) resolve(reply);
  });
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
});
socket.close();

const result = answer.result?.result?.value;
if (result === undefined) {
  console.error("The probe could not run in Arke's window:", JSON.stringify(answer.result?.exceptionDetails?.exception?.description ?? answer.error ?? answer));
  process.exit(1);
}
const line = (label, value) => console.log(`${String(label).padEnd(12)} ${value}`);
line("outcome", result.outcome);
if (result.reason) line("reason", result.reason);
if (result.voice) line("voice", `${result.voice.label ?? result.voice.voiceId} · ${result.voice.provider}/${result.voice.model}`);
for (const block of result.blocks ?? []) line(block.key, `${block.who} · ${block.text}`);
const worldDir = result.worldFolder ? join(homedir(), "ArkeStudio", "worlds", result.worldFolder) : null;
for (const variant of result.variants ?? []) {
  console.log("");
  line(`${variant.id} · ${variant.packing}`, variant.outcome);
  if (variant.reason) line("reason", variant.reason);
  if (variant.httpStatus !== undefined) line("HTTP", variant.httpStatus);
  if (variant.seconds !== undefined) line("audio", `${variant.seconds.toFixed(2)} s`);
  if (variant.costMicroUsd !== undefined && variant.costMicroUsd !== null) line("cost", `$${(variant.costMicroUsd / 1_000_000).toFixed(4)}`);
  for (const [index, turn] of variant.turns.entries()) line(`turn ${index + 1}`, `${JSON.stringify(turn.text)}  [style: ${turn.instructions ?? "none"}]`);
  if (variant.outcome === "succeeded") line("heard", variant.transcript ?? `(no transcript · ${variant.transcriptUnavailable ?? "unknown"})`);
  if (variant.file) {
    const local = worldDir === null ? null : join(worldDir, ...variant.file.split("/"));
    line("file", local !== null && existsSync(local) ? local : `${variant.file} (in the world's folder)`);
  }
}
process.exit(result.outcome === "succeeded" ? 0 : 1);
