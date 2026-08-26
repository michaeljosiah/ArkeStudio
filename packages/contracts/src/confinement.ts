import { z } from "zod";

/**
 * What an authoring agent is allowed to do, said once, in nobody's vocabulary (SPEC-005 R-10, R-17).
 *
 * The same policy — no shell, public-web research off by default, read-only for the agents that
 * answer rather than author — was previously written twice, in two OpenCode grammars: v1's
 * `tools`/`permission` maps and v2's ordered last-match-wins rules. A third harness would have made
 * three, and the intent would have lived nowhere except in the agreement between them.
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

/**
 * Each intent in the second person, for the one reader who has to act on it.
 *
 * Phrased so the same clause reads correctly on both sides of {@link confinementStatement} — "you
 * can read files inside your working directory", "you cannot hand work to a sub-agent" — because
 * two vocabularies for one intent is how the lists come to disagree.
 */
const INTENT_PHRASE: Record<ToolIntent, string> = {
  read: "read files inside your working directory",
  edit: "create and change files inside your working directory",
  search: "search your working directory, by file name or by what is in the files",
  list: "list directories inside your working directory",
  todo: "keep your own scratch checklist",
  "world-query": "read the wider world through the arke-world tools",
  skill: "load a skill document",
  delegate: "hand work to a sub-agent",
  web: "search the public web and read a page from it",
};

/**
 * The confinement, told to the agent it confines — both halves of it.
 *
 * Until this existed the boundary was expressed to an agent only as the set of tools it was
 * handed, and an agent asked what it could do answered from its priors about the environment
 * instead. Measured, in a World Chat turn against 0.5.50 (#506): asked whether it could run a
 * shell command it said yes and named Git Bash and PowerShell, then, asked to run one and paste
 * the output, reported the output and an exit code for a command that never ran. The gate refused
 * every call correctly throughout. Nothing was damaged and the author was told the opposite of
 * the truth, which is the failure this text is for.
 *
 * Derived from the allowlist rather than written out, so a new {@link ToolIntent} cannot appear
 * on neither list, and a role that gains or loses one cannot leave a sentence behind saying
 * otherwise. The fixed lines below the derived ones are the things no allowlist can say: that
 * shell is absent rather than merely unlisted, that an unlisted tool is refused rather than
 * prompted for, and that a tool result may never be described unless it actually came back.
 */
export function confinementStatement(confinement: AgentConfinement): string {
  const say = (intents: readonly ToolIntent[]) => intents.map((i) => `- ${INTENT_PHRASE[i]}`).join("\n");
  const can = ToolIntent.options.filter((intent) => permits(confinement, intent));
  const cannot = ToolIntent.options.filter((intent) => !permits(confinement, intent));
  return `You are running inside Arke Studio, which chooses your tools for you. What follows is the
whole of what you have here — not a summary of it, and not the set you may have had elsewhere.

What you can do:
${say(can)}

What you cannot do:
${cannot.length > 0 ? `${say(cannot)}\n` : ""}- run a shell command. There is no Bash, no PowerShell, no terminal, no way to start a process.
  It is not disabled behind a prompt you could ask someone to lift; there is no such tool here.
- reach any other tool, or any MCP server other than arke-world. Anything not on the first list
  is refused outright, and nobody is asked to approve it, so there is never a prompt pending.

Two things follow from that, and they matter more than the lists.

Do not plan work around a capability you do not have. If the only way you can think of to do
something is a tool you have not been given, say that, and say what you would need.

Never describe the result of a tool call you did not make. If a call comes back denied by Arke
Studio confinement, say so plainly and say what you were trying to do. If you did not run
something, say you did not run it. Inventing output — a command's lines, an exit code, a page you
did not fetch — is the worst thing you can do here, because nothing on the person's screen
contradicts it and they will act on it. When you are asked what you can do, answer from the two
lists above and from nothing else.`;
}

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
