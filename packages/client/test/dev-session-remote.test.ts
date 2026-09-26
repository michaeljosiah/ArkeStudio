import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { resolveConfig } from "vite";
import { devSessionPlugin, sessionEndpoints, widenPolicy } from "../dev-session-plugin.js";

const remote = { VITE_ARKE_WS: "wss://studio.tail1234.ts.net:8443", ARKE_DEV_LOCAL_WS: "ws://127.0.0.1:8791",
  ARKE_DEV_ORIGIN: "https://studio.tail1234.ts.net" };

it("a loopback coordinator is its own local endpoint, as before", () => {
  const { browser, local, origin } = sessionEndpoints({});
  assert.equal(browser.href, "ws://127.0.0.1:8791/");
  assert.equal(local, browser);
  assert.equal(origin, undefined);
});

it("a proxied coordinator reads the loopback handoff and probes through the proxy", () => {
  const { browser, local, origin } = sessionEndpoints(remote);
  assert.equal(browser.host, "studio.tail1234.ts.net:8443");
  assert.equal(local.port, "8791");
  assert.equal(origin, "https://studio.tail1234.ts.net");
});

it("a remote coordinator is refused unless it is TLS, names its loopback target and its browser origin", () => {
  assert.throws(() => sessionEndpoints({ ...remote, VITE_ARKE_WS: "ws://100.64.0.1:8791" }), /wss:/);
  assert.throws(() => sessionEndpoints({ ...remote, ARKE_DEV_LOCAL_WS: undefined }), /ARKE_DEV_LOCAL_WS/);
  assert.throws(() => sessionEndpoints({ ...remote, ARKE_DEV_LOCAL_WS: "ws://100.64.0.1:8791" }), /loopback/);
  assert.throws(() => sessionEndpoints({ ...remote, ARKE_DEV_ORIGIN: undefined }), /ARKE_DEV_ORIGIN/);
});

it("Vite accepts the declared remote origin's host and no other", async () => {
  const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const prior = process.env.ARKE_DEV_ORIGIN;
  try {
    delete process.env.ARKE_DEV_ORIGIN;
    const local = await resolveConfig({ configFile: false, root, plugins: [devSessionPlugin()] }, "serve");
    assert.deepEqual(local.server.allowedHosts, []);
    process.env.ARKE_DEV_ORIGIN = remote.ARKE_DEV_ORIGIN;
    const proxied = await resolveConfig({ configFile: false, root, plugins: [devSessionPlugin()] }, "serve");
    assert.deepEqual(proxied.server.allowedHosts, ["studio.tail1234.ts.net"]);
    assert.ok(proxied.server.fs.deny.includes("**/.dev/**"), "the handoff stays unservable");
  } finally {
    if (prior === undefined) delete process.env.ARKE_DEV_ORIGIN; else process.env.ARKE_DEV_ORIGIN = prior;
  }
});

it("the dev page may reach the proxied coordinator; the shipped page still reaches only loopback", async () => {
  const html = await readFile(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  const policy = (page: string): Record<string, string[]> => Object.fromEntries(/Content-Security-Policy"\s+content="([^"]*)"/.exec(page)![1]!.split(";")
    .map(part => part.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));
  const shipped = policy(html);
  const widened = policy(widenPolicy(html, sessionEndpoints(remote).browser));
  assert.equal(JSON.stringify(shipped).includes("ts.net"), false);
  assert.ok(widened["connect-src"]!.includes("wss://studio.tail1234.ts.net:8443"));
  for (const name of ["connect-src", "img-src", "media-src", "object-src", "frame-src"]) {
    assert.deepEqual(widened[name]!.filter(source => !shipped[name]!.includes(source)).filter(source => !source.startsWith("wss:")),
      ["https://studio.tail1234.ts.net:8443"], name);
  }
  assert.deepEqual(widened["script-src"], shipped["script-src"], "nothing but the coordinator's reach changes");
  assert.deepEqual(widened["default-src"], shipped["default-src"]);
});
