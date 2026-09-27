import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { RemoteDevices } from "../src/remote-access/devices.js";
import { RemoteGateway, remotePage } from "../src/remote-access/gateway.js";

const origin = "https://studio.example.ts.net";
const temporary = () => mkdtemp(join(tmpdir(), "arke-remote-"));
async function paired(devices: RemoteDevices, name = "Phone") {
  const { code } = devices.createCode();
  const proof = devices.request(code, name)!;
  const id = devices.pending().find(row => row.name === name)!.id;
  await devices.approve(id);
  return { proof, id };
}
it("remembered devices persist only hashes, survive restart, and expire or revoke individually", async () => {
  const root = await temporary(); let now = Date.now();
  try {
    const path = join(root, "devices.json");
    const devices = new RemoteDevices(path, () => now);
    await devices.load();
    const phone = await paired(devices);
    const laptop = await paired(devices, "Laptop");
    assert.ok(!String(await readFile(path)).includes(phone.proof));
    const restored = new RemoteDevices(path, () => now); await restored.load();
    assert.equal(restored.authenticate(phone.proof), phone.id);
    assert.equal(restored.authenticate("wrong"), null);
    await restored.revoke(phone.id);
    assert.equal(restored.authenticate(phone.proof), null);
    assert.equal(restored.authenticate(laptop.proof), laptop.id);
    now += 91 * 86400_000;
    assert.equal(restored.authenticate(laptop.proof), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("pairing needs owner approval, codes work once, expire and have a guess limit", async () => {
  const root = await temporary(); let now = Date.now();
  try {
    const devices = new RemoteDevices(join(root, "devices.json"), () => now); await devices.load();
    const first = devices.createCode();
    const proof = devices.request(first.code, "Phone")!;
    assert.equal(devices.authenticate(proof), null);
    assert.equal(devices.poll(proof), "pending");
    assert.equal(devices.request(first.code, "Another"), null);
    devices.reject(devices.pending()[0]!.id);
    assert.equal(devices.poll(proof), "expired");
    const guessed = devices.createCode();
    for (let index = 0; index < 5; index++) assert.equal(devices.request("00000000", "Guess"), null);
    assert.equal(devices.request(guessed.code, "Phone"), null);
    const expired = devices.createCode(); now += 300_001;
    assert.equal(devices.request(expired.code, "Phone"), null);
    const pending = devices.request(devices.createCode().code, "Phone")!;
    const id = devices.pending()[0]!.id;
    now += 300_001;
    await assert.rejects(devices.approve(id), /expired/);
    assert.equal(devices.poll(pending), "expired");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("failed persistence cannot grant access and a damaged registry fails closed", async () => {
  const root = await temporary();
  try {
    const path = join(root, "devices.json");
    const devices = new RemoteDevices(path, Date.now, async () => { throw new Error("disk full"); });
    await devices.load();
    const proof = devices.request(devices.createCode().code, "Phone")!;
    await assert.rejects(devices.approve(devices.pending()[0]!.id), /disk full/);
    assert.equal(devices.authenticate(proof), null);
    await writeFile(path, "broken");
    await assert.rejects(new RemoteDevices(path).load());
  } finally { await rm(root, { recursive: true, force: true }); }
});

function get(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: options.method ?? "GET",
      headers: { Host: new URL(origin).host, ...options.headers } }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject); req.end(options.body);
  });
}
function connect(port: number, proof?: string, pageOrigin = origin) {
  return new WebSocket(`ws://127.0.0.1:${port}/`, { origin: pageOrigin,
    headers: { Host: new URL(origin).host, ...(proof ? { Cookie: "__Host-arke-device=" + proof } : {}) } });
}
async function closeServer(server: Server) { await new Promise<void>(resolve => server.close(() => resolve())); }
it("real gateway pairs a browser, protects media and closes only revoked device sockets", async () => {
  const root = await temporary();
  const token = "a".repeat(64);
  const received: unknown[] = [];
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + token);
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(206, { "Content-Type": "image/png", "Content-Range": "bytes 0-2/10" }).end("png");
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", socket => socket.on("message", raw => {
    const msg = JSON.parse(raw.toString()); received.push(msg);
    if (msg.kind === "hello") socket.send(JSON.stringify({ kind: "snapshot", seq: 1 }));
  }));
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const upstreamPort = (upstream.address() as import("node:net").AddressInfo).port;
  const devices = new RemoteDevices(join(root, "devices.json")); await devices.load();
  const clientDirectory = join(root, "client"); await mkdir(clientDirectory);
  const desktopPage = '<head><meta http-equiv="Content-Security-Policy" content="connect-src ws://127.0.0.1:*"></head><body>Studio</body>';
  await writeFile(join(clientDirectory, "index.html"), desktopPage);
  await writeFile(join(root, "private.txt"), "private");
  const gateway = new RemoteGateway({ origin, clientDirectory, devices, session: { port: upstreamPort, token } });
  const port = await gateway.start(0);
  const sockets: WebSocket[] = [];
  try {
    const page = await get(port, "/");
    assert.equal(page.status, 200); assert.ok(page.body.includes('name="arke-remote"'));
    assert.ok(!page.body.includes(token)); assert.ok(!page.body.includes("127.0.0.1"));
    assert.equal(await readFile(join(clientDirectory, "index.html"), "utf8"), desktopPage, "desktop CSP is unchanged");
    assert.equal((await get(port, "/../private.txt")).status, 404);
    assert.equal((await get(port, "/.dev/transport-8791.json")).status, 404);
    assert.equal((await get(port, "/remote/session")).status, 401);
    assert.equal((await get(port, "/media/world/a.png")).status, 401);
    assert.equal((await get(port, "/", { headers: { Host: "evil.example" } })).status, 403);
    const { code } = devices.createCode();
    const body = JSON.stringify({ code, name: "Phone" });
    const headers = { Origin: origin, "Content-Type": "application/json" };
    assert.equal((await get(port, "/remote/pair", { method: "POST", body, headers: { ...headers, Origin: "https://evil.example" } })).status, 403);
    assert.equal((await get(port, "/remote/pair", { method: "POST", body })).status, 403);
    const requested = await get(port, "/remote/pair", { method: "POST", body, headers });
    assert.equal(requested.status, 202);
    const pending = requested.headers["set-cookie"]![0]!;
    assert.match(pending, /Secure; HttpOnly; SameSite=Strict/);
    const pendingCookie = pending.split(";")[0]!;
    assert.equal((await get(port, "/remote/pair", { headers: { Cookie: pendingCookie } })).status, 202);
    const id = devices.pending()[0]!.id; await devices.approve(id);
    const approved = await get(port, "/remote/pair", { headers: { Cookie: pendingCookie } });
    assert.equal(approved.status, 204);
    const credentialCookie = approved.headers["set-cookie"]![0]!.split(";")[0]!;
    const proof = credentialCookie.split("=")[1]!;
    assert.equal((await get(port, "/remote/session", { headers: { Cookie: credentialCookie } })).status, 204);
    const media = await get(port, "/media/world/a.png?token=ignored", { headers: { Cookie: credentialCookie, Range: "bytes=0-2" } });
    assert.equal(media.status, 206); assert.equal(media.headers["content-range"], "bytes 0-2/10");
    assert.match(String(media.headers["content-security-policy"]), /sandbox/);
    const rejected = connect(port); sockets.push(rejected);
    await new Promise<void>(resolve => rejected.once("error", () => resolve()));
    const foreign = connect(port, proof, "https://evil.example"); sockets.push(foreign);
    await new Promise<void>(resolve => foreign.once("error", () => resolve()));
    const phone = connect(port, proof); sockets.push(phone);
    const snapshot = await once(phone, "message"); assert.match(snapshot[0].toString(), /snapshot/);
    const laptopDevice = await paired(devices, "Laptop");
    const laptop = connect(port, laptopDevice.proof); sockets.push(laptop); await once(laptop, "message");
    assert.deepEqual(received[0], { kind: "hello", token });
    const closed = once(phone, "close");
    await devices.revoke(id); gateway.recheckDevices();
    assert.equal((await closed)[0], 1008);
    assert.equal(laptop.readyState, WebSocket.OPEN);
    assert.equal((await get(port, "/media/world/a.png", { headers: { Cookie: credentialCookie } })).status, 401);
    assert.equal((await get(port, "/remote/pair", { headers: { Cookie: pendingCookie } })).status, 410);
  } finally {
    for (const socket of sockets) socket.terminate();
    await gateway.stop(); await devices.stop();
    for (const socket of wss.clients) socket.terminate(); wss.close(); await closeServer(upstream);
    await rm(root, { recursive: true, force: true });
  }
});
it("served page CSP names only the hosted origin; the source page is not weakened", () => {
  const html = '<head><meta http-equiv="Content-Security-Policy" content="connect-src ws://localhost:*"></head>';
  const served = remotePage(html, origin);
  assert.ok(served.includes("wss://studio.example.ts.net"));
  assert.ok(!served.includes("localhost"));
  assert.ok(html.includes("localhost"));
});
