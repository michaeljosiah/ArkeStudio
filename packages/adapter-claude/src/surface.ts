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
 * The gate stays exactly as it was. This narrows what reaches it; it does not replace it.
 */
export function confinedOptions(confinement: AgentConfinement): Record<string, unknown> {
  return {
    // Never inherit the user's own config: omitting this loads their settings AND connects
    // their MCP servers, which an authoring session has no business touching.
    settingSources: [],
    tools: offeredTools(confinement),
    strictMcpConfig: true,
    settings: { disableClaudeAiConnectors: true },
  };
}

/** The `system/init` message, as far as the surface check reads it. */
export interface InitSurface {
  tools?: readonly string[];
  mcp_servers?: readonly { name: string }[];
}

/**
 * Everything the harness listed that Arke did not give it: tools outside `offered` that are not
 * the world surface, and any MCP server other than arke-world, by name.
 *
 * Read from the init message because that is the one place the harness says what the MODEL was
 * shown — deferred tools included, which the model reaches through `ToolSearch` and which no
 * amount of watching the gate would ever reveal. Empty is the only acceptable answer.
 */
export function unexpectedSurface(init: InitSurface, offered: readonly string[]): string[] {
  const tools = (init.tools ?? []).filter((tool) => !offered.includes(tool) && !tool.startsWith(WORLD_QUERY_PREFIX));
  const servers = (init.mcp_servers ?? []).map((s) => s.name).filter((name) => name !== "arke-world");
  return [...tools, ...servers.map((name) => `MCP server ${name}`)];
}
