import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentForPurpose, skillFor, ROSTER } from "@arke-studio/contracts";
import { createProviderClients, SHIPPED_MANIFEST } from "@arke-studio/providers";
import { KOKORO_PRESETS, localCandidates } from "@arke-studio/voice";
import { ChildLedger } from "./child-ledger.js";
import { Coordinator } from "./coordinator.js";
import { devCipher } from "./credentials/dev-cipher.js";
import { ProviderCallStore } from "./providers/call-store.js";
import { SecretRegistry } from "./redact.js";
import { registerExitBackstop } from "./supervisor.js";
import { nodeSetupDeps } from "./setup/node-deps.js";
import { FsWorldProvider } from "./world/provider.js";
import { harnessTrace } from "./harness/trace.js";
import { assembleHarness } from "./harness/v2-launch.js";

/**
 * Dev entry: run the coordinator standalone over a real on-disk app root (SPEC-002) so the
 * client dev server has the same provider the desktop app uses. The root lives in .dev/root
 * (gitignored) and is seeded from the fixture world when empty. Loopback only.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const fixturesRoot = join(repoRoot, "fixtures");
const devRoot = process.env["ARKE_STUDIO_ROOT"] ?? join(repoRoot, ".dev", "root");

// 8791 unless something already holds it — a second checkout, or another agent's dev
// coordinator. The launcher passes the port it assigned through PORT, and the client reaches
// a moved coordinator through VITE_ARKE_WS, which its store already reads. An empty PORT is
// not a request for port 0 — Number("") is 0, and binding there leaves the client with
// nothing to connect to.
const requestedPort = process.env["PORT"]?.trim();
const parsedPort = requestedPort ? Number(requestedPort) : Number.NaN;
const DEV_PORT = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 8791;

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

// Real authoring in dev when either OpenCode generation is installed; honest degradation
// when neither is. One seam builds the whole launch (issue 327 §3–§4) — v2 preferred, v1
// the escape hatch — so dev and desktop cannot drift.
const wiring = await assembleHarness({
  appRoot: devRoot,
  deps: { ledger },
  preferV1: process.env["ARKE_OPENCODE_GENERATION"] === "v1",
  claude: {
    enabled: process.env["ARKE_HARNESS"] === "claude",
    ...(process.env["ARKE_CLAUDE_CMD"] ? { configuredPath: process.env["ARKE_CLAUDE_CMD"] } : {}),
  },
  onTrace: harnessTrace(devRoot),
});
const opencodeSupervisor = wiring.supervisor;
const adapter = wiring.adapter;
registerExitBackstop(opencodeSupervisor);
for (const line of wiring.logLines) console.log(`[arke-studio] ${line}`);

// Generation works in dev (issue #227). Three things were missing, and any one of them alone
// left the stack unable to produce a single image: a cipher, so a key can be stored at all; the
// manifest, so a model exists to choose; and the clients, so a chosen model can be dispatched.
// The first was the silent one — Settings accepted keys and dropped them, with no error, no
// event and no log line — and it is why end-to-end work had to happen against the packaged
// build. The other two would have made a working key look broken instead.
//
// The dev cipher's key lives in this process and nowhere else, so last run's ciphertext is
// unreadable now. Clearing it is the honest move: left in place, Settings would show a stored
// key that no dispatch could ever decrypt. The file is dev's own — the desktop writes
// credentials.dat — so this deletes nothing a real app root owns, even when ARKE_STUDIO_ROOT
// points at one.
const DEV_CREDENTIALS = "credentials.dev.dat";
await rm(join(devRoot, DEV_CREDENTIALS), { force: true });

// The same store the desktop wires, for the same reason: when a provider call fails, its
// request and response are on disk to read rather than gone (SPEC-008 R-7). Dev is where that
// question gets asked most.
const providerSecrets = new SecretRegistry();
const providerCalls = new ProviderCallStore(join(devRoot, "provider-calls", "calls.jsonl"), providerSecrets);
// No Higgsfield runner: its credential lives in a CLI, and discovering one here would make dev
// depend on what happens to be installed. Every Higgsfield call then fails with the remedy.
const providerClients = createProviderClients({ fetch: (url, init) => fetch(url, init), capture: providerCalls });

const coordinator = new Coordinator({
  provider,
  adapter,
  cipher: devCipher(),
  credentialsFileName: DEV_CREDENTIALS,
  secretRegistry: providerSecrets,
  providerCalls,
  validators: providerClients,
  dispatchClients: providerClients,
  manifest: SHIPPED_MANIFEST,
  changeLogPath: join(devRoot, "logs", "coordinator.jsonl"),
  appVersion: "0.1.0-dev",
  jobsSeedPath: join(devRoot, "queue", "jobs.jsonl"),
  ledgerSeedPath: join(devRoot, "ledger.jsonl"),
  appRoot: devRoot,
  // What the packaged build reads out of its resources, dev reads out of the repo — so
  // Settings · Sample world is a working surface here and not a dead one (SPEC-016 R-6).
  sampleWorldPath: join(fixturesRoot, "worlds", "the-undersong"),
  setup: nodeSetupDeps(),
  authoring: { agentForPurpose, roster: ROSTER, skillFor },
  ...(wiring.harnessInfo ? { harnessInfo: wiring.harnessInfo } : {}),
  relaunchHarness: wiring.relaunchHarness,
  // The dev coordinator carries the app's own preset speakers so the voice picker has a
  // catalogue to show without a sidecar or a provider key. No cloud sources: unkeyed
  // providers contribute nothing anyway, and dev should never reach for one.
  voice: { sidecar: null, localPresets: localCandidates(KOKORO_PRESETS), cloudSources: [] },
});
coordinator.superviseAs("harness", opencodeSupervisor);

const { port } = await coordinator.start(DEV_PORT);
console.log(`[arke-studio] dev coordinator on ws://127.0.0.1:${port} (root: ${devRoot})`);
// Said out loud, because the packaged app behaves differently here and a key that vanished
// without explanation is the failure this whole seam exists to prevent.
console.log("[arke-studio] provider keys: stored for this run only — the dev cipher's key is never written to disk");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void coordinator.stop().then(() => process.exit(0));
  });
}
