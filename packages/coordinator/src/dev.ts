import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator } from "./coordinator.js";
import { MockWorldProvider } from "./world-provider.js";

/**
 * Dev entry: run the coordinator standalone against the fixture world so the client dev
 * server (`npm run dev`) has something honest to talk to outside Electron. Loopback only.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(here, "../../../fixtures");

const DEV_PORT = 8791;

const coordinator = new Coordinator({
  provider: new MockWorldProvider(fixturesRoot),
  adapter: null,
  changeLogPath: resolve(here, "../../../.dev/changes.jsonl"),
  appVersion: "0.1.0-dev",
  jobsSeedPath: resolve(fixturesRoot, "queue/jobs.jsonl"),
  ledgerSeedPath: resolve(fixturesRoot, "ledger.jsonl"),
});

const { port } = await coordinator.start(DEV_PORT);
console.log(`[arke-studio] dev coordinator on ws://127.0.0.1:${port} (fixtures: ${fixturesRoot})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void coordinator.stop().then(() => process.exit(0));
  });
}
