import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentForPurpose,
  buildSessionConfig,
  discoverOpenCode,
  OpenCodeAdapter,
  ROSTER,
} from "@arke-studio/adapter-opencode";
import { ChildLedger } from "./child-ledger.js";
import { Coordinator } from "./coordinator.js";
import { ChildSupervisor, registerExitBackstop } from "./supervisor.js";
import { nodeSetupDeps } from "./setup/node-deps.js";
import { FsWorldProvider } from "./world/provider.js";
import { harnessTrace } from "./harness/trace.js";

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

// Children of a force-killed previous run (a dev-server restart runs no exit hooks) are
// reaped before anything new spawns; this run's children are recorded in the same ledger.
const ledger = new ChildLedger(join(devRoot, "run", "children.json"));
const swept = await ledger.reapStale();
if (swept.reaped.length > 0) {
  const named = swept.reaped.map((r) => `${r.id} (pid ${r.pid})`).join(", ");
  console.log(`[arke-studio] reaped ${swept.reaped.length} orphaned child process(es): ${named}`);
}

// Real authoring in dev when OpenCode is installed; honest degradation when it is not.
const discovered = discoverOpenCode();
const opencodeSupervisor = new ChildSupervisor(
  {
    id: "opencode",
    command: discovered?.command ?? null,
    args: ["serve", "--port", "{port}", "--hostname", "127.0.0.1"],
    healthPath: "/api/health",
    readyTimeoutMs: 30_000,
  },
  { ledger },
);
registerExitBackstop(opencodeSupervisor);
const adapter = discovered
  ? new OpenCodeAdapter({
        baseUrl: () => `http://127.0.0.1:${opencodeSupervisor.port ?? 0}`,
        // The adapter's own account of itself — connects, stalls, resyncs, dispatches. When a
        // chat sticks, this file answers "what did the app hear, and when" without a debugger.
        onTrace: harnessTrace(devRoot),
      })
  : null;
console.log(
  discovered
    ? `[arke-studio] OpenCode: ${discovered.source} (${discovered.version ?? "unknown version"})`
    : "[arke-studio] OpenCode: not found — authoring disabled",
);

const coordinator = new Coordinator({
  provider,
  adapter,
  changeLogPath: join(devRoot, "logs", "coordinator.jsonl"),
  appVersion: "0.1.0-dev",
  jobsSeedPath: join(devRoot, "queue", "jobs.jsonl"),
  ledgerSeedPath: join(devRoot, "ledger.jsonl"),
  appRoot: devRoot,
  setup: nodeSetupDeps(),
  authoring: { buildConfig: buildSessionConfig, agentForPurpose, roster: ROSTER },
});
coordinator.superviseAs("harness", opencodeSupervisor);

const { port } = await coordinator.start(DEV_PORT);
console.log(`[arke-studio] dev coordinator on ws://127.0.0.1:${port} (root: ${devRoot})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void coordinator.stop().then(() => process.exit(0));
  });
}
