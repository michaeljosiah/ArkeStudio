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
 * The v2 build floor. Beta versions are `0.0.0-next-<build>`, which no semver comparison
 * orders usefully, so the gate reads the build number. The floor is the build every wire
 * shape in the v2 backing was measured against (issue 327 §3); a binary older than the pin
 * is treated as absent, with the reason surfaced by the caller.
 */
export const OPENCODE2_MIN_BUILD = 17_444;

/** Whether a discovered v2 version satisfies the pinned-contract gate. */
export function meetsV2Gate(version: string | null, minBuild: number = OPENCODE2_MIN_BUILD): boolean {
  if (version === null) return false;
  const next = /next-(\d+)/.exec(version);
  if (next) return Number(next[1]) >= minBuild;
  // A stable release (2.x and beyond) postdates every next-build.
  const major = /^(\d+)\./.exec(version);
  return major !== null && Number(major[1]) >= 2;
}

/** Resolve the opencode2 to use — the gate is part of discovery, not a runtime probe. */
export async function discoverOpenCode2(
  opts: DiscoveryOptions & { minBuild?: number } = {},
): Promise<DiscoveredOpenCode | null> {
  const found = await discoverCommand("opencode2", opts);
  if (found === null) return null;
  if (!meetsV2Gate(found.version, opts.minBuild)) return null;
  return found;
}

export interface DiscoveredHarness {
  generation: "v2" | "v1";
  discovery: DiscoveredOpenCode;
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
  if (!opts.preferV1) {
    const v2 = await discoverOpenCode2(opts.v2 ?? {});
    if (v2) return { generation: "v2", discovery: v2 };
  }
  const v1 = await discoverOpenCode(opts.v1 ?? {});
  if (v1) return { generation: "v1", discovery: v1 };
  if (opts.preferV1) {
    const v2 = await discoverOpenCode2(opts.v2 ?? {});
    if (v2) return { generation: "v2", discovery: v2 };
  }
  return null;
}
