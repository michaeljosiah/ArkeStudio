import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { CommandResult, CommandRunner } from "./types.js";

/**
 * Finding and running the Higgsfield CLI (SPEC-008 §2.2). Higgsfield is the one gateway whose
 * credential is not ours: `higgsfield auth login` is an OAuth 2.0 PKCE flow with a loopback
 * callback, and the token it returns lives wherever the CLI puts it. So the provider's
 * "credential" is a binary being present and signed in, which is a discovery problem rather
 * than a credential-store one.
 *
 * Shaped after `packages/adapter-opencode/src/discovery.ts`, deliberately not shared with it:
 * the two packages have no dependency between them, and a discovery helper is small enough
 * that a cross-package import would cost more than the duplication.
 */

/**
 * The command is published under three names and the archive ships a fourth spelling: the
 * release tarball contains `hf.exe`, while the npm package installs `higgsfield`, `higgs` and
 * `hf` shims. Looking for only the documented name finds nothing on a machine that installed
 * from Releases.
 */
const COMMAND_ALIASES = ["higgsfield", "higgs", "hf"] as const;

export interface DiscoveredHiggsfield {
  /** Absolute path, spawnable as-is. */
  command: string;
  source: "configured" | "path" | "bundled";
  version: string | null;
}

/**
 * How long a probe may take before we call the CLI absent. `where` walks every PATH entry and
 * is the expensive one on a cold machine; ten seconds matches what OpenCode discovery allows,
 * and waiting is the better failure — the alternative is telling somebody the CLI they just
 * installed is missing because their machine was busy.
 */
const PROBE_TIMEOUT_MS = 10_000;

type RawRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>;

/**
 * Windows npm installs land a `.cmd` shim, which `execFile` cannot start directly — it is a
 * batch file, not an image. Route those through the command processor. Everything else is
 * spawned without a shell so no argument is ever re-parsed.
 */
const runRaw: RawRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const executable = shim ? (process.env["ComSpec"] ?? "cmd.exe") : command;
    const executableArgs = shim ? ["/d", "/c", "call", command, ...args] : [...args];
    let settled = false;
    const child = execFile(
      executable,
      executableArgs,
      // The catalogue listing runs to a few hundred kilobytes of JSON; the default 1 MB buffer
      // is close enough to that to be worth raising rather than discovering as a truncation.
      { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? null
              : 0;
        resolve({ code, stdout: stdout || "", stderr: stderr || (error ? String(error) : "") });
      },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (process.platform === "win32" && child.pid !== undefined) {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else {
        child.kill("SIGKILL");
      }
      resolve({ code: null, stdout: "", stderr: `higgsfield: no answer within ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
  });

/** `higgsfield version` prints "higgsfield 1.1.22 (<sha>) built <iso>". */
async function versionOf(command: string, run: RawRunner): Promise<string | null> {
  const result = await run(command, ["version"], PROBE_TIMEOUT_MS).catch(() => null);
  if (!result || result.code !== 0) return null;
  const line = result.stdout.trim().split("\n")[0] ?? "";
  const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(line);
  return match ? match[1]! : line || null;
}

/**
 * Resolve a PATH command to a spawnable absolute path. On Windows `where` returns every match,
 * and the extension-bearing entry is the one `child_process` can start.
 */
async function resolveOnPath(command: string, run: RawRunner): Promise<string | null> {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = await run(probe, [command], PROBE_TIMEOUT_MS).catch(() => null);
  if (!result || result.code !== 0) return null;
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

export interface HiggsfieldDiscoveryOptions {
  /** A path the user set in Settings; wins when it answers. */
  configuredPath?: string;
  /** Where the app puts a copy it fetched itself. */
  bundledPath?: string;
  /** Process seam, so tests need no CLI on the machine. */
  runCommand?: RawRunner;
}

/**
 * The CLI to drive, or null with nothing found. An installation already on PATH is preferred
 * over a copy we fetched: someone who ran `brew install` or `npm i -g` should not end up with
 * two, drifting apart at different versions.
 */
export async function discoverHiggsfield(
  opts: HiggsfieldDiscoveryOptions = {},
): Promise<DiscoveredHiggsfield | null> {
  const run = opts.runCommand ?? runRaw;
  if (opts.configuredPath && existsSync(opts.configuredPath)) {
    const version = await versionOf(opts.configuredPath, run);
    if (version !== null) return { command: opts.configuredPath, source: "configured", version };
  }
  for (const alias of COMMAND_ALIASES) {
    const fromPath = await resolveOnPath(alias, run);
    if (fromPath) return { command: fromPath, source: "path", version: await versionOf(fromPath, run) };
  }
  if (opts.bundledPath && existsSync(opts.bundledPath)) {
    return { command: opts.bundledPath, source: "bundled", version: await versionOf(opts.bundledPath, run) };
  }
  return null;
}

/** How long any one CLI call may take. Generation is polled, so no call here is long-running. */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/**
 * Bind a discovered command into the runner the client takes. The client never learns the path:
 * it composes arguments, and where the binary came from is this module's business.
 */
export function higgsfieldRunner(command: string, run: RawRunner = runRaw): CommandRunner {
  return (args, options) => run(command, args, options?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
}

/**
 * The runner to use when no CLI was found. Every call fails the same way, and the message is
 * the remedy rather than an ENOENT — an absent CLI must read as "Higgsfield is not set up on
 * this machine", never as the shot having failed (R-4).
 */
export function missingHiggsfieldRunner(): CommandRunner {
  return async () => ({
    code: null,
    stdout: "",
    stderr: "the Higgsfield CLI is not installed on this machine",
  });
}
