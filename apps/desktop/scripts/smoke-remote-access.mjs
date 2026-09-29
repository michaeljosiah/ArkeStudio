import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { Coordinator } from "../../../packages/coordinator/src/coordinator.ts";
import { FsWorldProvider } from "../../../packages/coordinator/src/world/provider.ts";
import { RemoteDevices } from "../../../packages/coordinator/src/remote-access/devices.ts";
import { RemoteGateway } from "../../../packages/coordinator/src/remote-access/gateway.ts";

// Opt-in: actual Serve TLS and browser cookies, plus the built sandboxed desktop file page.
// Uses an otherwise unconfigured HTTPS port, disposable copied data, and no generation.
if (!process.argv.includes("--tailscale")) throw new Error("Pass --tailscale to run this live tailnet smoke on HTTPS port 8444.");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const ts = async args => (await execute("tailscale", args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout;
const initial = JSON.parse(await ts(["serve", "status", "--json"]));
assert.ok(!initial.TCP?.["8444"] && !Object.keys(initial.Web ?? {}).some(key => key.endsWith(":8444")), "8444 must be unused");
assert.ok(!Object.entries(initial.AllowFunnel ?? {}).some(([key, value]) => value && key.endsWith(":8444")), "Funnel must be off");
const status = JSON.parse(await ts(["status", "--json"]));
const name = status.Self.DNSName.replace(/\.$/, "");
assert.ok(status.CertDomains.includes(name));
const origin = `https://${name}:8444`;
const dir = await mkdtemp(join(tmpdir(), "arke-remote-smoke-"));
await cp(join(root, "fixtures/worlds"), join(dir, "worlds"), { recursive: true });
const worldId = JSON.parse(await readFile(join(dir, "worlds/the-undersong/world.json"), "utf8")).worldId;
const createCoordinator = () => new Coordinator({ provider: new FsWorldProvider(dir), adapter: null, appRoot: dir, appVersion: "smoke",
  changeLogPath: join(dir, "logs/changes.jsonl"), transportAuth: { token: randomBytes(32).toString("hex"), allowedOrigins: ["file://", "null"] } });
let coordinator = createCoordinator();
let gateway;
let mapping = false;
let devices = new RemoteDevices(join(dir, "remote-devices.json"));
let session;
let gatewayPort;
let pairingDuration = 90;
const createGateway = () => new RemoteGateway({ origin, clientDirectory: join(root, "packages/client/dist"), devices, session });
try {
  session = await coordinator.start(); await devices.load();
  gateway = createGateway(); gatewayPort = await gateway.start(0);
  await ts(["serve", "--bg", "--https=8444", `http://127.0.0.1:${gatewayPort}`]); mapping = true;
  const probe = await fetch(origin); assert.equal(probe.status, 200);
  await writeFile(join(dir, "main.cjs"), `(${electronMain.toString()})().catch(error => { console.error(error); require("electron").app.exit(1); });`);
  const child = spawn(require("electron"), [join(dir, "main.cjs")], { windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env, ARKE_REMOTE_SMOKE: JSON.stringify({ dir, origin, worldId, ...session,
      qrDecoder: require.resolve("jsqr"),
      page: join(root, "packages/client/dist/index.html"), preload: join(root, "apps/desktop/dist/preload.cjs") }) } });
  child.on("message", async ({ id, command }) => {
    try {
      let pairing;
      if (command.kind === "pair") pairing = devices.createCode();
      if (command.kind === "duration") pairingDuration = command.duration;
      if (command.kind === "approve") await devices.approve(command.id, pairingDuration);
      if (command.kind === "revoke") { await devices.revoke(command.id); gateway.recheckDevices(); }
      if (command.kind === "check-captured-cookie") {
        for (const key of ["", "c".repeat(64)]) {
          const replay = await fetch(origin + "/remote/session", { headers: {
            Cookie: "__Host-arke-device=" + command.cookie, "x-arke-browser-key": key,
          } });
          assert.equal(replay.status, 401, "a sibling service cannot replay a captured cookie");
        }
      }
      if (command.kind === "restart") {
        console.log("[smoke] restarting gateway");
        await gateway.stop(); console.log("[smoke] gateway stopped");
        await devices.stop(); await coordinator.stop(); console.log("[smoke] coordinator stopped");
        const previousToken = session.token;
        coordinator = createCoordinator(); session = await coordinator.start();
        assert.notEqual(session.token, previousToken);
        devices = new RemoteDevices(join(dir, "remote-devices.json")); await devices.load();
        gateway = createGateway(); await gateway.start(gatewayPort);
      }
      if (child.connected) child.send({ id, result: { status: { enabled: true, running: true, startOnLogin: false, startupSupported: false,
        pairingDuration, url: origin, reason: null, devices: devices.list(), pending: devices.pending() }, ...(pairing ? { pairing } : {}),
        ...(command.kind === "restart" ? { session } : {}) } });
    } catch (error) { if (child.connected) child.send({ id, error: String(error) }); }
  });
  assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }), 0);
  assert.ok(!String(await readFile(join(dir, "remote-devices.json"))).includes(session.token));
  console.log(`Remote pairing smoke passed; disposable profile and screenshots: ${dir}`);
} finally {
  await gateway?.stop(); await devices.stop(); await coordinator.stop();
  if (mapping) {
    const current = JSON.parse(await ts(["serve", "status", "--json"]));
    if (current.Web?.[`${name}:8444`]?.Handlers?.["/"]?.Proxy === `http://127.0.0.1:${gatewayPort}`) await ts(["serve", "--https=8444", "off"]);
  }
}

async function electronMain() {
  const { app, BrowserWindow, ipcMain, clipboard } = require("electron");
  const assert = require("node:assert/strict");
  const { writeFile } = require("node:fs/promises");
  const { join } = require("node:path");
  const config = JSON.parse(process.env.ARKE_REMOTE_SMOKE); delete process.env.ARKE_REMOTE_SMOKE;
  app.disableHardwareAcceleration(); app.setPath("userData", join(config.dir, "browser-profile"));
  const timeout = setTimeout(() => { console.error("Remote smoke timed out"); app.exit(1); }, 180000);
  let sequence = 0;
  const rpc = command => new Promise((resolve, reject) => {
    const id = ++sequence;
    const listener = message => { if (message.id !== id) return; process.off("message", listener); message.error ? reject(new Error(message.error)) : resolve(message.result); };
    process.on("message", listener); process.send({ id, command });
  });
  await app.whenReady();
  ipcMain.on("arke:get-theme", event => { event.returnValue = { preference: "system", resolved: "light" }; });
  ipcMain.on("arke:startup-state-ready", event => event.sender.send("arke:startup-state", { status: "ready", port: config.port, token: config.token }));
  ipcMain.handle("arke:remote-access", async (_event, command) => {
    const reply = await rpc(command);
    if (command.kind === "copy-link") { clipboard.writeText(reply.status.url); reply.copied = true; }
    return reply;
  });
  const owner = new BrowserWindow({ show: false, width: 1200, height: 850,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: config.preload } });
  const browserOptions = { show: false, width: 420, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: "persist:remote-smoke" } };
  let phone = new BrowserWindow(browserOptions);
  const js = (window, source) => window.webContents.executeJavaScript(source);
  const until = async (window, condition) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { if (await js(window, condition)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Timed out: ${condition}\n${await js(window, "document.body.innerText")}`);
  };
  const shot = async (window, name) => {
    await js(window, "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
    await writeFile(join(config.dir, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  await owner.loadFile(config.page, { hash: "/settings/remote-access" });
  await until(owner, "[...document.querySelectorAll('button')].some(b => b.textContent === 'Pair a device')");
  await js(owner, "document.querySelector('.remote-access__share > svg').scrollIntoView({ block: 'center' })");
  await js(owner, "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
  // The hidden window's first capture can still be its blank startup surface. Prime that
  // surface after layout settles, then decode the actual rendered QR on the next frame.
  owner.webContents.invalidate();
  await owner.webContents.capturePage();
  await new Promise(resolve => setTimeout(resolve, 100));
  const qrRect = await js(owner, `(() => {
    const qr = document.querySelector('.remote-access__share > svg');
    const r = qr.getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  })()`);
  const qrImage = await owner.webContents.capturePage(qrRect);
  await writeFile(join(config.dir, "desktop-qr.png"), qrImage.toPNG());
  const bitmap = qrImage.toBitmap(), dimensions = qrImage.getSize();
  const rgba = new Uint8ClampedArray(bitmap.length);
  for (let pixel = 0; pixel < bitmap.length; pixel += 4) {
    rgba[pixel] = bitmap[pixel + 2]; rgba[pixel + 1] = bitmap[pixel + 1]; rgba[pixel + 2] = bitmap[pixel]; rgba[pixel + 3] = bitmap[pixel + 3];
  }
  assert.equal(require(config.qrDecoder)(rgba, dimensions.width, dimensions.height)?.data, config.origin,
    'the rendered QR decodes to only the stable HTTPS address');
  const previousClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF() };
  const previousImage = clipboard.readImage();
  if (!previousImage.isEmpty()) previousClipboard.image = previousImage;
  try {
    await js(owner, "[...document.querySelectorAll('button')].find(b => b.textContent === 'Copy link').click()");
    await until(owner, "document.body.innerText.includes('Link copied')");
    assert.equal(clipboard.readText(), config.origin);
  } finally { if (clipboard.readText() === config.origin) clipboard.write(previousClipboard); }
  await shot(owner, "desktop-link-sharing");
  assert.equal(await js(owner, "document.querySelector('select[aria-label=\"Remember approved devices for\"]').value"), "90");
  await js(owner, `(() => {
    const select = document.querySelector('select[aria-label="Remember approved devices for"]');
    select.value = 'never'; select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(owner, "document.querySelector('select[aria-label=\"Remember approved devices for\"]').value === 'never' && !document.querySelector('select[aria-label=\"Remember approved devices for\"]').disabled");
  await phone.loadURL(config.origin + "/#/worlds");
  await until(phone, "document.querySelector('form') !== null");
  await shot(phone, "phone-pairing");
  await js(owner, "[...document.querySelectorAll('button')].find(b => b.textContent === 'Pair a device').click()");
  await until(owner, "document.querySelector('.remote-access__code') !== null");
  const code = await js(owner, "document.querySelector('.remote-access__code').textContent");
  await owner.loadFile(config.page, { hash: "/w/" + config.worldId });
  await until(owner, "document.querySelector('[data-screen=world-overview]') !== null");
  await js(phone, `(() => { const input = document.querySelector('input[autocomplete="one-time-code"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(code)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await js(phone, "document.querySelector('form').requestSubmit()");
  await until(owner, "document.querySelector('.fy-pairask') !== null");
  assert.ok(await js(owner, `(() => {
    const button = [...document.querySelectorAll('.fy-pairask button')].find(b => b.textContent === 'Approve');
    button.scrollIntoView({ block: 'center' });
    const bounds = button.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight;
  })()`), "desktop approval must be reachable over the world screen");
  assert.ok(await js(owner, "document.querySelector('[data-screen=world-overview]') !== null"));
  await shot(owner, "desktop-approval");
  await js(owner, "[...document.querySelectorAll('.fy-pairask button')].find(b => b.textContent === 'Approve').click()");
  await until(phone, "document.querySelector('[data-screen=world-picker]') !== null");
  await owner.loadFile(config.page, { hash: "/settings/remote-access" });
  await until(owner, "document.body.innerText.includes('Never expires')");
  await shot(owner, "desktop-duration");
  const cookie = (await phone.webContents.session.cookies.get({ url: config.origin, name: "__Host-arke-device" }))[0];
  assert.ok(cookie && !cookie.session && cookie.httpOnly && cookie.secure);
  assert.ok(cookie.value.startsWith("v1."), "device proofs are sealed to the browser origin");
  await rpc({ kind: "check-captured-cookie", cookie: cookie.value });
  assert.ok(cookie.expirationDate > Date.now() / 1000 + 399 * 86400, "Never uses a renewable persistent cookie");
  assert.equal(await js(phone, "document.cookie"), "");
  assert.ok(!(await phone.webContents.getURL()).includes("arke-session"));
  await shot(phone, "phone-worlds");
  const imageStatus = await js(phone, "fetch('/media/the-undersong/world-art.png', { headers: { Range: 'bytes=0-31' } }).then(r => r.status)");
  assert.equal(imageStatus, 206);
  assert.equal(await js(phone, "new Promise(resolve => { const image = new Image(); const done = result => { clearTimeout(timer); image.remove(); resolve(result); }; const timer = setTimeout(() => done(false), 15000); image.onload = () => done(true); image.onerror = () => done(false); document.body.append(image); image.src = '/media/the-undersong/world-art.png'; })"), true,
    "native image requests receive the browser key through the worker");
  console.log("[smoke] native media authenticated");
  await phone.webContents.session.cookies.flushStore();
  phone.destroy(); phone = new BrowserWindow(browserOptions);
  await phone.loadURL(config.origin + "/#/worlds");
  await until(phone, "document.querySelector('[data-screen=world-picker]') !== null");
  console.log("[smoke] browser reopened");
  Object.assign(config, (await rpc({ kind: "restart" })).session);
  await phone.loadURL(config.origin + "/#/worlds");
  await until(phone, "document.querySelector('[data-screen=world-picker]') !== null");
  await js(owner, "[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Revoke ')).click()");
  await until(phone, "document.querySelector('form') !== null && !document.querySelector('[data-screen=world-picker]')");
  await shot(phone, "phone-revoked");
  await owner.loadFile(config.page, { hash: "/settings/remote-access" });
  await until(owner, "[...document.querySelectorAll('button')].some(b => b.textContent === 'Pair a device')");
  console.log("[smoke] real Serve TLS: decoded QR, native Copy link, duration selection, Never approval, persistent HttpOnly cookie, WSS, media, browser reopen, host restart, revocation and desktop file-page reload passed");
  clearTimeout(timeout); phone.destroy(); owner.destroy(); app.exit(0);
}
