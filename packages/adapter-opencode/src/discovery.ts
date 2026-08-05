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
 * Resolve a PATH command to a spawnable absolute path. On Windows, `where` returns every
 * match; the extension-bearing entry (.cmd/.exe) is the one child_process can start.
 */
async function resolveOnPath(command: string, run: CommandRunner): Promise<string | null> {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = await run(probe, [command], 5_000).catch(() => null);
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

/** Resolve the OpenCode to use, or null with the honest reason. */
export async function discoverOpenCode(opts: DiscoveryOptions = {}): Promise<DiscoveredOpenCode | null> {
  const run = opts.runCommand ?? runCommand;
  if (opts.configuredPath && existsSync(opts.configuredPath)) {
    const version = await versionOf(opts.configuredPath, run);
    if (version !== null) return { command: opts.configuredPath, source: "configured", version };
  }
  const fromPath = await resolveOnPath("opencode", run);
  if (fromPath) {
    return { command: fromPath, source: "path", version: await versionOf(fromPath, run) };
  }
  if (opts.bundledPath && existsSync(opts.bundledPath)) {
    return { command: opts.bundledPath, source: "bundled", version: await versionOf(opts.bundledPath, run) };
  }
  return null;
}
