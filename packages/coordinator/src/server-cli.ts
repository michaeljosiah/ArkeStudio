import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeStudioHost } from "./node-studio-host.js";
import { writeServerSession } from "./server-session.js";

const { values } = parseArgs({ options: {
  root: { type: "string" }, port: { type: "string", default: "8791" },
  origin: { type: "string", multiple: true }, "no-harness": { type: "boolean", default: false },
  help: { type: "boolean", short: "h" },
} });

if (values.help) {
  console.log("npm run server -- --root <app-folder> [--port 8791] [--origin http://localhost:5173] [--no-harness]");
} else {
  if (!values.root) throw new Error("--root is required; standalone startup never selects or seeds a development root.");
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port!) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid server port.");
  const origins = (values.origin ?? ["http://localhost:5173", "http://127.0.0.1:5173"]).map(value => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin !== value) {
      throw new Error("--origin must be an exact HTTP(S) origin.");
    }
    return url.origin;
  });
  const { randomBytes } = await import("node:crypto");
  const creating = createNodeStudioHost({ appRoot: resolve(values.root), appVersion: "standalone",
    transportAuth: { token: randomBytes(32).toString("hex"), allowedOrigins: origins },
    ...(values["no-harness"] ? { adapter: null } : {}) });
  let stopRequested = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopRequested = true;
    return stopping ??= (async () => { await (await creating).server.stop(); })()
      .catch(error => { stopping = undefined; throw error; });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    void stop().then(() => process.exit(0), () => { console.error("Studio could not finish saving during shutdown."); process.exitCode = 1; });
  });
  try {
    const host = await creating;
    if (stopRequested) { await stop(); } else {
      const session = await host.server.start(port);
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      const path = join(repoRoot, ".dev", "transport-" + session.port + ".json");
      await writeServerSession(path, session);
      console.log("Studio server: ws://127.0.0.1:" + session.port);
      if (session.port !== 8791) console.log("Set VITE_ARKE_WS=ws://127.0.0.1:" + session.port + " in the frontend terminal.");
      console.log("Start the browser frontend with npm run dev; its terminal prints the private session link.");
      console.log("Secure provider-key storage requires a host-supplied cipher. Existing credential files were not changed.");
    }
  } catch (error) {
    await stop();
    throw error;
  }
}
