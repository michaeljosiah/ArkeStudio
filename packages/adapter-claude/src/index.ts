export {
  CLAUDE_MIN_VERSION,
  discoverClaudeCode,
  meetsClaudeFloor,
  type ClaudeDiscovery,
  type ClaudeDiscoveryOptions,
  type DiscoveredClaude,
} from "./discovery.js";
export {
  ConfinementCache,
  probeConfinement,
  type ConfinementVerdict,
  type ProbeTurnResult,
  type RunProbeTurn,
} from "./confinement-probe.js";
export {
  resolveClaudeHarness,
  type ClaudeAvailability,
  type ResolveClaudeOptions,
} from "./availability.js";
