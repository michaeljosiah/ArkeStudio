import { execFile, spawn } from "node:child_process";
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

/**
 * Who the CLI is signed in as. `account status` is the probe rather than `auth token`, for the
 * same reason the client uses it: `auth token` prints the live token to stdout, and something
 * that only needs a yes or no should not be handling a secret to get one.
 */
export async function higgsfieldWhoAmI(
  command: string,
  run: RawRunner = runRaw,
): Promise<{ account: string | null }> {
  const result = await run(command, ["account", "status", "--json", "--no-color"], PROBE_TIMEOUT_MS);
  if (result.code !== 0) {
    const said = result.stderr.trim().split(/\r?\n/, 1)[0]?.trim();
    throw new Error(said && said.length > 0 ? said : "the Higgsfield CLI is not signed in");
  }
  try {
    const body = JSON.parse(result.stdout) as { email?: unknown };
    return { account: typeof body.email === "string" && body.email.length > 0 ? body.email : null };
  } catch {
    // Signed in, but the payload changed shape. That is not a reason to call it signed out.
    return { account: null };
  }
}

/**
 * How long a browser login may stay open before we stop waiting. The CLI's own wait defaults
 * to ten minutes; five is enough for a person who is actually at the machine, and a login left
 * open longer than that is one somebody walked away from. Stopping only stops *us* waiting —
 * the CLI, and the browser tab, are the user's to close.
 */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * Run `auth login` to completion. Nothing is scraped: the flow is OAuth 2.0 PKCE with a
 * loopback callback, so the credential arrives on a socket rather than on stdin, and the exit
 * code is the entire result. stdout is kept only to quote back a failure's first line, and is
 * never parsed — an output format we do not depend on cannot break us when it changes.
 *
 * The callback port is left unset on purpose. The CLI picks its default and falls back when
 * that port is taken, which is documented behaviour and strictly better than pinning one of
 * our own and then having to handle the same collision ourselves.
 */
export async function higgsfieldSignIn(
  command: string,
  signal: AbortSignal,
): Promise<{ code: number | null; detail: string | null }> {
  const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const executable = shim ? (process.env["ComSpec"] ?? "cmd.exe") : command;
  const args = ["auth", "login", "--no-color"];
  const executableArgs = shim ? ["/d", "/c", "call", command, ...args] : args;
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const child = spawn(executable, executableArgs, { windowsHide: true, shell: false });
    const done = (code: number | null, detail: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ code, detail });
    };
    const stop = () => {
      if (process.platform === "win32" && child.pid !== undefined) {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else {
        child.kill("SIGTERM");
      }
    };
    const onAbort = () => {
      stop();
      done(null, "sign-in cancelled");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      stop();
      done(null, "the sign-in was still waiting after five minutes");
    }, SIGN_IN_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (err) => done(null, err.message));
    child.on("exit", (code) => {
      const said = output.trim().split(/\r?\n/).filter(Boolean).pop()?.trim() ?? null;
      done(code, code === 0 ? null : said);
    });
  });
}
