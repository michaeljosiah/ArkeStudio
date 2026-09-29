import {
  agentPromptFor,
  confinementFor,
  permits,
  ROSTER,
  sessionSkillForAgent,
  ToolIntent,
  type AgentConfinement,
  type LocalHarnessModel,
  type SessionConfigInput,
} from "@arke-studio/contracts";
import { assessMappedPermission, type SessionPermissionPolicy } from "../permission-policy.js";

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

/**
 * v2's vocabulary for each intent. The policy is {@link confinementFor}'s; this only says how v2
 * spells it. `list` and `todo` have no entry because v2's rules never carried one — they fall to
 * the session floor, as they always have, and inventing a rule here would be a change of
 * behaviour wearing a refactor's clothes.
 */
const V2_ACTIONS: Partial<Record<ToolIntent, readonly string[]>> = {
  read: ["read"],
  edit: ["edit"], // v2's `edit` covers edit, write, and patch
  search: ["glob", "grep"],
  "world-query": ["arke-world_*"],
  skill: ["skill"],
  delegate: ["subagent"],
  web: ["webfetch", "websearch"],
};

/**
 * Never an intent — risk reduction, not a boundary (R-10, D10); the accept gate still holds.
 *
 * `webfetch` and `websearch` moved to {@link V2_ACTIONS}: they are a capability a confinement can
 * grant, not a hazard. `shell` is the one that stays, for the reason the list existed.
 */
const V2_NEVER = ["shell"] as const;

/** A runtime ask checked against the same vocabulary used to write v2's session config. */
export function assessV2Permission(
  policy: SessionPermissionPolicy | null | undefined,
  actionClass: string,
) {
  return assessMappedPermission(policy, actionClass, V2_ACTIONS, [...V2_NEVER, "external_directory"]);
}

/**
 * One confinement, in v2's grammar — and the grammar IS the policy here, because rules are an
 * ordered array where the last match wins. Allows first, then the refusals, then the confinement
 * block last so its blanket external-directory deny lands after OpenCode's managed-directory
 * allows. Reordering this is a behaviour change, not a tidy-up.
 */
function renderV2(confinement: AgentConfinement): PermissionRule[] {
  const allows: PermissionRule[] = [];
  const denies: PermissionRule[] = [];
  for (const intent of ToolIntent.options) {
    const actions = V2_ACTIONS[intent];
    if (!actions) continue;
    const allowed = permits(confinement, intent);
    for (const action of actions) {
      (allowed ? allows : denies).push({ action, resource: "*", effect: allowed ? "allow" : "deny" });
    }
  }
  for (const action of V2_NEVER) denies.push({ action, resource: "*", effect: "deny" });
  return [...allows, ...denies, ...CONFINEMENT_RULES];
}

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
    const skill = sessionSkillForAgent(member.name, input);
    agents[member.name] = {
      description: member.description,
      system: agentPromptFor({
        ...member,
        researchWeb: input.researchWeb === true,
        ...(override?.brief !== undefined ? { brief: override.brief } : {}),
        ...(skill !== null ? { skill } : {}),
      }),
      permissions: renderV2(confinementFor(member, { web: input.researchWeb === true })),
      // Config files keep the string form; the API's ModelRef object is the adapter's business.
      ...(input.model ?? override?.model ? { model: input.model ?? override?.model } : {}),
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

/** Where the bundled Ollama answers. Loopback only: a remote runtime is a setting nobody has asked for. */
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

/**
 * The profile-level config that puts the local models in front of OpenCode (issue 1247).
 *
 * Measured against the pinned v2 build, and every clause below is a thing it refused
 * differently. OpenCode never probes Ollama, so the models are listed by name — a provider
 * with no `models` map lists nothing, and the server never asks `/v1/models`. The grammar is
 * v2's own: `providers`, `package` with the `aisdk:` prefix, `settings.baseURL`; the v1 shape
 * (`provider`, `npm`, `options`) parses without a warning and produces no rows. The key is
 * whatever non-empty string keeps the SDK happy; Ollama does not read it. Written into the
 * redirected profile rather than beside each session so the catalogue the pickers validate
 * against carries the rows before any session exists — and the server reloads that file on
 * change (about three seconds, measured), so a pull reaches the picker without a relaunch.
 *
 * No models means the provider block is gone too: a stale row for a model somebody deleted
 * would validate in the picker and fail on the turn.
 */
export function buildProfileConfigV2(models: readonly LocalHarnessModel[], baseUrl = OLLAMA_BASE_URL): Record<string, unknown> {
  if (models.length === 0) return { $schema: "https://opencode.ai/config.json" };
  const rows: Record<string, unknown> = {};
  for (const model of models) {
    rows[model.id] = {
      name: model.id,
      capabilities: { tools: model.tools, input: model.vision ? ["text", "image"] : ["text"], output: ["text"] },
      ...(model.contextLength !== undefined ? { limit: { context: model.contextLength } } : {}),
      // Zero, stated: an absent cost is displayed as unknown, and a local model costs nothing.
      cost: { input: 0, output: 0 },
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    providers: {
      ollama: {
        name: "Ollama",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { baseURL: baseUrl, apiKey: "ollama" },
        models: rows,
      },
    },
  };
}
