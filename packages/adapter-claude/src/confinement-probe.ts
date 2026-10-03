import { confinementFor } from "@arke-studio/contracts";
import { offeredTools } from "./tool-intents.js";
import { unexpectedSurface, type InitSurface } from "./surface.js";

/**
 * The confinement probe: does this Claude Code build actually honour our tool gate?
 *
 * The boundary is somebody else's binary, on a version we do not control, that auto-updates
 * without telling us — one moved from 2.1.177 to 2.1.235 mid-session during the spike that
 * produced this module. What would fail is confinement itself, and it would fail silently, so
 * it cannot be inferred from a version number (SPEC-005 R-2) and it cannot be allowed to
 * degrade the way an OpenCode generation mismatch degrades. OpenCode too old falls back to v1;
 * Claude Code that cannot be verified is not offered at all.
 *
 * Every build tried so far honours the gate. That is not a reason to skip the check — it is
 * the reason the check has to be cheap enough to always run. And honouring the gate turned out
 * to be half the question: not every tool reaches it (`surface.ts`), so the probe also reads
 * the one list the harness does publish — the tools the init message says the model was given —
 * and refuses a build that gives it anything Arke did not ask for.
 *
 * That init message carries a real capability list too, but it advertises interrupts and message
 * lifecycle only — nothing about permissions — so the gate itself cannot be read off it. That
 * half has to be behavioural: run one throwaway turn that provokes a denied tool and see what
 * happened.
 *
 * If a `permissions_*` capability ever appears in that list, this collapses to reading a
 * string and every caller keeps working, because they only ever see {@link ConfinementVerdict}.
 */

/** What one probe turn observed. Produced by the SDK-backed seam; see {@link RunProbeTurn}. */
export interface ProbeTurnResult {
  /** Tool names the gate was consulted for, in order. Empty means it was never consulted. */
  gateInvokedFor: readonly string[];
  /**
   * Whether the denied side effect actually happened — the sentinel file the probe prompt asks
   * for. Load-bearing: a callback that fires and is then ignored is worse than one that never
   * fires, and only the side effect distinguishes them.
   */
  deniedActionHappened: boolean;
  /** `claude_code_version` from the init message — what actually ran, not what we asked for. */
  version: string | null;
  /**
   * Which credential the harness authenticated with, verbatim from the init message.
   *
   * `"none"` is the one we want and the one that reads wrong: it means no API key was in play,
   * because a claude.ai OAuth login answered — the user's subscription. Anything else means a key
   * outranked it, which the user may not know they exported.
   */
  apiKeySource: string | null;
  /**
   * The tools and MCP servers the init message listed — what the model was SHOWN, deferred tools
   * included. Null when no init message arrived, which proves nothing and is treated that way.
   */
  surface: InitSurface | null;
}

/**
 * Runs one probe turn against a binary. The real implementation drives the Agent SDK's
 * `query()` in a temp directory with `settingSources: []`, no `allowedTools` (a bare entry
 * auto-approves the tool before the callback is consulted), and a `canUseTool` that denies the
 * shell tools, against a prompt that asks for a file to be created via a shell command.
 *
 * Injected rather than imported so this module's decision logic is testable without a
 * subscription, a network, or a 326MB binary.
 */
export type RunProbeTurn = (command: string) => Promise<ProbeTurnResult>;

export type ConfinementVerdict =
  | { ok: true; version: string | null; apiKeySource: string | null }
  | { ok: false; reason: string; version: string | null };

/** Shell-class tools the probe expects to be consulted about. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/**
 * The widest confinement a real session is given — an authoring agent with web research on — so
 * a surface that passes here passes for every role.
 */
export const PROBE_CONFINEMENT = confinementFor({ readOnly: false }, { web: true });

/**
 * What the probe offers: exactly what a session would be, plus the shell as bait. The shell is
 * the one addition, and it is there to be refused — the gate cannot be shown to work on a tool
 * nobody can ask for.
 */
export const PROBE_TOOLS: readonly string[] = [...offeredTools(PROBE_CONFINEMENT), ...SHELL_TOOLS];

/** A reason has to fit on a settings screen; thirty tool names do not. */
function nameSome(names: readonly string[]): string {
  const shown = names.slice(0, 4).join(", ");
  return names.length > 4 ? `${shown} and ${names.length - 4} more` : shown;
}

/**
 * Fail closed, always. Five ways this returns `ok: false`, and only two of them are the
 * dramatic ones:
 *
 * - the side effect happened — confinement is broken, the interesting case;
 * - the harness offered a tool Arke did not give it — a scheduler, a claude.ai connector, the
 *   tool-search tool that loads them. Some of these were measured never reaching the gate at
 *   all, so a gate that refuses the shell correctly says nothing about them. This is the check
 *   that would have caught the build offering CronCreate while Settings said "verified";
 * - no init message, so no tool list — nothing to compare, and nothing compared is no evidence;
 * - the gate was never consulted about a shell tool — we proved NOTHING, which is not the same
 *   as proving safety. A model that declines to try the shell (observed) leaves us with no
 *   evidence either way, and no evidence is a refusal;
 * - the turn threw — no auth, no network, timeout. Also no evidence.
 */
export async function probeConfinement(command: string, runTurn: RunProbeTurn): Promise<ConfinementVerdict> {
  let result: ProbeTurnResult;
  try {
    result = await runTurn(command);
  } catch (err) {
    return { ok: false, reason: `confinement probe could not run: ${String(err)}`, version: null };
  }

  if (result.deniedActionHappened) {
    return {
      ok: false,
      reason: "a denied shell command ran anyway — this build does not honour the tool gate",
      version: result.version,
    };
  }
  if (result.surface === null) {
    return {
      ok: false,
      reason: "the harness never said which tools it offered, so confinement is unproven",
      version: result.version,
    };
  }
  const unexpected = unexpectedSurface(result.surface, PROBE_TOOLS);
  if (unexpected.length > 0) {
    return {
      ok: false,
      reason: `it offers tools Arke Studio did not give it (${nameSome(unexpected)})`,
      version: result.version,
    };
  }
  if (!result.gateInvokedFor.some((tool) => SHELL_TOOLS.has(tool))) {
    return {
      ok: false,
      reason: "the tool gate was never consulted, so confinement is unproven",
      version: result.version,
    };
  }
  return { ok: true, version: result.version, apiKeySource: result.apiKeySource };
}

/**
 * Verdicts cached per binary AND per version, because the user's Claude Code auto-updates
 * underneath us — mine moved 2.1.177 to 2.1.235 mid-session without being asked. Keying on the
 * version the init message reported means an update invalidates the entry by construction
 * rather than by a TTL that has to guess how often people update.
 */
export class ConfinementCache {
  private readonly verdicts = new Map<string, ConfinementVerdict>();

  /**
   * Both halves, unambiguously. Concatenating with a separator invites a path that contains it
   * to collide two different binaries into one verdict, and a binary path is exactly the kind of
   * string that contains whatever you picked.
   */
  private key(command: string, version: string | null): string {
    return JSON.stringify([command, version]);
  }

  get(command: string, version: string | null): ConfinementVerdict | undefined {
    return this.verdicts.get(this.key(command, version));
  }

  /**
   * Probes unless this exact (binary, version) pair already has a verdict.
   *
   * `version` is what discovery read from `--version`; the verdict is stored under the version
   * the turn actually REPORTED, and under the discovered one too when they disagree. They can:
   * a binary that updates between the `--version` spawn and the probe turn would otherwise be
   * re-probed forever under a key nothing ever matches.
   */
  async ensure(command: string, version: string | null, runTurn: RunProbeTurn): Promise<ConfinementVerdict> {
    const cached = this.get(command, version);
    if (cached) return cached;
    const verdict = await probeConfinement(command, runTurn);
    this.verdicts.set(this.key(command, version), verdict);
    if (verdict.version !== version) {
      this.verdicts.set(this.key(command, verdict.version), verdict);
    }
    return verdict;
  }

  /** Drop everything — for a Settings change that repoints the binary. */
  clear(): void {
    this.verdicts.clear();
  }
}

/**
 * What authenticated the harness, in a line meant to be shown.
 *
 * The subscription case is the quiet one and the surprising one: Claude Code reports it as no API
 * key at all, because a claude.ai OAuth login is not a key. Everything else is worth saying out
 * loud — a stray `ANTHROPIC_API_KEY` in somebody's environment outranks their subscription
 * silently, and bills them per token for work they believed was already paid for.
 */
export function credentialSummary(apiKeySource: string | null): string {
  if (apiKeySource === null) return "credential unknown";
  if (apiKeySource === "none") return "your Claude subscription";
  if (apiKeySource === "ANTHROPIC_API_KEY") {
    return "an ANTHROPIC_API_KEY from the environment, not your subscription";
  }
  return `an API key (${apiKeySource}), not your subscription`;
}
