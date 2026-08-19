import { permits, type AgentConfinement, type ToolIntent } from "@arke-studio/contracts";

/**
 * Claude Code's vocabulary for each intent — this adapter's half of {@link AgentConfinement}.
 *
 * Two things make this table different in kind from the OpenCode ones. It is consulted at
 * RUNTIME, per tool call, through `canUseTool`, rather than written into a config file the
 * harness is trusted to honour. And the tool surface it describes is not stable: it belongs to a
 * binary the user installed and that updates itself, and it was measured growing from 26 to 31
 * tools between two runs of the same spike. Names absent here are therefore refused, never
 * assumed harmless.
 */
const TOOL_INTENTS: Readonly<Record<string, ToolIntent>> = {
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Glob: "search",
  Grep: "search",
  TodoWrite: "todo",
  TodoRead: "todo",
  Skill: "skill",
  Task: "delegate",
};

/** MCP tools arrive as `mcp__<server>__<tool>`; ours is the only server a session is given. */
const WORLD_QUERY_PREFIX = "mcp__arke-world__";

/** The intent a Claude tool serves, or null when we have never heard of it. */
export function intentOf(toolName: string): ToolIntent | null {
  if (toolName.startsWith(WORLD_QUERY_PREFIX)) return "world-query";
  return TOOL_INTENTS[toolName] ?? null;
}

export type ToolDecision =
  | { allow: true }
  | { allow: false; reason: "refused"; intent: ToolIntent }
  /** Not in the table at all — a tool this build has and we have no policy for. */
  | { allow: false; reason: "unknown" };

/**
 * Default-deny, and unknown is a refusal rather than a question.
 *
 * The OpenCode renderers let an unlisted tool fall to the harness's ask default, which is the
 * documented backstop (R-16) and stays rare because OpenCode's tool set is small and known.
 * Claude Code's is neither: a real installation advertises thirty-odd tools including schedulers,
 * notifications and workflow launchers, none of which an authoring turn has any business
 * reaching for. Parking an unattended turn on a permission prompt for one of those is a worse
 * failure than refusing it — the agent that gets refused says so and carries on, which is what
 * it was measured doing.
 *
 * The cost is a real capability difference from OpenCode, and it is declared rather than hidden:
 * the adapter does not advertise `permissions`, so a host knows not to expect a prompt here.
 */
export function decideTool(confinement: AgentConfinement, toolName: string): ToolDecision {
  const intent = intentOf(toolName);
  if (intent === null) return { allow: false, reason: "unknown" };
  return permits(confinement, intent) ? { allow: true } : { allow: false, reason: "refused", intent };
}
