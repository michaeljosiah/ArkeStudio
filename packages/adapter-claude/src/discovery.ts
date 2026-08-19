import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Claude Code discovery for the bring-your-own harness.
 *
 * Deliberately unlike {@link @arke-studio/adapter-opencode}'s discovery in one respect: there
 * is no bundled candidate and there never will be. OpenCode is MIT and ships inside the
 * installer; Claude Code is a ~326MB proprietary binary that is not ours to redistribute, and
 * the Agent SDK is a ~1.3MB client that spawns whatever the user already installed. Absent
 * means the harness is not offered — not that something failed.
 *
 * The version here is a PRE-FILTER, not the decision. A build that clears the floor may still
 * have no working confinement, so `confinement-probe.ts` is what actually decides. See
 * SPEC-005 R-2: capabilities are probed, never assumed from a version number.
 */

export interface DiscoveredClaude {
  command: string;
  /** No "bundled" — see the module note. */
  source: "configured" | "path";
  version: string | null;
}

interface CommandResult {
  status: number | null;
  stdout: string;
}

type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

const runCommand: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const executable = shim ? (process.env["ComSpec"] ?? "cmd.exe") : command;
    const executableArgs = shim ? ["/d", "/c", "call", command, ...args] : args;
    let settled = false;
    const child = execFile(executable, executableArgs, { encoding: "utf8", windowsHide: true }, (error, stdout) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code =
        error && typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : error
            ? null
            : 0;
      resolve({ status: code, stdout: stdout || "" });
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (process.platform === "win32" && child.pid !== undefined) {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else {
        child.kill("SIGKILL");
      }
      resolve({ status: null, stdout: "" });
    }, timeoutMs);
    timer.unref?.();
  });

const PROBE_TIMEOUT_MS = 10_000;

/** `claude --version` prints e.g. `2.1.235 (Claude Code)`. */
async function versionOf(command: string, run: CommandRunner): Promise<string | null> {
  const result = await run(command, ["--version"], PROBE_TIMEOUT_MS).catch(() => null);
  if (!result || result.status !== 0) return null;
  const line = result.stdout.trim().split("\n")[0] ?? "";
  const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(line);
  return match ? match[1]! : null;
}

async function resolveOnPath(command: string, run: CommandRunner): Promise<string | null> {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = await run(probe, [command], PROBE_TIMEOUT_MS).catch(() => null);
  if (!result || result.status !== 0) return null;
  const lines = result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  if (process.platform === "win32") {
    // The native installer drops an extension-less `claude` alongside any .exe/.cmd shim;
    // both are spawnable, but prefer the extension-bearing one as child_process does.
    return lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) ?? lines[0]!;
  }
  return lines[0]!;
}

/**
 * The measured-good floor, NOT the true minimum.
 *
 * On Claude Code 2.1.177 the `canUseTool` callback was never invoked and shell commands ran
 * unblocked — no error, no warning, confinement simply absent. On 2.1.227, 2.1.229 and 2.1.235
 * the gate fires and holds. The real boundary is somewhere in 2.1.178–2.1.227 and was not
 * bisected, so this pins the oldest build actually observed working rather than a guess.
 *
 * Raising this is safe. Lowering it needs a measurement, not an assumption.
 */
export const CLAUDE_MIN_VERSION = "2.1.227";

/** Numeric compare of the leading `x.y.z`; a prerelease suffix is ignored, never ordered. */
export function meetsClaudeFloor(version: string | null, min: string = CLAUDE_MIN_VERSION): boolean {
  if (version === null) return false;
  const parse = (v: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const got = parse(version);
  const want = parse(min);
  if (!got || !want) return false;
  for (let i = 0; i < 3; i += 1) {
    if (got[i]! !== want[i]!) return got[i]! > want[i]!;
  }
  return true;
}

export interface ClaudeDiscoveryOptions {
  /** A path the user set in Settings; wins when it answers AND clears the floor. */
  configuredPath?: string;
  /** Process seam for deterministic tests. */
  runCommand?: CommandRunner;
  minVersion?: string;
}

export interface ClaudeDiscovery {
  found: DiscoveredClaude | null;
  /**
   * A binary that answered but is below the floor — the honest reason, so Settings can say
   * "found 2.1.177, need ≥2.1.227" instead of claiming Claude Code is not installed
   * (SPEC-005 R-1, R-4).
   */
  rejected: DiscoveredClaude | null;
}

/**
 * Configured path, then PATH. The floor applies per candidate INSIDE the ladder, so a stale
 * configured entry falls through to a current binary on PATH rather than hiding it — the same
 * correction the OpenCode ladder carries.
 */
export async function discoverClaudeCode(opts: ClaudeDiscoveryOptions = {}): Promise<ClaudeDiscovery> {
  const run = opts.runCommand ?? runCommand;
  const accept = (v: string | null) => meetsClaudeFloor(v, opts.minVersion);
  let rejected: DiscoveredClaude | null = null;

  const consider = (candidate: DiscoveredClaude): DiscoveredClaude | null => {
    if (accept(candidate.version)) return candidate;
    // Only a binary that ANSWERED is a rejection worth reporting; one that never ran is absence.
    if (candidate.version !== null) rejected ??= candidate;
    return null;
  };

  if (opts.configuredPath && existsSync(opts.configuredPath)) {
    const version = await versionOf(opts.configuredPath, run);
    if (version !== null) {
      const hit = consider({ command: opts.configuredPath, source: "configured", version });
      if (hit) return { found: hit, rejected: null };
    }
  }

  const fromPath = await resolveOnPath("claude", run);
  if (fromPath) {
    const hit = consider({ command: fromPath, source: "path", version: await versionOf(fromPath, run) });
    if (hit) return { found: hit, rejected: null };
  }

  return { found: null, rejected };
}
