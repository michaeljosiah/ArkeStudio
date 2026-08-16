import { promptFor, ROSTER } from "./roster.js";
import { skillFor, type Skill } from "./skills.js";

/**
 * Session configuration written by Studio (SPEC-005 R-5, R-6, R-10, D5).
 *
 * Studio owns the harness's configuration: the agent roster, the tool denials, and the MCP
 * registration for the world-query tool are written as `opencode.json` into the session's
 * working directory at session start. Credentials NEVER appear here — they reach the process
 * by environment variable at spawn (D5), and this module builds that env map.
 */

/** Tools denied in authoring sessions — risk reduction, not a boundary (R-10, D10). */
const DENIED_TOOLS: Record<string, boolean> = {
  bash: false,
  webfetch: false,
  websearch: false,
};

/**
 * Additionally denied to an agent that answers rather than authors (#70 §8.1).
 *
 * The authoring agents edit inside a proposal directory, which is the whole point of giving them
 * one. World Chat has no proposal directory and writes nothing: its propositions become proposals
 * at wrap-up, and only the accept gate touches the world. An agent that could edit would have a
 * path into the world that bypasses the gate entirely — so the file tools are off, not merely
 * unused.
 */
const READ_ONLY_TOOLS: Record<string, boolean> = {
  ...DENIED_TOOLS,
  edit: false,
  write: false,
  patch: false,
  // No delegating either. A read-only agent answers in its own turn; handing the question to a
  // subagent was observed to spend thirty seconds of a live turn's budget producing nothing the
  // validator could accept, and a child session escapes the per-prompt agent pinning below.
  task: false,
};

const READ_ONLY_PERMISSION: Record<string, string> = {
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  todowrite: "allow",
  todoread: "allow",
  "arke-world*": "allow",
  "arke-world_*": "allow",
  edit: "deny",
  write: "deny",
  patch: "deny",
  task: "deny",
  bash: "deny",
  webfetch: "deny",
  websearch: "deny",
};

export interface SessionConfigInput {
  /** The world-query MCP server URL (loopback), when a world is open. */
  worldQueryUrl?: string;
  /** Concrete model for authoring, e.g. "anthropic/claude-sonnet-5" or "ollama/llama3.3". */
  model?: string;
  /**
   * Per-agent overrides from Settings. A brief replaces what the agent is for; it can never
   * replace the confinement preamble or the tool denials below — those are what the accept
   * gate assumes, and an agent talked out of them fails in ways that look like our bugs.
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

/** The opencode.json object written into a session's working directory. */
export function buildSessionConfig(input: SessionConfigInput): Record<string, unknown> {
  const agent: Record<string, unknown> = {};
  for (const member of ROSTER) {
    const override = input.agents?.[member.name];
    // The skill comes from the shipped registry, never from the Settings override: a brief
    // replaces what the agent is for, and craft guidance the output quality depends on is not
    // something to lose by editing an unrelated field (R-14, D12).
    const skill = skillForAgent(member.name, input.skillFamily);
    agent[member.name] = {
      description: member.description,
      prompt: promptFor({
        ...member,
        ...(override?.brief !== undefined ? { brief: override.brief } : {}),
        ...(skill !== null ? { skill } : {}),
      }),
      // Deny shell/network tools per agent; documented as risk reduction (R-10). The harness
      // honouring its own config is assumed; detection at accept is the layer that holds.
      tools: member.readOnly ? { ...READ_ONLY_TOOLS } : { ...DENIED_TOOLS },
      // Custom agents default every tool to "ask", which stalls a headless session on an
      // invisible prompt (verified against OpenCode 1.18.10). Editing inside the proposal is
      // exactly what the user asked for (R-17), so the file/editing toolset is allowed
      // explicitly and shell/network are denied. A wildcard allow is NOT used — it was
      // observed to override the specific denies. Unlisted tools fall to the harness's ask
      // default, which surfaces through the permission backstop (R-16) and stays rare (D9).
      permission: member.readOnly
        ? { ...READ_ONLY_PERMISSION }
        : {
            edit: "allow",
            write: "allow",
            read: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            patch: "allow",
            todowrite: "allow",
            todoread: "allow",
            "arke-world*": "allow",
            "arke-world_*": "allow",
            bash: "deny",
            webfetch: "deny",
            websearch: "deny",
          },
      // The agent's own choice wins over the session-wide one; absent, OpenCode keeps using
      // whatever it is configured with, which is the only safe default — pinning a model the
      // user's OpenCode has no auth for would break every session.
      ...(override?.model ?? input.model ? { model: override?.model ?? input.model } : {}),
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    agent,
    ...(input.worldQueryUrl
      ? {
          mcp: {
            "arke-world": {
              type: "remote",
              url: input.worldQueryUrl,
              enabled: true,
            },
          },
        }
      : {}),
    // Autonomy inside the proposal is the point; edits there are exactly what was asked for.
    // Anything beyond it (denied tools) stays on ask — the backstop, expected to be rare (R-17).
    permission: {
      edit: "allow",
      bash: "ask",
      webfetch: "ask",
    },
  };
}

/** The providers whose credentials travel to the harness as environment (R-6). One list —
 * the rotation guards and the delivery loop both derive from it, so adding a provider here
 * is the whole change; a guard that forgot would strand the new key outside the spawn env,
 * which under v2's redirected profile is the only credential path there is (issue 327 §2).
 */
export const LLM_ENV_PROVIDERS = ["anthropic", "openai"] as const;

const LLM_ENV_NAMES: Record<(typeof LLM_ENV_PROVIDERS)[number], string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Provider credentials as environment variables for the spawned harness (R-6). Keys never
 * touch a config file; SPEC-008 supplies the actual values from safeStorage.
 */
export function credentialEnv(credentials: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const provider of LLM_ENV_PROVIDERS) {
    const key = credentials[provider];
    if (key) env[LLM_ENV_NAMES[provider]] = key;
  }
  return env;
}

/**
 * The same delivery as a PATCH: every managed variable is named, with `undefined` for a
 * provider whose key is absent — the deletion marker a merge can honour. `credentialEnv`'s
 * omit-when-absent shape cannot express removal, and a cleared key that silently survives
 * the next spawn is a revocation that did not happen (found in review of issue 327's wiring
 * slice: Settings said "not configured" while the child kept the revoked key until app exit).
 */
export function credentialEnvPatch(
  credentials: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = {};
  for (const provider of LLM_ENV_PROVIDERS) {
    patch[LLM_ENV_NAMES[provider]] = credentials[provider] || undefined;
  }
  return patch;
}
