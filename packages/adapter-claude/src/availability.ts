import {
  CLAUDE_MIN_VERSION,
  discoverClaudeCode,
  type ClaudeDiscoveryOptions,
  type DiscoveredClaude,
} from "./discovery.js";
import { ConfinementCache, type RunProbeTurn } from "./confinement-probe.js";

/**
 * The one question a host asks about the bring-your-own harness: can we offer it, and if not,
 * what do we tell the user (SPEC-005 R-1, R-4)?
 *
 * Three gates in order, cheapest first: installed at all, clears the version floor, honours the
 * tool gate. Only the third is authoritative — the floor exists to skip a pointless probe
 * against a build already known too old, not to decide anything.
 */

export type ClaudeAvailability =
  | {
      available: true;
      command: string;
      source: DiscoveredClaude["source"];
      version: string | null;
      /** Which credential answered — see {@link credentialSummary}. */
      apiKeySource: string | null;
    }
  /**
   * `reason` is written to be shown, not logged. "Not installed" is a normal state for a
   * bring-your-own harness, not a failure — the caller decides whether it is even worth
   * surfacing.
   */
  | { available: false; reason: string; kind: "absent" | "too-old" | "unverified" };

export interface ResolveClaudeOptions {
  discovery?: ClaudeDiscoveryOptions;
  /** Shared across calls so a verified binary is probed once, not once per session. */
  cache: ConfinementCache;
  runTurn: RunProbeTurn;
}

export async function resolveClaudeHarness(opts: ResolveClaudeOptions): Promise<ClaudeAvailability> {
  const { found, rejected } = await discoverClaudeCode(opts.discovery ?? {});

  if (!found) {
    if (rejected) {
      const min = opts.discovery?.minVersion ?? CLAUDE_MIN_VERSION;
      return {
        available: false,
        kind: "too-old",
        // Naming both numbers is the whole point: "not installed" would be a lie the user
        // cannot act on, and this one tells them exactly what to do about it.
        reason: `Claude Code ${rejected.version} found, need ${min} or newer — older builds do not enforce Arke Studio's tool limits`,
      };
    }
    return { available: false, kind: "absent", reason: "Claude Code is not installed" };
  }

  const verdict = await opts.cache.ensure(found.command, found.version, opts.runTurn);
  if (!verdict.ok) {
    return {
      available: false,
      kind: "unverified",
      reason: `Claude Code ${verdict.version ?? found.version ?? "(unknown version)"} could not be verified — ${verdict.reason}`,
    };
  }

  // The version the turn reported wins over the one --version printed: it is what actually ran.
  return {
    available: true,
    command: found.command,
    source: found.source,
    version: verdict.version ?? found.version,
    apiKeySource: verdict.apiKeySource,
  };
}
