import { join } from "node:path";
import { agentForPurpose, effectiveHarnessEngine, ROSTER, skillFor, type HarnessAdapter } from "@arke-studio/contracts";
import { createProviderClients, SHIPPED_MANIFEST } from "@arke-studio/providers";
import { createStudioHost } from "./application/studio-host.js";
import { AppSettingsFile } from "./app-settings.js";
import { ChildLedger } from "./child-ledger.js";
import type { Cipher } from "./credentials/store.js";
import { assembleHarness, type AssembledHarness } from "./harness/v2-launch.js";
import { harnessTrace } from "./harness/trace.js";
import { ProviderCallStore } from "./providers/call-store.js";
import { SecretRegistry } from "./redact.js";
import { nodeSetupDeps } from "./setup/node-deps.js";
import { registerExitBackstop } from "./supervisor.js";
import type { TransportAuth } from "./transport.js";
import { FsWorldProvider } from "./world/provider.js";

export interface NodeStudioHostOptions {
  appRoot: string;
  appVersion: string;
  transportAuth?: TransportAuth;
  /** Omit to assemble the configured harness; null explicitly disables AI. */
  adapter?: HarnessAdapter | null;
  /** A real host secret-store cipher. Standalone startup never invents an at-rest key. */
  cipher?: Cipher;
}

const unavailableCipher: Cipher = {
  isAvailable: () => false,
  encryptString: () => { throw new Error("This server has no secure credential store configured."); },
  decryptString: () => { throw new Error("This server has no secure credential store configured."); },
};

/** Node composition without Electron, development fixtures or credential-file resets. */
export async function createNodeStudioHost(options: NodeStudioHostOptions) {
  const provider = new FsWorldProvider(options.appRoot);
  let wiring: AssembledHarness | undefined;
  try {
    await provider.ensureAppRoot();
    const ledger = new ChildLedger(join(options.appRoot, "run", "children.json"));
    await ledger.reapStale();
    const settings = await new AppSettingsFile(join(options.appRoot, "settings.json")).load();
    const chosen = effectiveHarnessEngine(settings.harness.engine, process.env["ARKE_HARNESS"]);
    if (options.adapter === undefined) {
      wiring = await assembleHarness({
        appRoot: options.appRoot, engine: chosen, deps: { ledger },
        preferV1: process.env["ARKE_OPENCODE_GENERATION"] === "v1",
        claude: { enabled: chosen === "claude", ...(settings.harness.claudePath ? { configuredPath: settings.harness.claudePath } : {}) },
        codex: { enabled: chosen === "codex", ...(settings.harness.codexPath ? { configuredPath: settings.harness.codexPath } : {}) },
        onTrace: harnessTrace(options.appRoot),
      });
    }
    const secrets = new SecretRegistry();
    const calls = new ProviderCallStore(join(options.appRoot, "provider-calls", "calls.jsonl"), secrets);
    const clients = createProviderClients({ fetch: (url, init) => fetch(url, init), capture: calls });
    const host = createStudioHost({
      provider, appRoot: options.appRoot, appVersion: options.appVersion,
      adapter: options.adapter === undefined ? wiring!.adapter : options.adapter,
      transportAuth: options.transportAuth,
      cipher: options.cipher ?? unavailableCipher, credentialsFileName: "credentials.server.dat",
      changeLogPath: join(options.appRoot, "logs", "coordinator.jsonl"),
      jobsSeedPath: join(options.appRoot, "queue", "jobs.jsonl"), ledgerSeedPath: join(options.appRoot, "ledger.jsonl"),
      secretRegistry: secrets, providerCalls: calls, validators: clients, dispatchClients: clients, manifest: SHIPPED_MANIFEST,
      setup: nodeSetupDeps(), authoring: { agentForPurpose, roster: ROSTER, skillFor },
      harnessLaunchEngine: chosen, relaunchHarness: wiring?.relaunchHarness,
      ...(wiring?.harnessInfo ? { harnessInfo: wiring.harnessInfo } : {}),
      harnessUnavailableReason: wiring?.unavailableReason ?? (options.adapter === null ? "AI is disabled for this server." : undefined),
    });
    if (wiring?.supervisor) {
      host.coordinator.superviseAs("harness", wiring.supervisor);
      registerExitBackstop(wiring.supervisor);
    }
    return host;
  } catch (error) {
    await Promise.allSettled([provider.close(), wiring?.supervisor?.stop(), wiring?.adapter?.dispose?.()]);
    throw error;
  }
}
