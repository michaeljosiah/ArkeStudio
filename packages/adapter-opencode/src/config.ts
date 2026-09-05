import {
  agentPromptFor,
  LLM_ENV_NAMES,
  LLM_ENV_PROVIDERS,
  confinementFor,
  permits,
  ROSTER,
  skillForAgent,
  ToolIntent,
  type AgentConfinement,
  type SessionConfigInput,
} from "@arke-studio/contracts";
import { assessMappedPermission, type SessionPermissionPolicy } from "./permission-policy.js";

/**
 * Session configuration written by Studio (SPEC-005 R-5, R-6, R-10, D5).
 *
 * Studio owns the harness's configuration: the agent roster, the tool denials, and the MCP
 * registration for the world-query tool are written as `opencode.json` into the session's
 * working directory at session start. Credentials NEVER appear here — they reach the process
 * by environment variable at spawn (D5), and this module builds that env map.
 */

/**
 * v1's vocabulary for each intent (SPEC-005 R-10, R-17). The policy is
 * {@link confinementFor}'s; this table only says how v1 spells it.
 *
 * `skill` has no entry because v1's config has no permission name for one — a skill reaches
 * the agent through its prompt, not through a tool it asks for.
 */
const V1_TOOLS: Partial<Record<ToolIntent, readonly string[]>> = {
  read: ["read"],
  edit: ["edit", "write", "patch"],
  search: ["glob", "grep"],
  list: ["list"],
  todo: ["todowrite", "todoread"],
  "world-query": ["arke-world*", "arke-world_*"],
  delegate: ["task"],
  web: ["webfetch", "websearch"],
};

/**
 * Never an intent, never available: risk reduction, not a boundary (R-10, D10).
 *
 * `webfetch` and `websearch` were here and are now intents instead — reading a public page is not
 * a way into the filesystem, and their being NEVER meant no confinement could grant research even
 * when that was the whole point of the turn. `bash` stays: it is the one that turns any other
 * refusal into a suggestion.
 */
const V1_NEVER = ["bash"] as const;

/** A runtime ask checked against the same vocabulary used to write v1's session config. */
export function assessV1Permission(
  policy: SessionPermissionPolicy | null | undefined,
  actionClass: string,
) {
  return assessMappedPermission(policy, actionClass, V1_TOOLS, V1_NEVER);
}

/**
 * One confinement, rendered into v1's two parallel surfaces: `tools` decides what exists at all,
 * `permission` decides what it may do. A wildcard allow is NOT used — it was observed to override
 * the specific denies. Anything unlisted falls to the harness's ask default, which surfaces
 * through the permission backstop (R-16) and stays rare (D9).
 */
function renderV1(confinement: AgentConfinement): {
  tools: Record<string, boolean>;
  permission: Record<string, string>;
} {
  const tools: Record<string, boolean> = {};
  const permission: Record<string, string> = {};
  for (const name of V1_NEVER) {
    tools[name] = false;
    permission[name] = "deny";
  }
  for (const intent of ToolIntent.options) {
    const names = V1_TOOLS[intent];
    if (!names) continue;
    const allowed = permits(confinement, intent);
    for (const name of names) {
      permission[name] = allowed ? "allow" : "deny";
      // Custom agents default every tool to "ask", which stalls a headless session on an
      // invisible prompt (verified against OpenCode 1.18.10). A refused tool is taken away
      // rather than left to prompt for something that will never be granted.
      if (!allowed) tools[name] = false;
    }
  }
  return { tools, permission };
}

/** The opencode.json object written into a session's working directory. */
export function buildSessionConfig(input: SessionConfigInput): Record<string, unknown> {
  const agent: Record<string, unknown> = {};
  for (const member of ROSTER) {
    const override = input.agents?.[member.name];
    // The skill comes from the shipped registry, never from the Settings override: a brief
    // replaces what the agent is for, and craft guidance the output quality depends on is not
    // something to lose by editing an unrelated field (R-14, D12).
    const skill = skillForAgent(member.name, input.skillFamily, input.skillModelId);
    agent[member.name] = {
      description: member.description,
      prompt: agentPromptFor({
        ...member,
        researchWeb: input.researchWeb === true,
        ...(override?.brief !== undefined ? { brief: override.brief } : {}),
        ...(skill !== null ? { skill } : {}),
      }),
      // The confinement is decided once, in contracts, and only spelled here (R-10, R-17).
      ...renderV1(confinementFor(member, { web: input.researchWeb === true })),
      // A dispatch choice is narrower than an agent default and therefore wins for this session.
      // With neither, OpenCode keeps its own default rather than Studio inventing one.
      ...(input.model ?? override?.model ? { model: input.model ?? override?.model } : {}),
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

/** Compatibility export; contracts owns the policy shared with credential rotation guards. */
export { LLM_ENV_PROVIDERS } from "@arke-studio/contracts";

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
