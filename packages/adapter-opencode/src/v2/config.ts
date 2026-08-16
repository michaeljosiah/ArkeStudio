import { promptFor, ROSTER } from "../roster.js";
import { skillForAgent, type SessionConfigInput } from "../config.js";

/**
 * Session configuration in OpenCode v2's shapes (issue 327 §7). The POLICY is the v1
 * writer's, unchanged: Studio owns the roster, the tool denials, and the MCP registration;
 * credentials never appear here (SPEC-005 D5). Only the grammar is new — `agents` with
 * `system`, one ordered `permissions` array per agent, `mcp.servers`, `default_agent`.
 */

interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "ask" | "deny";
}

/**
 * The confinement block, in the only order that works. Rules are an ordered array and the
 * LAST match wins, with agent rules appended after the base policy — so the blanket
 * external-directory deny lands after OpenCode's own managed-directory allows and overrides
 * them (measured against 0.0.0-next-17444). The re-allows therefore come AFTER the deny.
 * This ordering looks wrong until you know why it isn't; that is exactly why it is a named
 * constant with this comment attached.
 */
const CONFINEMENT_RULES: readonly PermissionRule[] = [
  // Nothing outside the session directory —
  { action: "external_directory", resource: "*", effect: "deny" },
  // — except OpenCode's own managed directories, which its tools need to function. These are
  // the four boundaries the base policy grants (measured); ~ expands during config load.
  { action: "external_directory", resource: "~/.local/share/opencode/*", effect: "allow" },
  { action: "external_directory", resource: "~/.config/opencode/*", effect: "allow" },
  { action: "external_directory", resource: "~/AppData/Local/Temp/opencode/*", effect: "allow" },
];

/** The working set an authoring agent needs inside its proposal directory (R-17). */
const AUTHORING_RULES: readonly PermissionRule[] = [
  { action: "read", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "allow" }, // v2's `edit` covers edit, write, and patch
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "arke-world_*", resource: "*", effect: "allow" },
  { action: "skill", resource: "*", effect: "allow" },
  // Shell and network stay off — risk reduction, not a boundary (R-10, D10); the accept
  // gate's detection remains the layer that holds.
  { action: "shell", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
  ...CONFINEMENT_RULES,
];

/**
 * An agent that answers rather than authors writes nothing and delegates to nobody
 * (#70 §8.1): its propositions become proposals at wrap-up, and only the accept gate touches
 * the world. `subagent` is denied because a child session escapes the session's agent
 * pinning, and was observed (on v1) to burn a live turn's budget producing nothing.
 */
const READ_ONLY_RULES: readonly PermissionRule[] = [
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "arke-world_*", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  ...CONFINEMENT_RULES,
];

export interface SessionConfigV2Input extends SessionConfigInput {
  /**
   * The roster agent this session exists for. Sessions pin their agent over the API as well
   * (POST /api/session/{id}/agent); this is belt and braces so that even a prompt reaching
   * the session by some other door resolves to Studio's agent, never to `build`.
   */
  defaultAgent?: string;
}

/** The opencode.json object written into a v2 session's working directory. */
export function buildSessionConfigV2(input: SessionConfigV2Input): Record<string, unknown> {
  const agents: Record<string, unknown> = {};
  for (const member of ROSTER) {
    const override = input.agents?.[member.name];
    // The skill comes from the shipped registry, never from the Settings override (R-14, D12).
    const skill = skillForAgent(member.name, input.skillFamily);
    agents[member.name] = {
      description: member.description,
      system: promptFor({
        ...member,
        ...(override?.brief !== undefined ? { brief: override.brief } : {}),
        ...(skill !== null ? { skill } : {}),
      }),
      permissions: member.readOnly ? [...READ_ONLY_RULES] : [...AUTHORING_RULES],
      // Config files keep the string form; the API's ModelRef object is the adapter's business.
      ...(override?.model ?? input.model ? { model: override?.model ?? input.model } : {}),
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    ...(input.defaultAgent ? { default_agent: input.defaultAgent } : {}),
    agents,
    ...(input.worldQueryUrl
      ? {
          mcp: {
            servers: {
              "arke-world": {
                type: "remote",
                url: input.worldQueryUrl,
                // Code Mode is v2's default for MCP tools and it changes tool naming and
                // permission matching; `false` keeps the arke-world_* surface the permission
                // rules and World Chat receipts assume (issue 327 §7).
                codemode: false,
              },
            },
          },
        }
      : {}),
    // Session-wide floor: autonomy inside the proposal is the point; anything an agent rule
    // does not decide stays on ask — the backstop, expected to be rare (R-16, D9).
    permissions: [
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "webfetch", resource: "*", effect: "ask" },
    ],
  };
}
