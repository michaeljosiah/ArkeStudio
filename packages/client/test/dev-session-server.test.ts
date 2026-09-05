import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createLogger, createServer } from "vite";
import { devSessionPlugin } from "../dev-session-plugin.js";

it("Vite prints a fragment sign-in link but never serves the capability in HTML or through /@fs", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const port = randomInt(10000, 65535);
  const token = randomBytes(32).toString("hex");
  const file = resolve(root, ".dev", `transport-${port}.json`);
  const priorEndpoint = process.env.VITE_ARKE_WS;
  await mkdir(resolve(root, ".dev"), { recursive: true });
  await writeFile(file, JSON.stringify({ port, token }), { flag: "wx", mode: 0o600 });
  process.env.VITE_ARKE_WS = `ws://127.0.0.1:${port}`;
  const lines: string[] = [];
  const logger = createLogger("silent");
  logger.info = line => { lines.push(line); };
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
    assert.ok(lines.some(line => line.includes("/#/?arke-session=" + token)), "only the terminal receives the sign-in link");
  } finally {
    await server.close();
    await unlink(file);
    if (priorEndpoint === undefined) delete process.env.VITE_ARKE_WS; else process.env.VITE_ARKE_WS = priorEndpoint;
  }
});
