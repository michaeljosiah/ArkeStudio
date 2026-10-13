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

/** Resolve the OpenCode v1 to use, or null with the honest reason. */
export async function discoverOpenCode(opts: DiscoveryOptions = {}): Promise<DiscoveredOpenCode | null> {
  // Stable v2 now also installs as `opencode`. Never send that server v1 requests.
  const { found } = await discoverGated(["opencode"], opts, version => version?.startsWith("1.") === true);
  return found;
}

/** Only the release qualified with Studio's adapter and bundle is supported. */
export const OPENCODE2_PINNED_VERSION = "2.0.26";

export function meetsV2Gate(version: string | null): boolean {
  return version === OPENCODE2_PINNED_VERSION;
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
  commands: readonly string[],
  opts: DiscoveryOptions,
  accept: (version: string | null) => boolean,
): Promise<GatedDiscovery> {
  const run = opts.runCommand ?? runCommand;
  let rejected: DiscoveredOpenCode | null = null;
  const consider = (candidate: DiscoveredOpenCode): DiscoveredOpenCode | null => {
    if (accept(candidate.version)) return candidate;
    // The shared `opencode` command may be v1; that is absence of v2, not a rejected v2 install.
    if (!candidate.version?.startsWith("1.")) rejected ??= candidate;
    return null;
  };
  if (opts.configuredPath && existsSync(opts.configuredPath)) {
    const version = await versionOf(opts.configuredPath, run);
    if (version !== null) {
      const hit = consider({ command: opts.configuredPath, source: "configured", version });
      if (hit) return { found: hit, rejected: null };
    }
  }
  for (const command of commands) {
    const fromPath = await resolveOnPath(command, run);
    if (fromPath) {
      const hit = consider({ command: fromPath, source: "path", version: await versionOf(fromPath, run) });
      if (hit) return { found: hit, rejected: null };
    }
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
  opts: DiscoveryOptions = {},
): Promise<DiscoveredOpenCode | null> {
  const { found } = await discoverGated(["opencode2", "opencode"], opts, meetsV2Gate);
  return found;
}

export interface DiscoveredHarness {
  generation: "v2" | "v1";
  discovery: DiscoveredOpenCode;
  /**
   * A v2 binary that answered but did not match the qualified release, when that is why v2 was not chosen.
   * Settings states it plainly ("found 2.0.25, need 2.0.26") instead of claiming
   * nothing is installed (SPEC-005 R-1).
   */
  rejectedV2?: DiscoveredOpenCode;
}

export interface PreferredHarnessDiscovery {
  found: DiscoveredHarness | null;
  /** Retained even when there is no launchable fallback, so absence and incompatibility stay distinct. */
  rejectedV2: DiscoveredOpenCode | null;
}

/**
 * Both binaries coexist by design; v2 wins unless Settings says otherwise (issue 327 §3).
 * The choice is a launch-time decision — it never changes under a running session.
 */
export async function discoverPreferredHarness(opts: {
  preferV1?: boolean;
  v1?: DiscoveryOptions;
  v2?: DiscoveryOptions;
} = {}): Promise<PreferredHarnessDiscovery> {
  const gate = meetsV2Gate;
  // Both lanes probe concurrently: each is a PATH walk plus a --version spawn (~300ms
  // typical, seconds on a loaded machine), the probes are independent, and this runs on the
  // visible boot path — serial probing charged every v1-only machine a failed v2 probe
  // before its own discovery even began.
  const [v2, v1] = await Promise.all([
    discoverGated(["opencode2", "opencode"], opts.v2 ?? {}, gate),
    discoverOpenCode(opts.v1 ?? {}),
  ]);
  const withReason = (result: DiscoveredHarness): DiscoveredHarness => ({
    ...result,
    ...(v2.rejected ? { rejectedV2: v2.rejected } : {}),
  });
  const found = !opts.preferV1 && v2.found ? { generation: "v2" as const, discovery: v2.found }
    : v1 ? withReason({ generation: "v1", discovery: v1 })
    : v2.found ? { generation: "v2" as const, discovery: v2.found } : null;
  return { found, rejectedV2: v2.rejected };
}
