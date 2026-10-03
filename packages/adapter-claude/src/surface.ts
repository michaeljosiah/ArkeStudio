import type { AgentConfinement } from "@arke-studio/contracts";
import { offeredTools, WORLD_QUERY_PREFIX } from "./tool-intents.js";

/**
 * What a Claude session is SHOWN, as distinct from what its gate lets through (SPEC-005 R-2).
 *
 * `canUseTool` was the whole confinement, and it turned out to cover less than it looked. Claude
 * Code decides for itself which calls to put to the callback, and a whole class of its built-ins
 * is never put to it: measured on 2.1.235 and 2.1.288 (2026-10-03), a turn under a gate that
 * denied everything loaded `CronCreate` through `ToolSearch` and scheduled a recurring job, and
 * the gate was not consulted once — for either call. A World Chat transcript from 2026-10-02
 * showed the same session being offered the user's claude.ai connectors and some thirty
 * built-ins (schedulers, push notifications, worktrees, messaging) as deferred tools, while
 * Settings said "confinement verified". The probe was right about what it tested; it tested the
 * gate, and these never reach it.
 *
 * So the fix is upstream of the gate: a tool that is not offered cannot be called, whether or
 * not the callback would have been asked. Three options, each closing a different door:
 *
 * - `tools` — the built-in set, as an allowlist derived from the confinement. Without it every
 *   session gets the full `claude_code` preset. With it the init message lists exactly these plus
 *   the MCP tools, and `ToolSearch` goes too: with nothing deferred there is nothing to search,
 *   and the arke-world tools were measured loading directly and being called without it.
 * - `strictMcpConfig` — only the servers this call passes. `settingSources: []` already keeps
 *   the user's files out, but not plugins or agent frontmatter. In the 2.1.235 bundle the SDK's
 *   own startup path also skips the claude.ai connector fetch under this flag — but not every
 *   path that loads MCP config checks it, which is why it is not the only switch.
 * - `disableClaudeAiConnectors` — the claude.ai connectors by name. They arrive with the user's
 *   claude.ai login rather than from any settings file, which is why `settingSources: []` never
 *   touched them. Passed as flag settings, a source the CLI reads even with `settingSources: []`,
 *   and any source saying true wins, so nothing the user has configured can turn it back on.
 *   Redundant with the flag above on the builds measured; kept because it is the switch that
 *   names the thing, and a build that changes what strict mode covers would otherwise reopen it.
 *
 * Not `env`: `ENABLE_CLAUDEAI_MCP_SERVERS=false` would also do it, but passing `env` replaces the
 * subprocess environment wholesale, and the reasons this adapter passes none are in
 * `claude-adapter.ts`.
 *
 * And a `PreToolUse` hook, because narrowing the offer is a request and this is the refusal. The
 * per-session init check below can only END a session, and it cannot run first: measured on both
 * builds, the CLI does not emit its init message until the first user message has been sent, so
 * by the time the list can be read the model is already answering. The hook is consulted before
 * every call, including the ones `canUseTool` never sees — measured denying `ToolSearch` and
 * `CronCreate` under the same deny-everything gate those two walked past.
 *
 * The gate stays exactly as it was. This narrows what reaches it; it does not replace it.
 */
export interface Surface {
  /** The built-ins on offer — {@link offeredTools} for a session, plus the shell for the probe. */
  readonly tools: readonly string[];
  /** Whether Arke configured the arke-world server. Its namespace is trusted only then. */
  readonly world: boolean;
}

/** The surface a session with this confinement is given. */
export function sessionSurface(confinement: AgentConfinement, world: boolean): Surface {
  return { tools: offeredTools(confinement), world };
}

/** Whether a tool name belongs to the surface: offered, or arke-world's when Arke configured it. */
export function onSurface(surface: Surface, tool: string): boolean {
  return surface.tools.includes(tool) || (surface.world && tool.startsWith(WORLD_QUERY_PREFIX));
}

export function confinedOptions(surface: Surface, onRefused?: (tool: string) => void): Record<string, unknown> {
  return {
    // Never inherit the user's own config: omitting this loads their settings AND connects
    // their MCP servers, which an authoring session has no business touching.
    settingSources: [],
    tools: [...surface.tools],
    strictMcpConfig: true,
    settings: { disableClaudeAiConnectors: true },
    hooks: {
      PreToolUse: [{
        hooks: [async (input: { tool_name?: unknown }) => {
          const tool = typeof input.tool_name === "string" ? input.tool_name : "";
          // On the surface: no decision, so the call goes on to `canUseTool` exactly as before.
          // "allow" here would approve it past the gate, which is the opposite of the point.
          if (tool !== "" && onSurface(surface, tool)) return {};
          onRefused?.(tool);
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "denied by Arke Studio confinement",
            },
          };
        }],
      }],
    },
  };
}

/** The `system/init` message, as far as the surface check reads it. */
export interface InitSurface {
  tools?: readonly string[];
  mcp_servers?: readonly { name: string }[];
}

/**
 * Everything the harness listed that Arke did not give it: tools off the surface, and any MCP
 * server Arke did not configure, by name.
 *
 * Read from the init message because that is the one place the harness says what the MODEL was
 * shown — deferred tools included, which the model reaches through `ToolSearch` and which no
 * amount of watching the gate would ever reveal. Empty is the only acceptable answer, and an
 * init message that does not say is not one: a missing list is unknown, not nothing offered.
 */
export function unexpectedSurface(init: InitSurface, surface: Surface): string[] {
  if (!Array.isArray(init.tools)) return ["(no tool list reported)"];
  const tools = init.tools.filter((tool) => !onSurface(surface, tool));
  const servers = (init.mcp_servers ?? [])
    .map((s) => s.name)
    .filter((name) => !(surface.world && name === "arke-world"));
  return [...tools, ...servers.map((name) => `MCP server ${name}`)];
}
