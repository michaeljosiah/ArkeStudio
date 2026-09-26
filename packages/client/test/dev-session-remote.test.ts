import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createServer } from "vite";
import { devSessionPlugin, sessionEndpoints, widenPolicy } from "../dev-session-plugin.js";

const remote = { VITE_ARKE_WS: "wss://studio.tail1234.ts.net:8443", ARKE_DEV_LOCAL_WS: "ws://127.0.0.1:8791",
  ARKE_DEV_ORIGIN: "https://studio.tail1234.ts.net" };
const clientRoot = fileURLToPath(new URL("../", import.meta.url));

const policy = (page: string): Record<string, string[]> => Object.fromEntries(/Content-Security-Policy"\s+content="([^"]*)"/.exec(page)![1]!.split(";")
  .map(part => part.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));

/** The plugin's real hooks, driven by a Vite server that never listens. */
async function servedWith(env: Record<string, string | undefined>) {
  const names = ["VITE_ARKE_WS", "ARKE_DEV_LOCAL_WS", "ARKE_DEV_ORIGIN"] as const;
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) { if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name]; }
  try {
    const server = await createServer({ configFile: false, root: clientRoot, logLevel: "silent", plugins: [devSessionPlugin()],
      server: { middlewareMode: true, ws: false } });
    try {
      const html = await server.transformIndexHtml("/", await readFile(resolve(clientRoot, "index.html"), "utf8"));
      const { allow, deny } = server.config.server.fs;
      return { allowedHosts: server.config.server.allowedHosts, allow, deny, policy: policy(html) };
    } finally { await server.close(); }
  } finally {
    for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; }
  }
}

it("a loopback coordinator is its own local endpoint, as before", () => {
  const { browser, local, origin, proxied } = sessionEndpoints({});
  assert.equal(browser.href, "ws://127.0.0.1:8791/");
  assert.equal(local, browser);
  assert.equal(origin, undefined);
  assert.equal(proxied, false);
  assert.equal(sessionEndpoints({ ARKE_DEV_ORIGIN: "http://localhost:5174/" }).origin, "http://localhost:5174");
});

it("a proxied coordinator reads the loopback handoff and probes through the proxy", () => {
  const { browser, local, origin, proxied } = sessionEndpoints(remote);
  assert.equal(browser.host, "studio.tail1234.ts.net:8443");
  assert.equal(local.port, "8791");
  assert.equal(origin, "https://studio.tail1234.ts.net");
  assert.equal(proxied, true);
  // A TLS proxy on this machine is proxied too; it must not read a handoff for the proxy's port.
  assert.equal(sessionEndpoints({ ...remote, VITE_ARKE_WS: "wss://localhost:8443" }).local.port, "8791");
});

it("nothing crosses the network in the clear and every proxied setup names both ends", () => {
  assert.throws(() => sessionEndpoints({ ...remote, VITE_ARKE_WS: "ws://100.64.0.1:8791" }), /wss:/);
  assert.throws(() => sessionEndpoints({ ...remote, VITE_ARKE_WS: "ws://100.64.0.1:8791", ARKE_DEV_LOCAL_WS: undefined }), /wss:/);
  assert.throws(() => sessionEndpoints({ ...remote, ARKE_DEV_LOCAL_WS: undefined }), /ARKE_DEV_LOCAL_WS/);
  assert.throws(() => sessionEndpoints({ ...remote, ARKE_DEV_LOCAL_WS: "ws://100.64.0.1:8791" }), /loopback/);
  assert.throws(() => sessionEndpoints({ ...remote, ARKE_DEV_LOCAL_WS: "ws://127.0.0.1" }), /with its port/);
  assert.throws(() => sessionEndpoints({ ...remote, ARKE_DEV_ORIGIN: undefined }), /ARKE_DEV_ORIGIN/);
  assert.throws(() => sessionEndpoints({ ...remote, ARKE_DEV_ORIGIN: "http://studio.tail1234.ts.net" }), /https:/);
  // A remote page with a loopback coordinator would verify here and fail on the other device.
  assert.throws(() => sessionEndpoints({ ARKE_DEV_ORIGIN: remote.ARKE_DEV_ORIGIN }), /proxied/);
  assert.throws(() => sessionEndpoints({ ARKE_DEV_ORIGIN: "studio.tail1234.ts.net" }), /Invalid URL/);
});

it("an accepted proxied session widens the host allowance and the page policy for that server only", async () => {
  const served = await servedWith(remote);
  assert.deepEqual(served.allowedHosts, ["studio.tail1234.ts.net"]);
  assert.ok(served.deny.includes("**/.dev/**"), "the handoff stays unservable");
  const repo = resolve(clientRoot, "../..");
  assert.deepEqual(served.allow.map(path => path.slice(repo.length + 1).replace(/\\/g, "/")).sort(),
    ["node_modules", "packages/client", "packages/contracts"], "a tailnet device sees what the page is built from, not the checkout");
  assert.ok(served.policy["connect-src"]!.includes("wss://studio.tail1234.ts.net:8443"));
  assert.ok(served.policy["media-src"]!.includes("https://studio.tail1234.ts.net:8443"));
});

it("a local or refused setup changes neither the host allowance nor the page policy, and does not stop Vite", async () => {
  const shipped = policy(await readFile(resolve(clientRoot, "index.html"), "utf8"));
  for (const env of [{}, { ...remote, VITE_ARKE_WS: "ws://100.64.0.1:8791" }, { ...remote, ARKE_DEV_ORIGIN: "http://studio.tail1234.ts.net" },
    { ARKE_DEV_ORIGIN: remote.ARKE_DEV_ORIGIN }, { ARKE_DEV_ORIGIN: "not a url" }]) {
    const served = await servedWith(env);
    assert.deepEqual(served.allowedHosts, [], JSON.stringify(env));
    assert.equal(served.allow.includes(resolve(clientRoot, "../contracts")), false, "the loopback workspace allowance is unchanged");
    assert.deepEqual(served.policy, shipped, JSON.stringify(env));
  }
});

it("the widened policy adds the coordinator's reach and nothing else", async () => {
  const html = await readFile(resolve(clientRoot, "index.html"), "utf8");
  const shipped = policy(html);
  const widened = policy(widenPolicy(html, sessionEndpoints(remote).browser));
  assert.equal(JSON.stringify(shipped).includes("ts.net"), false);
  for (const name of ["connect-src", "img-src", "media-src", "object-src", "frame-src"]) {
    assert.deepEqual(widened[name]!.filter(source => !shipped[name]!.includes(source)).filter(source => !source.startsWith("wss:")),
      ["https://studio.tail1234.ts.net:8443"], name);
  }
  assert.deepEqual(widened["script-src"], shipped["script-src"]);
  assert.deepEqual(widened["default-src"], shipped["default-src"]);
});
