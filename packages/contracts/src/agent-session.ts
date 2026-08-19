import { skillFor, type Skill } from "./skills.js";

/**
 * What Studio knows about an authoring session, in terms no harness owns.
 *
 * Lifted out of the OpenCode adapter (SPEC-005 R-5, R-6, R-10, D5): every field here is
 * product policy — which world tool to expose, which model, which per-agent overrides the
 * user set, which skill family the session drafts for. Rendering it into a harness's own
 * grammar is the adapter's job, and each adapter does it differently; deciding it is not.
 */
export interface SessionConfigInput {
  /** The world-query MCP server URL (loopback), when a world is open. */
  worldQueryUrl?: string;
  /** Concrete model for authoring, e.g. "anthropic/claude-sonnet-5" or "ollama/llama3.3". */
  model?: string;
  /**
   * Per-agent overrides from Settings. A brief replaces what the agent is for; it can never
   * replace the confinement preamble or the tool denials the adapter applies — those are what
   * the accept gate assumes, and an agent talked out of them fails in ways that look like our
   * bugs.
   */
  agents?: Record<string, { model?: string; brief?: string }>;
  /**
   * The target model family for this session, which selects the authoring skill (SPEC-019 R-16).
   * Absent, or a family with no skill, means the agents draft under general guidance — a stated
   * fallback rather than a failure (R-20), stated by the caller that knows it happened.
   */
  skillFamily?: string;
}

/**
 * Which roster agents take which skill. An agent that answers rather than authors takes none:
 * a skill shapes what is drafted, and there is nothing drafted here to shape (R-17).
 */
const SKILLED_AGENTS: Record<string, Parameters<typeof skillFor>[0]> = {
  "scene-writer": "scene-drafting",
  "art-director": "storyboard",
};

/** The skill a given agent runs with in this session, or null. Exported for the record (R-19). */
export function skillForAgent(agentName: string, family: string | undefined): Skill | null {
  const purpose = SKILLED_AGENTS[agentName];
  return purpose === undefined ? null : skillFor(purpose, family);
}
