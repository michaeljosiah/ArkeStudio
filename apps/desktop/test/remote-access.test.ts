import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DesktopRemoteAccess } from "../src/remote-access.js";
import { TailscaleServe, type TailscaleRun } from "../src/tailscale-serve.js";

const origin = "https://studio.example.ts.net";
function tailscale() {
  let config: Record<string, unknown> = {};
  const commands: string[][] = [];
  const execute: TailscaleRun = async args => {
    commands.push(args);
    if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: "studio.example.ts.net." },
      CurrentTailnet: { MagicDNSEnabled: true }, CertDomains: ["studio.example.ts.net"] });
    if (args[1] === "status") return JSON.stringify(config);
    if (args.includes("off")) { config = {}; return ""; }
    config = { TCP: { "443": { HTTPS: true } }, Web: { "studio.example.ts.net:443": { Handlers: { "/": { Proxy: args.at(-1) } } } } };
    return "";
  };
  return { client: new TailscaleServe(execute), commands, set: (value: Record<string, unknown>) => { config = value; } };
}
it("Serve refuses occupied ports and Funnel, and removes only Studio's exact mapping", async () => {
  const fake = tailscale();
  assert.equal(await fake.client.origin(), origin);
  fake.set({ TCP: { "443": { HTTPS: true } }, Web: { "studio.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } } } } });
  await assert.rejects(fake.client.enable(origin, 8793, false), /already in use/);
  await fake.client.disable(origin, 8793);
  assert.ok(!fake.commands.some(args => args.includes("off")));
  fake.set({ AllowFunnel: { "studio.example.ts.net:443": true } });
  await assert.rejects(fake.client.enable(origin, 8793, false), /Funnel/);
  fake.set({});
  assert.equal(await fake.client.enable(origin, 8793, false), true);
  assert.equal(await fake.client.enable(origin, 8793, true), false);
  await assert.rejects(fake.client.enable(origin, 8793, false), /already in use/);
  await fake.client.disable(origin, 8793);
  assert.deepEqual(fake.commands.at(-1), ["serve", "--https=443", "off"]);
  assert.ok(!fake.commands.some(args => args.includes("reset")));
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
    host = new DesktopRemoteAccess(options); await host.initialize();
    assert.equal(host.status().running, true); assert.equal(host.status().startOnLogin, true);
    assert.deepEqual(host.status().pending, []);
    await host.command({ kind: "disable" });
    assert.equal(host.status().running, false); assert.equal(host.status().enabled, false);
    assert.deepEqual(login, [true, false]);
    assert.equal(JSON.parse(await readFile(join(root, "remote/settings.json"), "utf8")).enabled, false);
    assert.ok(fake.commands.some(args => args.includes("off")));
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
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
