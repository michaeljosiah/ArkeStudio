import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator } from "./coordinator.js";
import { FsWorldProvider } from "./world/provider.js";

/**
 * Dev entry: run the coordinator standalone over a real on-disk app root (SPEC-002) so the
 * client dev server has the same provider the desktop app uses. The root lives in .dev/root
 * (gitignored) and is seeded from the fixture world when empty. Loopback only.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const fixturesRoot = join(repoRoot, "fixtures");
const devRoot = process.env["ARKE_STUDIO_ROOT"] ?? join(repoRoot, ".dev", "root");

const DEV_PORT = 8791;

async function seed(): Promise<void> {
  const worldsDir = join(devRoot, "worlds");
  await mkdir(worldsDir, { recursive: true });
  const existing = await readdir(worldsDir);
  if (existing.length === 0) {
    await cp(join(fixturesRoot, "worlds", "the-undersong"), join(worldsDir, "the-undersong"), {
      recursive: true,
    });
    await cp(join(fixturesRoot, "queue"), join(devRoot, "queue"), { recursive: true }).catch(() => {});
    await cp(join(fixturesRoot, "ledger.jsonl"), join(devRoot, "ledger.jsonl")).catch(() => {});
    console.log(`[arke-studio] seeded dev root from fixtures`);
  }
}

await seed();

const provider = new FsWorldProvider(devRoot);
await provider.ensureAppRoot();
if (provider.pathBudget.tight) {
  console.warn(`[arke-studio] path budget is tight at this root (${provider.pathBudget.worstCase} worst case)`);
}

const coordinator = new Coordinator({
  provider,
  adapter: null,
  changeLogPath: join(devRoot, "logs", "coordinator.jsonl"),
  appVersion: "0.1.0-dev",
  jobsSeedPath: join(devRoot, "queue", "jobs.jsonl"),
  ledgerSeedPath: join(devRoot, "ledger.jsonl"),
});

const { port } = await coordinator.start(DEV_PORT);
console.log(`[arke-studio] dev coordinator on ws://127.0.0.1:${port} (root: ${devRoot})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void coordinator.stop().then(() => process.exit(0));
  });
}
