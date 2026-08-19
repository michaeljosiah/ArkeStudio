import { z } from "zod";

/**
 * What an authoring agent is allowed to do, said once, in nobody's vocabulary (SPEC-005 R-10, R-17).
 *
 * The same policy — no shell, no network, read-only for the agents that answer rather than author
 * — was previously written twice, in two OpenCode grammars: v1's `tools`/`permission` maps and v2's
 * ordered last-match-wins rules. A third harness would have made three, and the intent would have
 * lived nowhere except in the agreement between them.
 *
 * This is the intent. Each adapter owns the table that turns it into tool names its harness
 * understands, and each renders it in its own shape — a config file for OpenCode, a runtime
 * callback for Claude Code.
 *
 * ALLOWLIST, deliberately. A denylist is wrong here for a reason that was measured rather than
 * assumed: deny `Bash` and an agent reaches for `PowerShell` to do the same thing, and a harness
 * that auto-updates grows tools we have never heard of (a Claude Code build gained five between
 * two runs of the same spike). An intent absent from `allow` is refused.
 *
 * What happens to a tool absent from an adapter's TABLE is the adapter's call, and the two answer
 * differently on purpose. OpenCode lets it fall to the harness's ask default (R-16), which is
 * tolerable because its tool set is small and known. Claude Code's is neither — a real install
 * advertises thirty-odd tools including schedulers and workflow launchers — so its adapter refuses
 * outright rather than parking an unattended turn on a prompt, and declares that it offers no
 * `permissions` capability so a host knows not to expect one.
 */

export const ToolIntent = z.enum([
  /** Read a file inside the working directory. */
  "read",
  /** Create or modify a file inside the working directory. */
  "edit",
  /** Pattern-match over the working directory — glob, grep. */
  "search",
  /** List a directory inside the working directory. */
  "list",
  /** The harness's own scratch checklist. Writes nothing the world can see. */
  "todo",
  /** The arke-world MCP surface: the only way the wider world is legible (SPEC-005 §2.5.1). */
  "world-query",
  /** Load a skill document — craft guidance, never user content (SPEC-019 R-14). */
  "skill",
  /** Hand work to a sub-agent. */
  "delegate",
]);
export type ToolIntent = z.infer<typeof ToolIntent>;

export interface AgentConfinement {
  /** Permitted. Every other KNOWN intent is refused. */
  readonly allow: readonly ToolIntent[];
}

/** Authors inside a proposal directory: the editing surface, plus the world it must not contradict. */
const AUTHORING: AgentConfinement = {
  allow: ["read", "edit", "search", "list", "todo", "world-query", "skill"],
};

/**
 * Answers rather than authors (#70 §8.1). No editing at all: its propositions become proposals at
 * wrap-up and only the accept gate touches the world, so an agent that could write would have a
 * path around the gate. No skill either — a skill shapes what is drafted, and nothing is drafted.
 */
const READ_ONLY: AgentConfinement = {
  allow: ["read", "search", "list", "todo", "world-query"],
};

/**
 * Neither role may delegate, which reconciles a disagreement rather than preserving one: v2 denies
 * `subagent` to read-only agents and never grants it to authoring ones, while v1 left `task`
 * unlisted for authoring so it landed on the harness's ask default. There was no single prior
 * behaviour to keep. v2's stricter reading wins, for the reason v1's own comment already gave —
 * a child session escapes the per-prompt agent pinning, and was observed spending a live turn's
 * budget producing nothing the validator could accept.
 */
export function confinementFor(agent: { readOnly?: boolean }): AgentConfinement {
  return agent.readOnly ? READ_ONLY : AUTHORING;
}

/** Whether this confinement permits an intent. */
export function permits(confinement: AgentConfinement, intent: ToolIntent): boolean {
  return confinement.allow.includes(intent);
}
