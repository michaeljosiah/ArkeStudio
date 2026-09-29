import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { request } from "node:http";
import { it } from "node:test";
import { DesktopRemoteAccess } from "../src/remote-access.js";
import { ServeCleanupRequired, TailscaleServe, type TailscaleRun } from "../src/tailscale-serve.js";

const origin = "https://studio.example.ts.net";
function tailscale() {
  let config: { TCP?: Record<string, unknown>; Web?: Record<string, unknown>; AllowFunnel?: Record<string, boolean> } = {};
  const commands: string[][] = [];
  const execute: TailscaleRun = async args => {
    commands.push(args);
    if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: "studio.example.ts.net." },
      CurrentTailnet: { MagicDNSEnabled: true }, CertDomains: ["studio.example.ts.net"] });
    if (args[1] === "status") return JSON.stringify(config);
    const port = args.find(arg => arg.startsWith("--https="))!.split("=")[1];
    const key = `studio.example.ts.net:${port}`;
    if (args.includes("off")) { delete config.TCP?.[port]; delete config.Web?.[key]; return ""; }
    config.TCP = { ...config.TCP, [port]: { HTTPS: true } };
    config.Web = { ...config.Web, [key]: { Handlers: { "/": { Proxy: args.at(-1) } } } };
    return "";
  };
  return { client: new TailscaleServe(execute), commands, set: (value: typeof config) => { config = value; }, get: () => config };
}
it("Serve refuses occupied ports and Funnel, and removes only Studio's exact mapping", async () => {
  const fake = tailscale();
  assert.equal(await fake.client.origin(), origin);
  fake.set({ TCP: { "443": { HTTPS: true } }, Web: { "studio.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } } } } });
  await assert.rejects(fake.client.enable(origin, 8793, false), /Another service/);
  await fake.client.disable(origin, 8793);
  await fake.client.disable(null, 8793);
  assert.ok(!fake.commands.some(args => args.includes("off")));
  fake.set({ AllowFunnel: { "studio.example.ts.net:443": true } });
  await assert.rejects(fake.client.enable(origin, 8793, false), /Another service/);
  fake.set({});
  assert.equal(await fake.client.enable(origin, 8793, false), true);
  assert.equal(await fake.client.enable(origin, 8793, true), false);
  await assert.rejects(fake.client.enable(origin, 8793, false), /Another service/);
  await fake.client.disable(origin, 8793);
  assert.deepEqual(fake.commands.at(-2), ["serve", "--https=443", "off"]);
  const removed = fake.commands.filter(args => args.includes("off")).length;
  fake.set({ TCP: { "443": { HTTPS: true } }, AllowFunnel: { "studio.example.ts.net:443": true },
    Web: { "studio.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8793" } } } } });
  await assert.rejects(fake.client.disable(origin, 8793), /still forwards/);
  fake.set({ TCP: { "443": { TCPForward: "127.0.0.1:8793", TerminateTLS: "studio.example.ts.net" } } });
  await assert.rejects(fake.client.disable(origin, 8793), /still forwards/);
  assert.equal(fake.commands.filter(args => args.includes("off")).length, removed, "a changed mapping is left for its owner, while shutdown fails closed");
  assert.ok(!fake.commands.some(args => args.includes("reset")));
});
it("address selection skips TCP, web and Funnel reservations and preserves a saved address", async () => {
  const fake = tailscale();
  fake.set({ TCP: { "443": { TCPForward: "127.0.0.1:5173" } },
    Web: { "studio.example.ts.net:8443": { Handlers: {} } }, AllowFunnel: { "studio.example.ts.net:9443": true } });
  assert.equal(await fake.client.origin(), origin + ":10443");
  assert.equal(await fake.client.origin(origin + ":14443"), origin + ":14443");
  assert.equal(await fake.client.origin(origin), origin + ":10443", "old failed enable settings recover automatically");
  await assert.rejects(fake.client.origin("https://other.example.ts.net"), /tailnet address changed/);
  assert.ok(!fake.commands.some(args => args.includes("--bg") || args.includes("off")));
  fake.set({ TCP: Object.fromEntries([443, 8443, 9443, 10443, 11443, 12443, 13443, 14443, 15443, 16443, 17443, 18443, 19443]
    .map(port => [String(port), { HTTPS: true }])) });
  await assert.rejects(fake.client.origin(), /could not find an available remote address/);
});
it("desktop automatically shares an alternate address, copies it, and keeps it across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-conflict-"));
  await writeFile(join(root, "index.html"), "<head></head>");
  const fake = tailscale();
  const existing = { TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } }, Web: {
    "studio.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } } },
    "studio.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8791" } } },
  } };
  fake.set(structuredClone(existing));
  const copied: string[] = [];
  const options = { root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: fake.client, writeClipboard: (text: string) => { copied.push(text); } };
  let host = new DesktopRemoteAccess(options);
  try {
    await host.initialize();
    const reply = await host.command({ kind: "enable" });
    assert.equal(reply.status.running, true); assert.equal(reply.status.reason, null);
    assert.equal(reply.status.url, origin + ":9443");
    const pageStatus = (host: string) => new Promise<number | undefined>((resolve, reject) => {
      request({ hostname: "127.0.0.1", port: 8793, path: "/", headers: { Host: host, Origin: origin + ":9443" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      }).on("error", reject).end();
    });
    assert.equal(await pageStatus("studio.example.ts.net:9443"), 200);
    assert.equal(await pageStatus("studio.example.ts.net"), 403, "the gateway requires the selected origin including its port");
    await host.command({ kind: "copy-link" }); assert.deepEqual(copied, [origin + ":9443"]);
    assert.equal(JSON.parse(await readFile(join(root, "remote/settings.json"), "utf8")).origin, origin + ":9443");
    await host.stop(); assert.deepEqual(fake.get(), existing);
    fake.set({}); // Even if the default address becomes free, bookmarks keep working.
    host = new DesktopRemoteAccess(options); await host.initialize();
    assert.equal(host.status().running, true); assert.equal(host.status().url, origin + ":9443");
    await host.command({ kind: "disable" });
    assert.equal(host.status().enabled, false);
    assert.ok(fake.commands.filter(args => args.includes("off")).every(args => args.includes("--https=9443")));
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});
it("recovery discovers alternate mappings and leaves modified or public mappings untouched", async () => {
  const fake = tailscale();
  await fake.client.enable(origin + ":9443", 8793, false);
  await fake.client.disable(null, 8793);
  assert.ok(fake.commands.some(args => args.includes("--https=9443") && args.includes("off")));
  for (const config of [
    { TCP: { "9443": { HTTPS: true } }, Web: { "studio.example.ts.net:9443": { Handlers: {
      "/": { Proxy: "http://127.0.0.1:8793" }, "/other": { Proxy: "http://127.0.0.1:5173" },
    } } } },
    { TCP: { "9443": { HTTPS: true } }, Web: { "studio.example.ts.net:9443": { Handlers: {
      "/": { Proxy: "http://127.0.0.1:8793" },
    } } }, AllowFunnel: { "studio.example.ts.net:9443": true } },
  ]) {
    fake.set(config);
    const removals = fake.commands.filter(args => args.includes("off")).length;
    await assert.rejects(fake.client.disable(null, 8793), /still forwards/);
    assert.equal(fake.commands.filter(args => args.includes("off")).length, removals);
  }
});
it("a CLI failure after publication rolls back only the verified new mapping", async () => {
  let published = false;
  let removed = false;
  const client = new TailscaleServe(async args => {
    if (args[1] === "status") return JSON.stringify(published ? { TCP: { "443": { HTTPS: true } },
      Web: { "studio.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8793" } } } } } : {});
    if (args.includes("off")) { removed = true; published = false; return ""; }
    published = true; throw new Error("CLI timed out after publication");
  });
  await assert.rejects(client.enable(origin, 8793, false), /timed out/);
  assert.equal(removed, true);
  assert.equal(published, false);
});
it("desktop hosting persists opt-in, restarts on the same coordinator, and disables startup with access", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-desktop-remote-"));
  const clientDirectory = join(root, "client"); await mkdir(clientDirectory); await writeFile(join(clientDirectory, "index.html"), "<head></head>");
  const fake = tailscale(); const login: boolean[] = [];
  const options = { root, clientDirectory, session: { port: 9999, token: "a".repeat(64) }, startupSupported: true,
    setStartOnLogin: (value: boolean) => { login.push(value); }, tailscale: fake.client };
  let host = new DesktopRemoteAccess(options);
  try {
    await host.initialize(); assert.equal(host.status().running, false);
    assert.equal((await host.command({ kind: "enable" })).status.running, true);
    assert.equal(host.status().url, origin);
    await host.command({ kind: "startup", enabled: true });
    assert.deepEqual(login, [true]);
    assert.ok((await host.command({ kind: "pair" })).pairing?.code);
    await host.stop(); assert.equal(host.status().running, false);
    assert.ok(fake.commands.some(args => args.includes("off")), "Quit withdraws the HTTPS mapping");
    const publications = fake.commands.filter(args => args.includes("--bg")).length;
    host = new DesktopRemoteAccess(options); await host.initialize();
    assert.equal(host.status().running, true); assert.equal(host.status().startOnLogin, true);
    assert.equal(fake.commands.filter(args => args.includes("--bg")).length, publications + 1, "restart recreates the mapping");
    assert.deepEqual(host.status().pending, []);
    await host.command({ kind: "disable" });
    assert.equal(host.status().running, false); assert.equal(host.status().enabled, false);
    assert.deepEqual(login, [true, false]);
    assert.equal(JSON.parse(await readFile(join(root, "remote/settings.json"), "utf8")).enabled, false);
    assert.ok(fake.commands.some(args => args.includes("off")));
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});
it("duration migrates to 90, persists while off and across restart, and affects only subsequent approvals", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-duration-"));
  await mkdir(join(root, "remote")); await writeFile(join(root, "index.html"), "<head></head>");
  const path = join(root, "remote/settings.json");
  await writeFile(path, JSON.stringify({ enabled: false, startOnLogin: false, origin: null }));
  const options = { root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: tailscale().client };
  let host = new DesktopRemoteAccess(options);
  try {
    await host.initialize(); assert.equal(host.status().pairingDuration, 90);
    assert.equal((await host.command({ kind: "duration", duration: 30 })).status.pairingDuration, 30);
    assert.equal(JSON.parse(await readFile(path, "utf8")).pairingDuration, 30);
    assert.equal((await host.command({ kind: "enable" })).status.running, true);
    for (const duration of [30, 90, 120, "never"] as const) {
      const previous = host.status().devices;
      const { pairing } = await host.command({ kind: "pair" });
      await new Promise<void>((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: 8793, path: "/remote/pair", method: "POST",
          headers: { Host: new URL(origin).host, Origin: origin, "Content-Type": "application/json", "x-arke-browser-key": "b".repeat(64) } }, res => {
          res.resume(); res.once("end", () => {
            try { assert.equal(res.statusCode, 202); resolve(); } catch (error) { reject(error); }
          });
        });
        req.on("error", reject); req.end(JSON.stringify({ code: pairing!.code, name: String(duration) }));
      });
      await host.command({ kind: "duration", duration });
      assert.deepEqual(host.status().devices, previous, "changing the setting leaves existing approvals untouched");
      const id = host.status().pending[0]!.id;
      await host.command({ kind: "approve", id });
      const device = host.status().devices.find(row => row.id === id)!;
      assert.equal(device.expiresAt, duration === "never" ? null : device.createdAt + duration * 86400_000,
        "use the setting at approval, even when the request predates the change");
      assert.deepEqual(host.status().devices.filter(row => row.id !== id), previous);
    }
    const approved = host.status().devices;
    for (const duration of [0, -1, 60, 365, null, "90", "forever"]) {
      await assert.rejects(host.command({ kind: "duration", duration }));
      assert.equal(host.status().pairingDuration, "never");
    }
    await host.command({ kind: "disable" });
    assert.equal(host.status().pairingDuration, "never");
    await host.stop(); host = new DesktopRemoteAccess(options); await host.initialize();
    assert.equal(host.status().pairingDuration, "never"); assert.equal(host.status().enabled, false);
    assert.deepEqual(host.status().devices, approved);
    assert.equal((await host.command({ kind: "enable" })).status.pairingDuration, "never");
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});
it("failed duration persistence leaves the active setting unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-duration-failure-"));
  const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: tailscale().client });
  try {
    await host.initialize();
    await mkdir(join(root, "remote/settings.json"), { recursive: true });
    const reply = await host.command({ kind: "duration", duration: "never" });
    assert.ok(reply.status.reason); assert.equal(reply.status.pairingDuration, 90);
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});
it("copies only the running host's clean origin and reports clipboard failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-copy-"));
  await writeFile(join(root, "index.html"), "<head></head>");
  const copied: string[] = []; let fail = false;
  const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: tailscale().client,
    writeClipboard: text => { if (fail) throw new Error("Clipboard busy"); copied.push(text); } });
  try {
    await host.initialize();
    assert.equal((await host.command({ kind: "copy-link" })).copied, undefined);
    assert.deepEqual(copied, []);
    await host.command({ kind: "enable" }); await host.command({ kind: "pair" });
    assert.equal((await host.command({ kind: "copy-link", url: "https://wrong.example/#secret" })).copied, true);
    assert.deepEqual(copied, [origin]);
    fail = true;
    const rejected = await host.command({ kind: "copy-link" });
    assert.equal(rejected.copied, undefined); assert.match(rejected.status.reason!, /Clipboard busy/);
    await host.command({ kind: "disable" });
    assert.equal((await host.command({ kind: "copy-link" })).copied, undefined);
    assert.deepEqual(copied, [origin]);
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});
it("persists recoverable ownership before initial and subsequent Serve publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-publication-intent-"));
  await writeFile(join(root, "index.html"), "<head></head>");
  const fake = tailscale();
  const publish = fake.client.enable.bind(fake.client);
  let publications = 0;
  fake.client.enable = async (...args) => {
    assert.deepEqual(JSON.parse(await readFile(join(root, "remote/settings.json"), "utf8")),
      { enabled: true, startOnLogin: false, origin, pairingDuration: 90 }, "a process exit after Serve publishes must leave durable recovery intent");
    publications++;
    return publish(...args);
  };
  const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: fake.client });
  try {
    await host.initialize();
    assert.equal((await host.command({ kind: "enable" })).status.running, true);
    await host.command({ kind: "disable" });
    assert.equal(JSON.parse(await readFile(join(root, "remote/settings.json"), "utf8")).enabled, false);
    assert.equal((await host.command({ kind: "enable" })).status.running, true);
    assert.equal(publications, 2);
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});
it("does not publish when the ownership record cannot be committed", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-intent-failure-"));
  await writeFile(join(root, "index.html"), "<head></head>");
  const fake = tailscale();
  const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: fake.client });
  try {
    await host.initialize();
    await mkdir(join(root, "remote/settings.json"), { recursive: true });
    const reply = await host.command({ kind: "enable" });
    assert.equal(reply.status.running, false); assert.ok(reply.status.reason);
    assert.equal(fake.commands.some(args => args.includes("--bg")), false);
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});
it("Quit keeps its port bound if mapping removal fails, then permits a safe retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-stop-"));
  await writeFile(join(root, "index.html"), "<head></head>");
  const fake = tailscale();
  const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: fake.client });
  const probePort = () => new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(8793, "127.0.0.1", () => server.close(() => resolve()));
  });
  const disable = fake.client.disable.bind(fake.client);
  let failRemoval = true;
  fake.client.disable = async (...args) => {
    if (host.status().running) await assert.rejects(probePort(), { code: "EADDRINUSE" }, "remove mapping before releasing the port");
    if (failRemoval) throw new Error("Serve could not remove the mapping");
    await disable(...args);
  };
  try {
    await host.initialize(); await host.command({ kind: "enable" });
    await assert.rejects(host.stop(), /could not remove/);
    await assert.rejects(probePort(), { code: "EADDRINUSE" }, "failed shutdown cannot expose the cookie to a replacement listener");
    failRemoval = false;
    await host.stop();
    await probePort();
    assert.equal(host.status().running, false);
  } finally { failRemoval = false; await host.stop(); await rm(root, { recursive: true, force: true }); }
});
it("an uncertain failed publication retains its listener until the owner can disable it", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-publish-"));
  await writeFile(join(root, "index.html"), "<head></head>");
  const fake = tailscale();
  fake.client.enable = async () => { throw new ServeCleanupRequired("publication could not be rolled back"); };
  let failRemoval = true;
  fake.client.disable = async () => { if (failRemoval) throw new Error("mapping cleanup unavailable"); };
  const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: fake.client });
  const replacement = createServer();
  try {
    await host.initialize();
    const reply = await host.command({ kind: "enable" });
    assert.equal(reply.status.running, false);
    assert.equal(reply.status.enabled, true, "show the Disable control while cleanup is outstanding");
    await assert.rejects(new Promise<void>((resolve, reject) => {
      replacement.once("error", reject); replacement.listen(8793, "127.0.0.1", resolve);
    }), { code: "EADDRINUSE" });
    failRemoval = false;
    assert.equal((await host.command({ kind: "disable" })).status.enabled, false);
  } finally {
    failRemoval = false;
    if (replacement.listening) await new Promise<void>(resolve => replacement.close(() => resolve()));
    await host.stop(); await rm(root, { recursive: true, force: true });
  }
});
it("a damaged device registry cannot be overwritten by enabling or pairing", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-corrupt-"));
  await mkdir(join(root, "remote")); await writeFile(join(root, "remote/devices.json"), "broken");
  const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: tailscale().client });
  try {
    await host.initialize(); assert.ok(host.status().reason);
    await assert.rejects(host.command({ kind: "enable" }), /records could not be read/);
    assert.equal(await readFile(join(root, "remote/devices.json"), "utf8"), "broken");
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});
it("first launch does not require Tailscale and releases its temporary reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-first-launch-"));
  const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: new TailscaleServe(async () => { throw new Error("Tailscale must not be needed"); }) });
  const probe = createServer();
  try {
    await host.initialize();
    assert.equal(host.status().reason, null); assert.equal(host.status().enabled, false);
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject); probe.listen(8793, "127.0.0.1", () => probe.close(() => resolve()));
    });
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});
it("unreadable or missing ownership records discover and withdraw exact stale forwarding", async () => {
  for (const damage of ["malformed", "unreadable", "missing"] as const) {
    const root = await mkdtemp(join(tmpdir(), "arke-remote-damaged-settings-"));
    await mkdir(join(root, "remote"));
    const path = join(root, "remote/settings.json");
    if (damage === "malformed") await writeFile(path, "broken");
    if (damage === "unreadable") await mkdir(path);
    await writeFile(join(root, "remote/devices.json"), '{"version":1,"devices":[]}');
    const fake = tailscale(); await fake.client.enable(origin, 8793, false);
    const disable = fake.client.disable.bind(fake.client);
    fake.client.disable = async (...args) => {
      const probe = createServer();
      await assert.rejects(new Promise<void>((resolve, reject) => {
        probe.once("error", reject); probe.listen(8793, "127.0.0.1", () => probe.close(() => resolve()));
      }), { code: "EADDRINUSE" }, "the port is already reserved while unreadable settings are being recovered");
      await disable(...args);
    };
    const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
      startupSupported: false, setStartOnLogin: () => {}, tailscale: fake.client });
    try {
      await host.initialize();
      assert.ok(fake.commands.some(args => args.includes("off")), damage);
      assert.equal(host.status().running, false);
      if (damage === "malformed") assert.equal(await readFile(path, "utf8"), "broken");
    } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
  }
});
it("damaged settings keep the port protected through failed cleanup without being overwritten by Disable", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-settings-cleanup-"));
  await mkdir(join(root, "remote"));
  await writeFile(join(root, "remote/settings.json"), "broken");
  const fake = tailscale(); await fake.client.enable(origin, 8793, false);
  const disable = fake.client.disable.bind(fake.client);
  let failRemoval = true;
  fake.client.disable = async (...args) => { if (failRemoval) throw new Error("Tailscale unavailable"); await disable(...args); };
  const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: fake.client });
  try {
    await host.initialize();
    assert.equal(host.status().enabled, true);
    const response = await fetch("http://127.0.0.1:8793/");
    assert.equal(response.status, 503); await response.text();
    assert.match((await host.command({ kind: "disable" })).status.reason!, /Tailscale unavailable/);
    failRemoval = false;
    assert.equal((await host.command({ kind: "disable" })).status.enabled, false);
    assert.equal(await readFile(join(root, "remote/settings.json"), "utf8"), "broken");
    assert.ok(fake.commands.some(args => args.includes("off")));
  } finally { failRemoval = false; await host.stop(); await rm(root, { recursive: true, force: true }); }
});
it("a damaged registry withdraws stale HTTPS before reporting recovery, and Disable preserves its records", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-stale-registry-"));
  await mkdir(join(root, "remote"));
  await writeFile(join(root, "remote/settings.json"), JSON.stringify({ enabled: true, startOnLogin: false, origin }));
  await writeFile(join(root, "remote/devices.json"), "broken");
  const fake = tailscale(); await fake.client.enable(origin, 8793, false);
  const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: fake.client });
  try {
    await host.initialize();
    assert.match(host.status().reason!, /records could not be read/);
    assert.ok(fake.commands.some(args => args.includes("off")), "registry damage cannot strand a published origin");
    await assert.rejects(host.command({ kind: "enable" }), /records could not be read/);
    assert.equal((await host.command({ kind: "disable" })).status.enabled, false);
    assert.equal(await readFile(join(root, "remote/devices.json"), "utf8"), "broken");
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});
it("failed stale-mapping cleanup reserves an inert port until Disable can safely release it", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-remote-stale-removal-"));
  await mkdir(join(root, "remote"));
  await writeFile(join(root, "remote/settings.json"), JSON.stringify({ enabled: true, startOnLogin: false, origin }));
  await writeFile(join(root, "remote/devices.json"), "broken");
  const fake = tailscale(); await fake.client.enable(origin, 8793, false);
  const disable = fake.client.disable.bind(fake.client);
  let failRemoval = true;
  fake.client.disable = async (...args) => { if (failRemoval) throw new Error("Tailscale unavailable"); await disable(...args); };
  const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
    startupSupported: false, setStartOnLogin: () => {}, tailscale: fake.client });
  const probe = createServer();
  try {
    await host.initialize();
    assert.match(host.status().reason!, /Tailscale unavailable/);
    assert.equal(host.status().running, false);
    await assert.rejects(new Promise<void>((resolve, reject) => {
      probe.once("error", reject); probe.listen(8793, "127.0.0.1", resolve);
    }), { code: "EADDRINUSE" });
    const response = await fetch("http://127.0.0.1:8793/");
    assert.equal(response.status, 503); await response.text();
    assert.match((await host.command({ kind: "disable" })).status.reason!, /Tailscale unavailable/);
    failRemoval = false;
    assert.equal((await host.command({ kind: "disable" })).status.enabled, false);
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject); probe.listen(8793, "127.0.0.1", () => probe.close(() => resolve()));
    });
    assert.ok(fake.commands.some(args => args.includes("off")));
    assert.equal(await readFile(join(root, "remote/devices.json"), "utf8"), "broken");
  } finally {
    failRemoval = false; await host.stop();
    if (probe.listening) await new Promise<void>(resolve => probe.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
it("Disable and Quit drain automatic startup before returning, without resurrecting the gateway", async () => {
  for (const action of ["disable", "stop"] as const) {
    const root = await mkdtemp(join(tmpdir(), "arke-remote-startup-race-"));
    await mkdir(join(root, "remote"));
    await writeFile(join(root, "remote/settings.json"), JSON.stringify({ enabled: true, startOnLogin: false, origin }));
    await writeFile(join(root, "index.html"), "<head></head>");
    const fake = tailscale();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const starting = new Promise<void>(resolve => { entered = resolve; });
    const resolveOrigin = fake.client.origin.bind(fake.client);
    fake.client.origin = async () => { entered(); await held; return resolveOrigin(); };
    const host = new DesktopRemoteAccess({ root, clientDirectory: root, session: { port: 9999, token: "a".repeat(64) },
      startupSupported: false, setStartOnLogin: () => {}, tailscale: fake.client });
    try {
      const initialized = host.initialize(); await starting;
      let settled = false;
      const stopped = (action === "stop" ? host.stop() : host.command({ kind: "disable" })).then(() => { settled = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(settled, false, "stopping waits for the outstanding automatic start");
      release(); await initialized; await stopped;
      assert.equal(host.status().running, false);
      assert.equal(host.status().enabled, action === "stop", "Quit retains opt-in; Disable removes it");
    } finally { release(); await host.stop(); await rm(root, { recursive: true, force: true }); }
  }
});
