import {
  agentPromptFor,
  confinementFor,
  permits,
  ROSTER,
  sessionSkillForAgent,
  ToolIntent,
  type AgentConfinement,
  type SessionConfigInput,
  type PrivateSessionTransport,
} from "@arke-studio/contracts";
import { assessMappedPermission, sessionPermissionPolicy, type SessionPermissionPolicy } from "../permission-policy.js";
import { privateBridgeTransport, type privateWireBody } from "./private-control.js";

/**
 * Session configuration in OpenCode v2 shapes. Contracts owns confinement policy;
 * Studio owns the roster, tool denials and MCP registration, and
 * credentials never appear here (SPEC-005 D5). Only the grammar is new â€” `agents` with
 * `system`, one ordered `permissions` array per agent, `mcp.servers`, `default_agent`.
 */

interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "ask" | "deny";
}

/**
 * The confinement block, in the only order that works. Rules are an ordered array and the
 * LAST match wins, with agent rules appended after the base policy â€” so the blanket
 * external-directory deny lands after OpenCode's own managed-directory allows and overrides
 * them (measured against 2.2.5). The re-allows therefore come AFTER the deny.
 * This ordering looks wrong until you know why it isn't; that is exactly why it is a named
 * constant with this comment attached.
 */
const CONFINEMENT_RULES: readonly PermissionRule[] = [
  // Nothing outside the session directory â€”
  { action: "external_directory", resource: "*", effect: "deny" },
  // â€” except OpenCode's own managed directories, which its tools need to function. These are
  // the four boundaries the base policy grants (measured); ~ expands during config load.
  { action: "external_directory", resource: "~/.local/share/opencode/*", effect: "allow" },
  { action: "external_directory", resource: "~/.config/opencode/*", effect: "allow" },
  { action: "external_directory", resource: "~/AppData/Local/Temp/opencode/*", effect: "allow" },
];

/**
 * v2's vocabulary for each intent. The policy is {@link confinementFor}'s; this only says how v2
 * spells it. `list` and `todo` have no entry because v2's rules never carried one â€” they fall to
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
 * Never an intent â€” risk reduction, not a boundary (R-10, D10); the accept gate still holds.
 *
 * `webfetch` and `websearch` moved to {@link V2_ACTIONS}: they are a capability a confinement can
 * grant, not a hazard. `shell` is the one that stays, for the reason the list existed.
 *
 * Everything else here is an engine tool no agent was ever meant to have. An action no rule names
 * is allowed without asking, so each must be named (measured against 2.2.5, as is the rest of this):
 *
 * - `experimental_image_generate` is on by default from 2.2.2 whenever a connected provider has an
 *   image model. Pictures go through Arke's own routes and ledger, never through the engine.
 * - `execute` is Code Mode, a JavaScript runtime over the engine's own tools. Through it any agent,
 *   read-only ones included, could call `session_move` and walk out of `.proposals/<id>` into the
 *   world behind the accept gate (2.0.26 too), or `worktree_create` in the repository around it.
 * - With `execute` denied the engine offers those tools directly instead, as `opencode_<name>`, so
 *   the namespace goes too. `opencode_worktree_remove` stays: it is filed under `edit`, and
 *   {@link EDIT_INSIDE_SESSION} is what stops it. An agent-level deny also hides a tool's schema.
 */
const V2_NEVER = ["shell", "experimental_image_generate", "execute", "opencode_*"] as const;

/**
 * `edit` only under the session directory, written straight after its allow. The engine counts the
 * whole git repository around a session as internal, so a world kept in a repository gets no
 * `external_directory` ask for `../..`, and `worktree_remove` never makes that check at all. Its
 * resources are relative to the session inside and absolute outside. These must not follow a deny:
 * the engine hides a tool only when the last rule naming it has resource `*`.
 */
const EDIT_INSIDE_SESSION: readonly PermissionRule[] = [
  { action: "edit", resource: "..", effect: "deny" },
  { action: "edit", resource: "../*", effect: "deny" },
  { action: "edit", resource: "/*", effect: "deny" },
  { action: "edit", resource: "?:/*", effect: "deny" },
];

/**
 * Rules on the session itself, which the engine merges after every other. Its built-in browser
 * plugin appends `skill browser deny` behind an agent's own rules, and a tool is hidden only when
 * the last rule naming it has resource `*`, so a denied `skill` still reached the model as a schema
 * (measured against 2.2.5, sealed sessions included). A call was refused, but that is not zero tools.
 */
export function sessionRulesV2(agentName: string | undefined): PermissionRule[] {
  const policy = sessionPermissionPolicy(agentName, {});
  return policy && !permits(policy.confinement, "skill") ? [{ action: "skill", resource: "*", effect: "deny" }] : [];
}

/** A runtime ask checked against the same vocabulary used to write v2's session config. */
export function assessV2Permission(
  policy: SessionPermissionPolicy | null | undefined,
  actionClass: string,
) {
  return assessMappedPermission(policy, actionClass, V2_ACTIONS, [...V2_NEVER, "external_directory"]);
}

/**
 * One confinement, in v2's grammar â€” and the grammar IS the policy here, because rules are an
 * ordered array where the last match wins. Allows first, then the refusals, then the confinement
 * block last so its blanket external-directory deny lands after OpenCode's managed-directory
 * allows. Reordering this is a behaviour change, not a tidy-up.
 */
function renderV2(confinement: AgentConfinement): PermissionRule[] {
  if (confinement.denyUnknown) return [
    { action: "*", resource: "*", effect: "deny" },
    ...confinement.allow.flatMap(intent => (V2_ACTIONS[intent] ?? []).map(action =>
      ({ action, resource: "*", effect: "allow" as const }))),
  ];
  const allows: PermissionRule[] = [];
  const denies: PermissionRule[] = [];
  for (const intent of ToolIntent.options) {
    const actions = V2_ACTIONS[intent];
    if (!actions) continue;
    const allowed = permits(confinement, intent);
    for (const action of actions) {
      (allowed ? allows : denies).push({ action, resource: "*", effect: allowed ? "allow" : "deny" });
      if (allowed && action === "edit") allows.push(...EDIT_INSIDE_SESSION);
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
export function buildSessionConfigV2(input: SessionConfigV2Input, privateControl?: string, privateBody?: ReturnType<typeof privateWireBody>, transport?: PrivateSessionTransport): Record<string, unknown> {
  if (privateControl && (privateControl.length > 4096 || privateControl.includes("\0") || [...privateControl].some(character => "\\*?[]{}!".includes(character)))) throw new Error("The private native control path cannot be pinned to a literal policy.");
  const operational = ROSTER.find(member => member.name === (input.agent ?? input.defaultAgent) && member.operationalOnly);
  const voice = ROSTER.some(member => member.name === (input.agent ?? input.defaultAgent) && member.voiceOnly);
  const reference = input.model ?? (operational ? input.agents?.[operational.name]?.model : undefined);
  const provider = reference?.slice(0, reference.indexOf("/"));
  if (transport && (!operational || !privateBody || !privateControl || provider !== "ollama")) throw new Error("A private bridge requires the sealed operational Ollama session.");
  const bridge = transport && privateBridgeTransport(transport);
  if (operational && reference && (!reference.includes("/") || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(provider ?? ""))) {
    throw new Error("The Studio provider identifier cannot be pinned to a literal native policy.");
  }
  const agents: Record<string, unknown> = {};
  for (const member of ROSTER) {
    if (operational && member.name !== operational.name) continue;
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
  if (operational || voice) {
    // These are the bundled 2.2.5 helpers, not application delegation. In particular title
    // generation must not make an extra model request outside the reviewed Studio payload.
    for (const name of ["title", "compaction", "summary", "build", "plan", "explore", "general"]) agents[name] = { disabled: true };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    ...(operational ? { default_agent: operational.name } : input.defaultAgent ? { default_agent: input.defaultAgent } : {}),
    agents,
    // Only an ephemeral host bridge capability belongs in this private configuration.
    // The actual upstream provider credential remains with the bridge's host owner.
    ...(bridge ? { providers: { ollama: { settings: bridge } } } : {}),
    ...(voice ? { compaction: { auto: false }, warming: false, websearch: false } : {}),
    ...(operational ? {
      ...(privateControl ? { plugins: [privateBody ? { package: privateControl, options: { body: privateBody } } : privateControl] } : {}),
      compaction: { auto: false }, warming: false, websearch: false,
      // Unmatched `mcp.use`, `skill.use` and `plugin.use` allow, so each needs its own deny:
      // since 2.2.3 `integration.use` no longer covers them. It now names the account behind a
      // provider instead, so its blanket deny needs an allow for the one provider or the session
      // has no model. The bare identifier matches connectionless use only, never a signed-in
      // account (measured against 2.2.5).
      policies: [
        { action: "tool.use", resource: "*", effect: "deny" },
        { action: "mcp.use", resource: "*", effect: "deny" },
        { action: "skill.use", resource: "*", effect: "deny" },
        { action: "plugin.use", resource: "*", effect: "deny" },
        ...(privateControl ? [{ action: "plugin.use", resource: privateControl, effect: "allow" }] : []),
        { action: "integration.use", resource: "*", effect: "deny" },
        ...(provider ? [{ action: "integration.use", resource: provider, effect: "allow" }] : []),
        { action: "provider.use", resource: "*", effect: "deny" },
        ...(provider ? [{ action: "provider.use", resource: provider, effect: "allow" }] : []),
      ],
    } : {}),
    ...(!operational && input.worldQueryUrl
      ? {
          mcp: {
            servers: {
              "arke-world": {
                type: "remote",
                url: input.worldQueryUrl,
                // Code Mode is v2's default for MCP tools and it changes tool naming and
                // permission matching; `false` keeps the arke-world_* surface the permission
                // rules and World Chat receipts assume (issue 327 Â§7).
                codemode: false,
              },
            },
          },
        }
      : {}),
    // Session-wide floor: autonomy inside the proposal is the point. `shell` and `webfetch` stay
    // on ask where an agent rule does not decide them (R-16, D9). This is not a blanket backstop:
    // an action named nowhere is allowed by the engine, which is why V2_NEVER names them.
    permissions: operational ? [{ action: "*", resource: "*", effect: "deny" }] : [
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "webfetch", resource: "*", effect: "ask" },
    ],
  };
}
