import type { ClientState } from "@arke-studio/contracts";
import type { AppLog } from "./app-log.js";
import { redactDeep, type SecretRegistry } from "./redact.js";

/**
 * The diagnostics bundle (SPEC-008 R-6): app state a support thread can read — versions,
 * health, provider *status*, routing, runtime figures, the redacted log tail — and nothing
 * else. No key material (everything passes the redaction boundary on the way out) and no
 * world content: not a sheet, not a canon line, not a path inside a world.
 */
export async function buildDiagnosticsBundle(
  state: ClientState,
  log: AppLog | null,
  registry: SecretRegistry,
): Promise<Record<string, unknown>> {
  const bundle = {
    generatedAt: new Date().toISOString(),
    app: {
      version: state.app.version,
      health: state.app.health,
      // Status only — configured/validation/probes; the schema itself carries no key (R-6).
      providers: state.app.providers,
      routing: state.app.routing,
      spend: state.app.spend,
      runtime: state.app.runtime,
      voiceRuntime: state.app.voiceRuntime,
      drift: state.app.drift,
      manifestVersion: state.app.manifest?.manifestVersion ?? null,
      jobCount: state.app.jobs.length,
      ledgerEntries: state.app.ledger.length,
    },
    // Deliberately absent: worlds, world names, sheets, canon, productions, file paths.
    recentLog: log ? await log.tail(100) : [],
  };
  return redactDeep(bundle, registry) as Record<string, unknown>;
}
