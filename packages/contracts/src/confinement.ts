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
  /**
   * Search the public web and read a page from it.
   *
   * An intent rather than a permanent refusal, which is a correction. "No network" was written as
   * a NEVER in both OpenCode renderers and as an absence from Claude's table, so asking an agent
   * to go and look something up produced a refusal no confinement had chosen and none could undo.
   * That was never the policy — the policy is that an agent cannot reach the filesystem or the
   * wider world except through the tools it is given, and reading a public page is neither.
   *
   * It stays outside the world entirely: nothing it returns is canon, nothing is written, and the
   * accept gate is still the only door to the world. What comes back is material for the
   * conversation, cited so a person can check it — see {@link WEB_RESEARCH_RULE}.
   */
  "web",
]);
export type ToolIntent = z.infer<typeof ToolIntent>;

export interface AgentConfinement {
  /** Permitted. Every other KNOWN intent is refused. */
  readonly allow: readonly ToolIntent[];
}

/**
 * What an agent permitted {@link ToolIntent} `web` is told about using it.
 *
 * Kept with the intent rather than in a brief because it is the condition the capability is
 * granted under, not craft guidance: a claim that arrived from outside is only useful if the
 * person can see where it came from. Deliberately light — the URL in the sentence, and no
 * machinery. An earlier design hashed each page into a checkable attachment; for material that
 * shapes a conversation rather than entering the world, that was a lot of apparatus guarding
 * something the accept gate already guards.
 */
export const WEB_RESEARCH_RULE = `You can search the web and read pages from it. Use it when a question turns on
something you would otherwise be guessing at — how a form actually works, what an
audience responds to, what is true of a real place — and when the person asks you to
go and look.
- Say the URL you took a claim from, in the sentence that makes the claim. A person
  has to be able to go and check it.
- What you read is not canon and does not go into the world. It is material for the
  conversation, and anything it leads to still goes through the same accept gate as
  everything else.
- Say so plainly when a search found nothing useful. A guess presented as a finding
  is worse than no finding.`;

/** Authors inside a proposal directory: the editing surface, plus the world it must not contradict. */
const AUTHORING: AgentConfinement = {
  allow: ["read", "edit", "search", "list", "todo", "world-query", "skill"],
};

/**
 * Answers rather than authors (#70 §8.1). No editing at all: its propositions become proposals at
 * wrap-up and only the accept gate touches the world, so an agent that could write would have a
 * path around the gate. No skill either — a skill shapes what is drafted, and nothing is drafted.
 *
 * `web` is in neither list, and {@link confinementFor} adds it: it is the one capability here that
 * a person turns on rather than a role that implies it.
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

export interface ConfinementOptions {
  /**
   * Settings' `research.web`. Absent means off, which is the answer the setting itself gives until
   * someone changes it — a caller that has not read settings must not grant this by forgetting to.
   */
  readonly web?: boolean;
}

/**
 * The confinement for a role, plus whatever Settings has opened up.
 *
 * Role does not decide `web`, which is why it is a parameter and not a third list. Authoring
 * agents want it to check a fact before writing it down and World Chat wants it because that is
 * where someone says go and look this up — so the only question left is the person's, and it is
 * already theirs: `research.web` is off until they turn it on, because an app that reads your
 * world off your own disk going online is a different promise from the one it makes by default.
 *
 * Read per session rather than per call, because session config is written once — the same terms
 * the agent's model and skill are chosen on. Switching it off reaches the next session.
 */
export function confinementFor(
  agent: { readOnly?: boolean },
  opts: ConfinementOptions = {},
): AgentConfinement {
  const base = agent.readOnly ? READ_ONLY : AUTHORING;
  return opts.web === true ? { allow: [...base.allow, "web"] } : base;
}

/** Whether this confinement permits an intent. */
export function permits(confinement: AgentConfinement, intent: ToolIntent): boolean {
  return confinement.allow.includes(intent);
}
