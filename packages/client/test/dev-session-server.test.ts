import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createLogger, createServer } from "vite";
import { devSessionPlugin } from "../dev-session-plugin.js";

it("Vite prints a fragment sign-in link but never serves the capability in HTML or through /@fs", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const token = randomBytes(32).toString("hex");
  const host = createHttpServer((req, res) => {
    assert.equal(req.method, "HEAD");
    assert.equal(req.url, "/session");
    if (req.headers.authorization === "Bearer " + token) res.writeHead(204, { "X-Arke-Session": "authenticated" }).end();
    else res.writeHead(404).end(); // An unrelated service's generic 404 is not proof of authentication.
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const bound = host.address();
  assert.ok(bound && typeof bound !== "string");
  const port = bound.port;
  const file = resolve(root, ".dev", `transport-${port}.json`);
  const priorEndpoint = process.env.VITE_ARKE_WS;
  await mkdir(resolve(root, ".dev"), { recursive: true });
  await writeFile(file, JSON.stringify({ port, token }), { flag: "wx", mode: 0o600 });
  process.env.VITE_ARKE_WS = `ws://127.0.0.1:${port}`;
  const lines: string[] = [];
  const warnings: string[] = [];
  const logger = createLogger("silent");
  // Vite also reports occupied development ports here; those are not capability links.
  logger.info = line => { if (line.includes("arke-session=")) lines.push(line); };
  logger.warn = line => { warnings.push(line); };
  const server = await createServer({ configFile: false, root: resolve(root, "packages/client"), plugins: [devSessionPlugin()], customLogger: logger, server: { host: "127.0.0.1", port: 0, open: false, preTransformRequests: false } });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const html = await (await fetch(origin)).text();
    assert.equal(html.includes(token), false);
    for (const suffix of ["", "?raw", "?import"]) {
      const response = await fetch(`${origin}/@fs/${file.replace(/\\/g, "/")}${suffix}`);
      assert.equal(response.status, 403);
      assert.equal((await response.text()).includes(token), false);
    }
    for (let attempt = 0; attempt < 100 && !lines.length && !warnings.length; attempt++) await delay(20);
    assert.ok(lines.some(line => line.includes("/#/?arke-session=" + token)), "only the terminal receives the sign-in link");
    await server.close();
    lines.length = 0;
    await writeFile(file, JSON.stringify({ port, token: randomBytes(32).toString("hex") }));
    const stale = await createServer({ configFile: false, root: resolve(root, "packages/client"), plugins: [devSessionPlugin()], customLogger: logger,
      server: { host: "127.0.0.1", port: 0, open: false, preTransformRequests: false } });
    try {
      await stale.listen();
      for (let attempt = 0; attempt < 100 && !lines.length && !warnings.length; attempt++) await delay(20);
      assert.equal(lines.length, 0, "a rejected handoff is never printed as a working link");
      assert.ok(warnings.some(line => line.includes("Could not verify the Arke session")));
    } finally { await stale.close(); }
  } finally {
    await server.close();
    host.closeAllConnections();
    await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve()));
    await unlink(file);
    if (priorEndpoint === undefined) delete process.env.VITE_ARKE_WS; else process.env.VITE_ARKE_WS = priorEndpoint;
  }
});
