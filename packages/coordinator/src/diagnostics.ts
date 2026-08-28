import type { ClientState } from "@arke-studio/contracts";
import type { AppLog } from "./app-log.js";
import { redactDeep, scrubAbsolutePaths, type SecretRegistry } from "./redact.js";

/**
 * The diagnostics bundle (SPEC-008 R-6): app state a support thread can read — versions,
 * health, provider *status*, routing, runtime figures, the redacted log tail — and nothing
 * else. No key material (everything passes the redaction boundary on the way out) and no
 * world content: not a sheet, not a canon line, not a path inside a world.
 *
 * Built from an enumerated field set (SPEC-032 R-31): a field reaches the export because it
 * was named below, never because it was not excluded. Adding one is the reviewed act. That is
 * the property the paste-safety guarantee actually rests on — the redaction boundary is a
 * seen-secrets denylist plus a field-name heuristic, and a secret it never saw, in a field not
 * named like a credential, passes straight through it. Redaction is the second line, for the
 * one thing enumeration cannot vouch for: free text quoted from another subsystem (R-32).
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
  // Secrets and credential-shaped fields first, then absolute paths (SPEC-032 R-28 — a new
  // rule this bundle used to satisfy by construction alone): subsystem text in the log tail
  // routinely embeds the install's own paths, and every one carries the account name.
  return scrubPathsDeep(redactDeep(bundle, registry)) as Record<string, unknown>;
}

/** Every string in the export passes the path rule, wherever a future field puts one. */
function scrubPathsDeep(value: unknown): unknown {
  if (typeof value === "string") return scrubAbsolutePaths(value);
  if (Array.isArray(value)) return value.map(scrubPathsDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubPathsDeep(entry);
    }
    return out;
  }
  return value;
}
