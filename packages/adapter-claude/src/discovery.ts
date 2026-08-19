import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Claude Code discovery for the bring-your-own harness.
 *
 * Deliberately unlike {@link @arke-studio/adapter-opencode}'s discovery in one respect: there
 * is no bundled candidate. OpenCode is MIT and ships inside the installer; Claude Code is
 * ~326MB under "© Anthropic PBC. All rights reserved", which is not ours to redistribute.
 * Absent means the harness is not offered — not that something failed.
 *
 * Two facts about the Agent SDK make that a decision we have to actively enforce, rather than
 * one we get for free:
 *
 * - The SDK DOES ship the binary, as per-platform `optionalDependencies`
 *   (`@anthropic-ai/claude-agent-sdk-win32-x64` and friends, ~312MB each). Depending on the SDK
 *   pulls one into `node_modules`, so packaging must exclude it explicitly or the installer
 *   quietly grows by 312MB and redistributes a proprietary binary.
 * - Left to itself the SDK runs THAT bundled copy and never falls back to PATH — hiding the
 *   platform package makes it throw "Native CLI binary for win32-x64 not found" rather than
 *   using the `claude` sitting on PATH. So driving the user's own installation means passing
 *   `pathToClaudeCodeExecutable` on every call. It is mandatory here, not a refinement.
 *
 * The version below is a PRE-FILTER, not the decision. `confinement-probe.ts` decides, per
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
 * The oldest build the confinement probe has actually been exercised against — NOT a version
 * known to be broken.
 *
 * An earlier reading of the spike data claimed 2.1.177 silently lacked the tool gate. That was
 * a measurement error: the probe prompt of the day ("run `echo hello` and tell me its output")
 * is answerable without calling any tool, so the callback never fired because nothing ever
 * asked for a tool, and prose-based detection then read the model's own echo of "hello" as
 * proof the shell had run. Against a prompt that demands a real side effect, every build tried
 * — 2.1.227, 2.1.229, 2.1.235 — consults the gate and honours the denial.
 *
 * So this floor buys very little, and is kept deliberately narrow: it skips a probe against
 * something older than anything we have ever verified, and nothing more. The probe is the
 * decision. If a user reports a build below this that works, lower it — there is no evidence
 * on the other side to weigh against them.
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
