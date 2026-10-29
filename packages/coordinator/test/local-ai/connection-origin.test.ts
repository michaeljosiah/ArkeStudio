import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { it } from "node:test";
import { ChildSupervisor, isSupervisedProcessOrigin } from "../../src/supervisor.js";
import { windowsConnectionOrigin } from "../../src/local-ai/windows-connection-origin.js";
import { ManagedOllamaTransport } from "../../src/local-ai/managed-ollama-transport.js";
import { until } from "../wait.js";

const CHILD = join(import.meta.dirname, "../fixtures/child.mjs");
async function connect(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port }); socket.on("error", () => {});
  await once(socket, "connect"); return socket;
}

it("captures one direct child and permanently revokes its original identity on Stop/replacement", { timeout: 60_000 }, async () => {
  const supervisor = new ChildSupervisor({ id: "origin-child", command: process.execPath, args: [CHILD], readyTimeoutMs: 20_000 });
  assert.equal(supervisor.captureProcessOrigin(), null);
  try {
    await supervisor.start(); const first = supervisor.captureProcessOrigin(); assert(first);
    assert(Object.isFrozen(first)); assert(isSupervisedProcessOrigin(first)); assert(first.current());
    assert.equal(first, supervisor.captureProcessOrigin()); assert.equal(first.pid, supervisor.pid);
    assert(!isSupervisedProcessOrigin({ ...first }), "copied fields cannot mint the original child capability");
    supervisor.quiesce(); assert(!first.current()); assert.equal(supervisor.captureProcessOrigin(), null);
    await supervisor.stopAndConfirm(); await supervisor.start();
    const next = supervisor.captureProcessOrigin(); assert(next); assert(next.current());
    assert.notEqual(next.identity, first.identity); assert(!first.current());
  } finally { await supervisor.stopAndConfirm(); }
});

it("verifies the actual Windows connected tuple without sending any application bytes", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const supervisor = new ChildSupervisor({ id: "origin-native", command: process.execPath, args: [CHILD], readyTimeoutMs: 20_000 });
  let socket: Socket | undefined;
  try {
    await supervisor.start(); const origin = supervisor.captureProcessOrigin(); assert(origin);
    socket = await connect(origin.port);
    const connection = { clientPort: socket.localPort!, serverPort: socket.remotePort! };
    assert(await windowsConnectionOrigin(origin, connection, AbortSignal.timeout(30_000)));
    assert.equal(socket.bytesWritten, 0);
    assert.equal(await windowsConnectionOrigin({ ...origin }, connection, new AbortController().signal), false);
    assert.equal(await windowsConnectionOrigin(origin, { ...connection, serverPort: origin.port + 1 }, new AbortController().signal), false);
    const aborted = new AbortController(); aborted.abort();
    assert.equal(await windowsConnectionOrigin(origin, connection, aborted.signal), false);
    supervisor.quiesce(); assert(!origin.current());
    assert.equal(await windowsConnectionOrigin(origin, connection, new AbortController().signal), false);
  } finally { socket?.destroy(); await supervisor.stopAndConfirm(); }
});

it("does not revive an old capability when the same child recovers from unhealthy status", { timeout: 60_000 }, async () => {
  let healthy = true;
  const supervisor = new ChildSupervisor({ id: "origin-health", command: process.execPath, args: [CHILD], readyTimeoutMs: 20_000,
    healthIntervalMs: 50, healthFailureThreshold: 1000, validateHealth: () => healthy });
  try {
    await supervisor.start(); const first = supervisor.captureProcessOrigin(); assert(first);
    healthy = false; await until(() => supervisor.status === "unhealthy", "failed original health fence");
    assert(!first.current()); assert.equal(supervisor.captureProcessOrigin(), null);
    healthy = true; await until(() => supervisor.status === "healthy", "same child's qualified health recovery");
    assert(!first.current()); const next = supervisor.captureProcessOrigin(); assert(next); assert(next.current());
    assert.equal(next.pid, first.pid); assert.notEqual(next.identity, first.identity);
  } finally { await supervisor.stopAndConfirm(); }
});

it("refuses a healthy impostor that answers the managed child's selected port", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  let privateRequests = 0;
  const server = createServer((request, response) => { if (request.url === "/v1/chat/completions") privateRequests++; response.end("healthy"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const supervisor = new ChildSupervisor({ id: "origin-impostor", command: process.execPath, port: address.port,
    args: ["-e", "setInterval(() => {}, 1000)"], readyTimeoutMs: 20_000 });
  let socket: Socket | undefined;
  let transport: ManagedOllamaTransport | undefined;
  try {
    await supervisor.start(); assert.equal(supervisor.status, "healthy");
    const origin = supervisor.captureProcessOrigin(); assert(origin); assert(origin.current());
    socket = await connect(origin.port);
    assert.equal(await windowsConnectionOrigin(origin, { clientPort: socket.localPort!, serverPort: socket.remotePort! }, AbortSignal.timeout(30_000)), false);
    assert.equal(socket.bytesWritten, 0, "an answering version/health service is not sufficient authority");
    transport = new ManagedOllamaTransport({ origin, current: () => true });
    await assert.rejects(transport.fetch(`http://127.0.0.1:${origin.port}/v1/chat/completions`, { method: "POST", body: "private text must stay in the host" }));
    assert.equal(privateRequests, 0, "the HTTP client must refuse before sending any private request to the impostor");
  } finally {
    socket?.destroy(); await transport?.stop(); await supervisor.stopAndConfirm();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
