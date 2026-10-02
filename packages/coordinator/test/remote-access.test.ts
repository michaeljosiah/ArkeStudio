import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { hostOnlyCommandFixtures } from "./remote-host-commands.js";
import { ClientMessageSchema, REMOTE_HOST_ONLY_COMMANDS, RemoteCommandRefusalSchema, RemoteDeviceInfoSchema, type RemotePairingDuration } from "@arke-studio/contracts";
import { RemoteDevices } from "../src/remote-access/devices.js";
import { RemoteGateway, remotePage } from "../src/remote-access/gateway.js";
import { sealBrowserProof } from "../src/remote-access/browser-proof.js";

const origin = "https://studio.example.ts.net";
const browserKey = "b".repeat(64);
const sealed = (proof: string) => proof.startsWith("v1.") ? proof : sealBrowserProof(proof, browserKey, origin);
const temporary = () => mkdtemp(join(tmpdir(), "arke-remote-"));
it("independently enumerated valid host payloads cover every refused command name", () => {
  assert.deepEqual([...new Set(hostOnlyCommandFixtures("C:/fixture.png").map(c => c.kind))].sort(), [...REMOTE_HOST_ONLY_COMMANDS].sort());
});
async function paired(devices: RemoteDevices, name = "Phone", duration: RemotePairingDuration = 90) {
  const { code } = devices.createCode();
  const proof = devices.request(code, name)!;
  const id = devices.pending().find(row => row.name === name)!.id;
  await devices.approve(id, duration);
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
    assert.equal(restored.poll(phone.proof), "approved", "approval can promote its pending cookie after a host restart");
    now += 300_001;
    assert.equal(devices.poll(phone.proof), "approved", "durable approval outlives the transient request");
    assert.equal(restored.authenticate("wrong"), null);
    await restored.revoke(phone.id);
    assert.equal(restored.authenticate(phone.proof), null);
    assert.equal(restored.poll(phone.proof), "expired");
    assert.equal(restored.authenticate(laptop.proof), laptop.id);
    now += 91 * 86400_000;
    assert.equal(restored.authenticate(laptop.proof), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("each approval retains its selected lifetime; Never survives restart and remains revocable", async () => {
  const root = await temporary(); let now = Date.now();
  const approvedAt = now;
  try {
    const path = join(root, "devices.json");
    const devices = new RemoteDevices(path, () => now); await devices.load();
    const approvals = [];
    for (const duration of [30, 90, 120, "never"] as const) {
      const device = await paired(devices, String(duration), duration);
      approvals.push({ ...device, duration });
      assert.equal(devices.list().find(row => row.id === device.id)!.expiresAt,
        duration === "never" ? null : approvedAt + duration * 86400_000);
    }
    const restored = new RemoteDevices(path, () => now); await restored.load();
    for (const { proof, id, duration } of approvals) {
      if (duration === "never") continue;
      now = approvedAt + duration * 86400_000 - 1;
      assert.equal(restored.authenticate(proof), id);
      now++;
      assert.equal(restored.authenticate(proof), null);
      assert.equal(restored.cookieMaxAge(proof), null);
    }
    now = approvedAt + 1000 * 86400_000;
    const forever = approvals.at(-1)!;
    assert.equal(restored.authenticate(forever.proof), forever.id);
    assert.deepEqual(restored.list().map(row => row.id), [forever.id]);
    await paired(restored, "Later", 30);
    assert.equal(restored.authenticate(forever.proof), forever.id, "new approvals retain existing Never devices");
    await restored.revoke(forever.id);
    const revoked = new RemoteDevices(path, () => now); await revoked.load();
    assert.equal(revoked.authenticate(forever.proof), null);
    const registry = JSON.parse(await readFile(path, "utf8"));
    delete registry.devices[0].expiresAt;
    await writeFile(path, JSON.stringify(registry));
    await assert.rejects(new RemoteDevices(path).load(), "missing expiry is not Never");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("bulk revocation is durable and a failed write cannot acknowledge an origin migration", async () => {
  const root = await temporary();
  try {
    const path = join(root, "devices.json");
    const devices = new RemoteDevices(path); await devices.load();
    const { proof } = await paired(devices);
    const failed = new RemoteDevices(path, Date.now, async () => { throw new Error("disk full"); });
    await failed.load(); await assert.rejects(failed.revokeAll(), /disk full/);
    assert.ok(failed.authenticate(proof));
    await devices.revokeAll();
    const restored = new RemoteDevices(path); await restored.load();
    assert.equal(restored.authenticate(proof), null);
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
      headers: { Host: new URL(origin).host, "x-arke-browser-key": browserKey, ...options.headers } }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject); req.end(options.body);
  });
}
function connect(port: number, proof?: string, pageOrigin = origin) {
  return new WebSocket(`ws://127.0.0.1:${port}/`, ["arke-remote", "arke-browser." + browserKey], { origin: pageOrigin,
    headers: { Host: new URL(origin).host, ...(proof ? { Cookie: "__Host-arke-device=" + sealed(proof) } : {}) } });
}
async function closeServer(server: Server) { await new Promise<void>(resolve => server.close(() => resolve())); }
it("gateway cookies respect fixed approval deadlines and renew Never without restoring revoked access", async () => {
  const root = await temporary(); let now = Date.now();
  const devices = new RemoteDevices(join(root, "devices.json"), () => now);
  await writeFile(join(root, "index.html"), "<head></head>");
  const gateway = new RemoteGateway({ origin, clientDirectory: root, devices, session: { port: 9999, token: "a".repeat(64) } });
  const port = await gateway.start(0);
  try {
    for (const duration of [30, 90, 120, "never"] as const) {
      const { proof, id } = await paired(devices, String(duration), duration);
      const approved = await get(port, "/remote/pair", { headers: { Cookie: "__Host-arke-pair=" + sealed(proof) } });
      assert.equal(approved.status, 204);
      const lifetime = (duration === "never" ? 400 : duration) * 86400;
      assert.match(approved.headers["set-cookie"]![0]!, new RegExp(`Max-Age=${lifetime}$`));
      now += 86400_000;
      const headers = { Cookie: "__Host-arke-device=" + sealed(proof) };
      const resumed = await get(port, "/remote/session", { headers });
      assert.equal(resumed.status, 204);
      assert.match(resumed.headers["set-cookie"]![0]!, /Secure; HttpOnly; SameSite=Strict/);
      assert.match(resumed.headers["set-cookie"]![0]!, new RegExp(`Max-Age=${duration === "never" ? lifetime : lifetime - 86400}$`));
      if (duration !== "never") {
        now += (duration - 1) * 86400_000;
        const expired = await get(port, "/remote/session", { headers });
        assert.equal(expired.status, 401); assert.equal(expired.headers["set-cookie"], undefined);
      } else {
        await devices.revoke(id);
        const revoked = await get(port, "/remote/session", { headers });
        assert.equal(revoked.status, 401); assert.equal(revoked.headers["set-cookie"], undefined);
      }
    }
  } finally { await gateway.stop(); await devices.stop(); await rm(root, { recursive: true, force: true }); }
});
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
    else socket.send(raw.toString());
  }));
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const upstreamPort = (upstream.address() as import("node:net").AddressInfo).port;
  const devices = new RemoteDevices(join(root, "devices.json")); await devices.load();
  const clientDirectory = join(root, "client"); await mkdir(clientDirectory);
  const desktopPage = '<head><meta http-equiv="Content-Security-Policy" content="connect-src ws://127.0.0.1:*"></head><body>Studio</body>';
  await writeFile(join(clientDirectory, "index.html"), desktopPage);
  const manifest = await readFile(new URL("../../client/public/manifest.webmanifest", import.meta.url));
  await writeFile(join(clientDirectory, "manifest.webmanifest"), manifest);
  await writeFile(join(root, "private.txt"), "private");
  const gateway = new RemoteGateway({ origin, clientDirectory, devices, session: { port: upstreamPort, token } });
  const port = await gateway.start(0);
  const sockets: WebSocket[] = [];
  try {
    const page = await get(port, "/");
    assert.equal(page.status, 200); assert.ok(page.body.includes('name="arke-remote"'));
    assert.ok(!page.body.includes(token)); assert.ok(!page.body.includes("127.0.0.1"));
    assert.ok(page.body.includes('rel="manifest" href="/manifest.webmanifest"'));
    const installed = await get(port, "/manifest.webmanifest");
    assert.equal(installed.status, 200, "installation metadata is available before pairing");
    assert.equal(installed.headers["content-type"], "application/manifest+json");
    assert.equal(installed.body, manifest.toString());
    assert.equal(await readFile(join(clientDirectory, "index.html"), "utf8"), desktopPage, "desktop CSP is unchanged");
    assert.equal((await get(port, "/../private.txt")).status, 404);
    assert.equal((await get(port, "/.dev/transport-8791.json")).status, 404);
    assert.equal((await get(port, "/remote/session")).status, 401);
    assert.equal((await get(port, "/media/world/a.png")).status, 401);
    assert.equal((await get(port, "/", { headers: { Host: "evil.example" } })).status, 403);
    // Android Chrome sends a home-screen or QR launch, and every reload of it, as cross-site.
    const launch = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
    const launched = await get(port, "/", { headers: launch });
    assert.equal(launched.status, 200, "a launch from another app opens the shell");
    assert.ok(launched.body.includes('name="arke-remote"'));
    assert.equal((await get(port, "/", { headers: { ...launch, Host: "evil.example" } })).status, 403);
    assert.equal((await get(port, "/manifest.webmanifest", { headers: { ...launch, "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "manifest" } })).status, 403,
      "only a top-level visit is admitted cross-site");
    for (const path of ["/remote/session", "/remote/device", "/media/world/a.png"]) {
      assert.equal((await get(port, path, { headers: launch })).status, 403, path + " stays same-site only");
    }
    assert.equal((await get(port, "/", { method: "POST", headers: launch })).status, 403);
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
    const dictation = JSON.stringify({ kind: "transcribe-dictation", requestId: "recording", contentType: "audio/webm", audioBase64: "a".repeat(2 * 1024 * 1024) });
    const echoed = once(phone, "message"); phone.send(dictation);
    assert.deepEqual(JSON.parse((await echoed)[0].toString()), JSON.parse(dictation), "remote transport retains large-frame support in both directions");
    const worldId = "01ARZ3NDEKTSV4RRFFQ69G5FAV", conversationId = "cv_" + worldId;
    const upload = { kind: "world-chat-upload", worldId, conversationId, name: "notes.txt", data: Buffer.from("Device-selected notes").toString("base64") };
    ClientMessageSchema.parse(upload);
    const uploaded = once(phone, "message"); phone.send(JSON.stringify(upload));
    assert.deepEqual(JSON.parse((await uploaded)[0].toString()), upload, "paired device uploads use bytes rather than host paths");
    const commands = hostOnlyCommandFixtures(join(root, "private.txt"));
    for (const command of commands) {
      ClientMessageSchema.parse(command);
      const answer = once(phone, "message"); phone.send(JSON.stringify(command));
      const refused = RemoteCommandRefusalSchema.parse(JSON.parse((await answer)[0].toString()));
      assert.deepEqual(refused, { kind: "command-refused", refused: "host-only", command: command.kind });
      assert.equal(phone.readyState, WebSocket.OPEN, command.kind + " keeps the session alive");
    }
    assert.deepEqual(received.filter((message: any) => message.kind !== "hello"), [JSON.parse(dictation), upload],
      "no host command or secret reaches the upstream session");
    const decision = ClientMessageSchema.parse({ kind: "conversation-action-decide", worldId, conversationId,
      actionId: "act_" + worldId, expectedConversationSeq: 2, expectedStatus: "pending", decision: "approve", requestId: worldId });
    const scoped = once(phone, "message"); phone.send(JSON.stringify(decision));
    assert.deepEqual(JSON.parse((await scoped)[0].toString()), { ...decision, hostActions: "refuse" },
      "omitting the restriction cannot let a paired peer approve native work");
    const allowed = once(phone, "message"); phone.send(JSON.stringify({ kind: "refresh-diagnostics" }));
    assert.equal(JSON.parse((await allowed)[0].toString()).kind, "refresh-diagnostics", "allowed commands still work after all refusals");
    // The trusted desktop transport bypasses this remote-only boundary.
    const desktop = new WebSocket(`ws://127.0.0.1:${upstreamPort}`); sockets.push(desktop); await once(desktop, "open");
    const ready = once(desktop, "message"); desktop.send(JSON.stringify({ kind: "hello", token })); await ready;
    for (const command of commands) { const result = once(desktop, "message"); desktop.send(JSON.stringify(command)); assert.deepEqual(JSON.parse((await result)[0].toString()), command); }
    const trustedDecision = once(desktop, "message"); desktop.send(JSON.stringify(decision));
    assert.deepEqual(JSON.parse((await trustedDecision)[0].toString()), decision, "desktop decisions keep their native authority");
    const laptopDevice = await paired(devices, "Laptop");
    const own = await get(port, "/remote/device", { headers: { Cookie: credentialCookie } });
    assert.equal(own.status, 200);
    const deviceInfo = RemoteDeviceInfoSchema.parse(JSON.parse(own.body));
    assert.equal(deviceInfo.name, "Phone"); assert.ok(deviceInfo.pairedAt > 0); assert.ok(deviceInfo.expiresAt! > deviceInfo.pairedAt);
    assert.ok(!own.body.includes("Laptop") && !own.body.includes(proof) && !own.body.includes(id));
    assert.equal((await get(port, "/remote/device")).status, 401);

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
it("cookies captured by another service cannot authenticate without the origin-bound browser key", async () => {
  const root = await temporary();
  const devices = new RemoteDevices(join(root, "devices.json")); await devices.load();
  await writeFile(join(root, "index.html"), "<head></head>");
  const { proof } = await paired(devices);
  const captured = sealed(proof);
  const gateway = new RemoteGateway({ origin, clientDirectory: root, devices, session: { port: 9999, token: "a".repeat(64) } });
  const port = await gateway.start(0);
  try {
    for (const key of ["", "c".repeat(64)]) {
      for (const path of ["/remote/session", "/remote/device", "/media/world/a.png"]) {
        assert.equal((await get(port, path, { headers: { Cookie: "__Host-arke-device=" + captured, "x-arke-browser-key": key } })).status, 401);
      }
      assert.equal((await get(port, "/remote/pair", { headers: { Cookie: "__Host-arke-pair=" + captured, "x-arke-browser-key": key } })).status, 410);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`, key ? ["arke-remote", "arke-browser." + key] : [],
        { origin, headers: { Host: new URL(origin).host, Cookie: "__Host-arke-device=" + captured } });
      await new Promise<void>(resolve => socket.once("error", () => resolve()));
      socket.terminate();
    }
    assert.equal((await get(port, "/remote/session", { headers: { Cookie: "__Host-arke-device=" + proof } })).status, 401, "legacy plaintext proofs cannot bypass browser binding");
    assert.equal((await get(port, "/remote/session", { headers: { Cookie: "__Host-arke-device=" + sealBrowserProof(proof, browserKey, origin + ":9443") } })).status, 401, "the seal is bound to the complete origin");
    assert.equal((await get(port, "/remote/session", { headers: { Cookie: "__Host-arke-device=" + captured } })).status, 204);
  } finally { await gateway.stop(); await devices.stop(); await rm(root, { recursive: true, force: true }); }
});
it("names why a phone was refused, without its credentials, once a minute per reason", async () => {
  const root = await temporary();
  const devices = new RemoteDevices(join(root, "devices.json")); await devices.load();
  await writeFile(join(root, "index.html"), "<head></head>");
  const traces: { kind: string; detail: Record<string, unknown> }[] = [];
  let logged = "";
  const gateway = new RemoteGateway({ origin, clientDirectory: root, devices, session: { port: 9999, token: "a".repeat(64) },
    trace: (kind, detail) => { traces.push({ kind, detail }); logged += JSON.stringify(detail); } });
  const port = await gateway.start(0);
  const why = () => traces.splice(0).map(trace => trace.detail.why);
  try {
    const { proof, id } = await paired(devices);
    const cookie = { Cookie: "__Host-arke-device=" + sealed(proof) };
    assert.equal((await get(port, "/remote/session", { headers: cookie })).status, 204);
    assert.deepEqual(why(), [], "an answered check is not traced");
    assert.equal((await get(port, "/remote/session")).status, 401);
    assert.deepEqual(why(), ["no device cookie"]);
    assert.equal((await get(port, "/remote/session", { headers: { ...cookie, "x-arke-browser-key": "" } })).status, 401);
    assert.deepEqual(why(), ["no browser key"], "the request the worker did not handle");
    assert.equal((await get(port, "/remote/session", { headers: { ...cookie, "x-arke-browser-key": "c".repeat(64) } })).status, 401);
    assert.deepEqual(why(), ["cookie sealed with another browser key"]);
    await devices.revoke(id);
    assert.equal((await get(port, "/remote/session", { headers: cookie })).status, 401);
    assert.equal((await get(port, "/remote/session", { headers: cookie })).status, 401);
    assert.deepEqual(why(), ["device not paired: revoked, expired or never approved"], "a polling phone is traced once");
    assert.equal((await get(port, "/", { headers: { Host: "evil.example" } })).status, 403);
    assert.deepEqual(why(), ["another address"]);
    assert.ok(!logged.includes(proof) && !logged.includes(browserKey) && !logged.includes(sealed(proof).slice(3, 20)), "no credential is logged");
  } finally { await gateway.stop(); await devices.stop(); await rm(root, { recursive: true, force: true }); }
});
it("served page CSP names only the hosted origin; the source page is not weakened", () => {
  const html = '<head><meta http-equiv="Content-Security-Policy" content="connect-src ws://localhost:*"></head>';
  const served = remotePage(html, origin);
  assert.ok(served.includes("wss://studio.example.ts.net"));
  assert.ok(!served.includes("localhost"));
  assert.ok(html.includes("localhost"));
});
