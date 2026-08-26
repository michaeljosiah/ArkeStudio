import { permits, type AgentConfinement, type ToolIntent } from "@arke-studio/contracts";
import { confinePath } from "./path-confinement.js";

/**
 * Claude Code's vocabulary for each intent — this adapter's half of {@link AgentConfinement} —
 * and, for each tool, which of its arguments name a place on disk.
 *
 * Two things make this table different in kind from the OpenCode ones. It is consulted at
 * RUNTIME, per tool call, through `canUseTool`, rather than written into a config file the
 * harness is trusted to honour. And the tool surface it describes is not stable: it belongs to a
 * binary the user installed and that updates itself, and it was measured growing from 26 to 31
 * tools between two runs of the same spike. Names absent here are therefore refused, never
 * assumed harmless.
 *
 * `paths` is stated for every tool, including the ones that have none. An intent alone says what
 * a tool may DO and says nothing about where — which is exactly how a read-only agent came to
 * read a file out of `%LOCALAPPDATA%\Temp`. Writing `paths: []` is a claim about a tool, made
 * deliberately, and {@link UNDECLARED_PATH_ARGUMENT} is what catches it going stale.
 */
interface ToolPolicy {
  readonly intent: ToolIntent;
  /** Input keys naming a filesystem path. Every one is confined to the working directory. */
  readonly paths: readonly string[];
}

const TOOL_POLICIES: Readonly<Record<string, ToolPolicy>> = {
  Read: { intent: "read", paths: ["file_path"] },
  NotebookRead: { intent: "read", paths: ["notebook_path"] },
  Edit: { intent: "edit", paths: ["file_path"] },
  Write: { intent: "edit", paths: ["file_path"] },
  NotebookEdit: { intent: "edit", paths: ["notebook_path"] },
  // `path` is optional on both and defaults to the working directory, which is already inside.
  Glob: { intent: "search", paths: ["path"] },
  Grep: { intent: "search", paths: ["path"] },
  TodoWrite: { intent: "todo", paths: [] },
  TodoRead: { intent: "todo", paths: [] },
  Skill: { intent: "skill", paths: [] },
  Task: { intent: "delegate", paths: [] },
  WebSearch: { intent: "web", paths: [] },
  WebFetch: { intent: "web", paths: [] },
};

/** MCP tools arrive as `mcp__<server>__<tool>`; ours is the only server a session is given. */
const WORLD_QUERY_PREFIX = "mcp__arke-world__";

/**
 * The world-query surface takes ids, slugs, queries and one URL — no filesystem paths at all. It
 * reaches the world over HTTP through a server we run, which does its own confinement; a path
 * argument appearing here would mean that surface had changed shape underneath us.
 */
const WORLD_QUERY_POLICY: ToolPolicy = { intent: "world-query", paths: [] };

/**
 * Argument names that look like a place on disk.
 *
 * The backstop for a tool that GROWS a path argument between two versions of a binary that
 * updates itself. Refusing an argument we do not understand is the same default-deny the tool
 * names already get, and it fails in the direction where somebody notices: a refusal is visible
 * and gets fixed, a silently unchecked path is not.
 */
const UNDECLARED_PATH_ARGUMENT = /(^|_)(path|paths|dir|dirs|directory|directories|cwd|file|files)(_|$)/i;

function policyFor(toolName: string): ToolPolicy | null {
  if (toolName.startsWith(WORLD_QUERY_PREFIX)) return WORLD_QUERY_POLICY;
  return TOOL_POLICIES[toolName] ?? null;
}

/** The intent a Claude tool serves, or null when we have never heard of it. */
export function intentOf(toolName: string): ToolIntent | null {
  return policyFor(toolName)?.intent ?? null;
}

export type ToolDecision =
  | { allow: true }
  | { allow: false; reason: "refused"; intent: ToolIntent }
  /** Not in the table at all — a tool this build has and we have no policy for. */
  | { allow: false; reason: "unknown" }
  /** The intent is permitted; the place is not. Carries where it was actually pointed. */
  | { allow: false; reason: "outside"; intent: ToolIntent; path: string }
  /** A known tool carrying a path argument this table does not declare — the table is stale. */
  | { allow: false; reason: "undeclared-path"; intent: ToolIntent; argument: string };

/** What a call needs to be judged: the arguments, and the boundary they are judged against. */
export interface ToolCall {
  readonly input: Record<string, unknown>;
  /** The session's working directory, symlinks already resolved — see {@link resolveRoot}. */
  readonly root: string;
}

/**
 * Default-deny, on both questions a call raises: what it does, and where.
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
 *
 * MEASURED against 2.1.235, and the two halves are easy to conflate. Claude Code decides for
 * itself whether to consult `canUseTool` at all, and it decides on the same boundary this
 * function does: side-effect-free work INSIDE the working directory is auto-approved and never
 * offered — an in-directory `Read` and a read-only `Bash` were both invisible here — while the
 * gate IS consulted once a call leaves the directory. An out-of-directory `Read`, `Glob`, `Write`
 * and `Bash` were each offered, in a run instrumented to compare the tool calls a turn emitted
 * against the ones that arrived. So the gate sees every escape, and what it does with one is
 * this function's decision. Until this change it said allow: `Read` mapped to `read`, both roles
 * permit `read`, and the argument naming the file was passed straight back out untouched.
 *
 * Note what that leaves depending on somebody else's judgement: calls INSIDE the directory are
 * auto-approved by the harness rather than by us, so a confinement that omitted `search` or
 * `read` would not actually be enforced against an in-directory call. Both roles allow both, so
 * nothing is wrong today. If that ever changes — or if a build stops consulting the gate on the
 * way out — the fix is measured and ready rather than theoretical: a `PreToolUse` hook was
 * verified on this same build to see calls `canUseTool` never gets, including the in-directory
 * `Read` above, and to be able to deny them.
 */
export async function decideTool(
  confinement: AgentConfinement,
  toolName: string,
  call: ToolCall,
): Promise<ToolDecision> {
  const policy = policyFor(toolName);
  if (policy === null) return { allow: false, reason: "unknown" };
  const { intent, paths } = policy;
  if (!permits(confinement, intent)) return { allow: false, reason: "refused", intent };

  for (const key of Object.keys(call.input)) {
    if (paths.includes(key)) continue;
    if (UNDECLARED_PATH_ARGUMENT.test(key)) return { allow: false, reason: "undeclared-path", intent, argument: key };
  }

  for (const key of paths) {
    const raw = call.input[key];
    // Absent is not an escape — `path` is optional on Glob and Grep and means the working
    // directory — and null is absent said in JSON.
    if (raw === undefined || raw === null) continue;
    for (const candidate of Array.isArray(raw) ? raw : [raw]) {
      // Present and not a usable path. Not "outside" — we do not know where it points, which is
      // the same position an undeclared argument leaves us in, and it gets the same answer.
      if (typeof candidate !== "string" || candidate === "") {
        return { allow: false, reason: "undeclared-path", intent, argument: key };
      }
      const verdict = await confinePath(call.root, candidate);
      if (!verdict.inside) return { allow: false, reason: "outside", intent, path: verdict.resolved };
    }
  }

  return { allow: true };
}
