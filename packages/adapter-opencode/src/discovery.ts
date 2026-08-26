import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * OpenCode discovery (SPEC-005 R-1, §2.2): a reachable configured path, then an installation
 * on PATH, then the bundled binary — and Settings names which is in use and at what version.
 *
 * Licence note (T-1, D11): OpenCode (sst/opencode) is MIT-licensed, which permits
 * redistribution in a signed installer with the copyright notice preserved. The bundling
 * itself is SPEC-016 work; this module only knows where a bundled copy would live.
 */

export interface DiscoveredOpenCode {
  command: string;
  source: "configured" | "path" | "bundled";
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

async function versionOf(command: string, run: CommandRunner): Promise<string | null> {
  const result = await run(command, ["--version"], 10_000).catch(() => null);
  if (!result || result.status !== 0) return null;
  const line = result.stdout.trim().split("\n")[0] ?? "";
  const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(line);
  return match ? match[1]! : line || null;
}

/**
 * How long a probe may take before we call it absent.
 *
 * A probe that runs out of time is indistinguishable from one that found nothing, so this budget
 * decides how slow a machine has to be before the app declares an installed OpenCode missing.
 * `where` walks every PATH entry and is the first process this module spawns, which on a cold or
 * loaded box is the expensive one: it measures ~300ms on a developer machine and has been seen
 * past 5s on a contended CI runner. Ten seconds matches the budget `versionOf` already allows,
 * and waiting is the better failure — the alternative is telling somebody their harness is not
 * installed because their machine was busy.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Resolve a PATH command to a spawnable absolute path. On Windows, `where` returns every
 * match; the extension-bearing entry (.cmd/.exe) is the one child_process can start.
 */
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
    const executable = lines.find((l) => /\.(exe|cmd|bat)$/i.test(l));
    return executable ?? lines[0]!;
  }
  return lines[0]!;
}

export interface DiscoveryOptions {
  /** A path the user configured in Settings; wins when it responds. */
  configuredPath?: string;
  /** Where the packaged app ships its bundled copy (SPEC-016). */
  bundledPath?: string;
  /** Process seam for deterministic timeout/non-blocking tests. */
  runCommand?: CommandRunner;
}

async function discoverCommand(
  command: string,
  opts: DiscoveryOptions,
): Promise<DiscoveredOpenCode | null> {
  const run = opts.runCommand ?? runCommand;
  if (opts.configuredPath && existsSync(opts.configuredPath)) {
    const version = await versionOf(opts.configuredPath, run);
    if (version !== null) return { command: opts.configuredPath, source: "configured", version };
  }
  const fromPath = await resolveOnPath(command, run);
  if (fromPath) {
    return { command: fromPath, source: "path", version: await versionOf(fromPath, run) };
  }
  if (opts.bundledPath && existsSync(opts.bundledPath)) {
    return { command: opts.bundledPath, source: "bundled", version: await versionOf(opts.bundledPath, run) };
  }
  return null;
}

/** Resolve the OpenCode v1 to use, or null with the honest reason. */
export async function discoverOpenCode(opts: DiscoveryOptions = {}): Promise<DiscoveredOpenCode | null> {
  return discoverCommand("opencode", opts);
}

/**
 * The v2 build floor. Prereleases are `0.0.0-<channel>-<build>`, which no semver comparison
 * orders usefully, so the gate reads the build number. The floor is the build every wire
 * shape in the v2 backing was measured against (issue 327 §3); a binary older than the pin
 * is treated as absent, with the reason surfaced by the caller.
 */
export const OPENCODE2_MIN_BUILD = 17_444;

/**
 * The prerelease channels the build number can be trusted from. Upstream renamed the channel
 * mid-beta — the pin is `0.0.0-next-17444`, while `beta` and `latest` now publish
 * `0.0.0-beta-<build>` — off ONE monotonic counter, so a channel name change must not read as
 * "older than the pin". Named rather than wildcarded because other channels number differently:
 * `0.0.0-tui-v2-202606261840` would clear any floor on a date-shaped build.
 *
 * Anchored end to end, and that is the whole point: a substring match reads the trusted name out
 * of an untrusted compound channel, so `0.0.0-tui-beta-202606261840` would pass the allowlist
 * built to exclude it. Only the complete shape counts as a channel.
 *
 * The `0.0.0` is literal too. The build counter belongs to that series and to nothing else, so a
 * prerelease of some other line — `1.18.0-beta-202606261840`, `0.1.0-dev-20000` — carries a
 * number this floor cannot read. Stable v2 arrives through the major check above, not here.
 */
const V2_BUILD_CHANNELS = /^0\.0\.0-(?:next|beta|dev)-(\d+)$/;

/** Whether a discovered v2 version satisfies the pinned-contract gate. */
export function meetsV2Gate(version: string | null, minBuild: number = OPENCODE2_MIN_BUILD): boolean {
  if (version === null) return false;
  // A stable release (2.x and beyond) postdates every prerelease build — and its own prereleases
  // ("2.0.0-next-3") restart the build counter, so the major check must run FIRST or the
  // channel branch below rejects a current binary as older than the beta pin.
  const major = /^(\d+)\./.exec(version);
  if (major && Number(major[1]) >= 2) return true;
  const build = V2_BUILD_CHANNELS.exec(version);
  return build !== null && Number(build[1]) >= minBuild;
}

interface GatedDiscovery {
  found: DiscoveredOpenCode | null;
  /** The best candidate that answered but failed the gate — the honest reason (SPEC-005 R-1). */
  rejected: DiscoveredOpenCode | null;
}

/**
 * The gate applies per candidate, INSIDE the ladder: a stale configured path must fall
 * through to a current binary on PATH, not null the whole discovery — "configured wins when
 * it responds" was never meant to mean "a stale configured entry hides every other install".
 */
async function discoverGated(
  command: string,
  opts: DiscoveryOptions,
  accept: (version: string | null) => boolean,
): Promise<GatedDiscovery> {
  const run = opts.runCommand ?? runCommand;
  let rejected: DiscoveredOpenCode | null = null;
  const consider = (candidate: DiscoveredOpenCode): DiscoveredOpenCode | null => {
    if (accept(candidate.version)) return candidate;
    rejected ??= candidate;
    return null;
  };
  if (opts.configuredPath && existsSync(opts.configuredPath)) {
    const version = await versionOf(opts.configuredPath, run);
    if (version !== null) {
      const hit = consider({ command: opts.configuredPath, source: "configured", version });
      if (hit) return { found: hit, rejected: null };
    }
  }
  const fromPath = await resolveOnPath(command, run);
  if (fromPath) {
    const hit = consider({ command: fromPath, source: "path", version: await versionOf(fromPath, run) });
    if (hit) return { found: hit, rejected: null };
  }
  if (opts.bundledPath && existsSync(opts.bundledPath)) {
    const hit = consider({
      command: opts.bundledPath,
      source: "bundled",
      version: await versionOf(opts.bundledPath, run),
    });
    if (hit) return { found: hit, rejected: null };
  }
  return { found: null, rejected };
}

/** Resolve the opencode2 to use — the gate is part of discovery, not a runtime probe. */
export async function discoverOpenCode2(
  opts: DiscoveryOptions & { minBuild?: number } = {},
): Promise<DiscoveredOpenCode | null> {
  const { found } = await discoverGated("opencode2", opts, (v) => meetsV2Gate(v, opts.minBuild));
  return found;
}

export interface DiscoveredHarness {
  generation: "v2" | "v1";
  discovery: DiscoveredOpenCode;
  /**
   * A v2 binary that answered but failed the build gate, when that is why v2 was not chosen.
   * Settings states it plainly ("found 0.0.0-next-17400, need ≥17444") instead of claiming
   * nothing is installed (SPEC-005 R-1).
   */
  rejectedV2?: DiscoveredOpenCode;
}

/**
 * Both binaries coexist by design; v2 wins unless Settings says otherwise (issue 327 §3).
 * The choice is a launch-time decision — it never changes under a running session.
 */
export async function discoverPreferredHarness(opts: {
  preferV1?: boolean;
  v1?: DiscoveryOptions;
  v2?: DiscoveryOptions & { minBuild?: number };
} = {}): Promise<DiscoveredHarness | null> {
  const gate = (v: string | null) => meetsV2Gate(v, opts.v2?.minBuild);
  // Both lanes probe concurrently: each is a PATH walk plus a --version spawn (~300ms
  // typical, seconds on a loaded machine), the probes are independent, and this runs on the
  // visible boot path — serial probing charged every v1-only machine a failed v2 probe
  // before its own discovery even began.
  const [v2, v1] = await Promise.all([
    discoverGated("opencode2", opts.v2 ?? {}, gate),
    discoverOpenCode(opts.v1 ?? {}),
  ]);
  const withReason = (result: DiscoveredHarness): DiscoveredHarness => ({
    ...result,
    ...(v2.rejected ? { rejectedV2: v2.rejected } : {}),
  });
  if (!opts.preferV1 && v2.found) return { generation: "v2", discovery: v2.found };
  if (v1) return withReason({ generation: "v1", discovery: v1 });
  if (opts.preferV1 && v2.found) return { generation: "v2", discovery: v2.found };
  return null;
}
