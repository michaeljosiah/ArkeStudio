import { ROSTER } from "./roster.js";

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

export interface SessionConfigInput {
  /** The world-query MCP server URL (loopback), when a world is open. */
  worldQueryUrl?: string;
  /** Concrete model for authoring, e.g. "anthropic/claude-sonnet-5" or "ollama/llama3.3". */
  model?: string;
}

/** The opencode.json object written into a session's working directory. */
export function buildSessionConfig(input: SessionConfigInput): Record<string, unknown> {
  const agent: Record<string, unknown> = {};
  for (const member of ROSTER) {
    agent[member.name] = {
      description: member.description,
      prompt: member.prompt,
      // Deny shell/network tools per agent; documented as risk reduction (R-10). The harness
      // honouring its own config is assumed; detection at accept is the layer that holds.
      tools: { ...DENIED_TOOLS },
      // Custom agents default every tool to "ask", which stalls a headless session on an
      // invisible prompt (verified against OpenCode 1.18.10). Editing inside the proposal is
      // exactly what the user asked for (R-17), so the file/editing toolset is allowed
      // explicitly and shell/network are denied. A wildcard allow is NOT used — it was
      // observed to override the specific denies. Unlisted tools fall to the harness's ask
      // default, which surfaces through the permission backstop (R-16) and stays rare (D9).
      permission: {
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
      ...(input.model ? { model: input.model } : {}),
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

/**
 * Provider credentials as environment variables for the spawned harness (R-6). Keys never
 * touch a config file; SPEC-008 supplies the actual values from safeStorage.
 */
export function credentialEnv(credentials: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  const map: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
  };
  for (const [provider, key] of Object.entries(credentials)) {
    const envName = map[provider];
    if (envName && key) env[envName] = key;
  }
  return env;
}
