import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HarnessAvailability } from "@arke-studio/contracts";
import { fileConfinementUnavailable } from "./confined-files.js";

/** First release verified with agents.enabled and direct image-capable dynamic tools (#1125). */
export const CODEX_MIN_VERSION = "0.154.0";
export interface DiscoveredCodex {
  command: string;
  args: string[];
  helper: string;
  source: "configured" | "path";
  version: string;
}
export interface CommandResult { status: number | null; stdout: string }
export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
export interface CodexDiscoveryOptions {
  configuredPath?: string;
  runCommand?: CommandRunner;
  exists?: (path: string) => Promise<boolean>;
}
export interface CodexDiscovery { found: DiscoveredCodex | null; reason: string | null; version: string | null }

const runCommand: CommandRunner = (command, args, timeoutMs) => new Promise(resolve => {
  execFile(command, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) => {
    resolve({ status: error ? null : 0, stdout: String(stdout) });
  });
});
const executable = async (path: string) => {
  try { await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return true; }
  catch { return false; }
};

export function meetsCodexFloor(version: string | null): boolean {
  const values = version?.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if (!values) return false;
  const minimum = CODEX_MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (values[i] !== minimum[i]) return values[i]! > minimum[i]!;
  return true;
}

/** Native executables only: shell shims would introduce another unowned process boundary. */
export function codexServerArgs(command: string): string[] {
  return /codex-app-server(?:[-.]|$)/i.test(basename(command))
    ? ["--listen", "stdio://"] : ["app-server", "--listen", "stdio://"];
}

export async function discoverCodex(opts: CodexDiscoveryOptions = {}): Promise<CodexDiscovery> {
  const confinementReason = await fileConfinementUnavailable();
  if (confinementReason) return { found: null, reason: confinementReason, version: null };
  const run = opts.runCommand ?? runCommand;
  const exists = opts.exists ?? executable;
  const candidates: { command: string; source: "configured" | "path" }[] = [];
  if (opts.configuredPath) candidates.push({ command: opts.configuredPath, source: "configured" });
  const paths = opts.configuredPath ? null : await run(process.platform === "win32" ? "where.exe" : "which", ["codex"], 5000).catch(() => null);
  if (paths?.status === 0) for (const command of paths.stdout.split(/\r?\n/).filter(Boolean)) {
    if (process.platform !== "win32" || /\.exe$/i.test(command)) candidates.push({ command: command.trim(), source: "path" });
  }
  let reason: string | null = null;
  let version: string | null = null;
  for (const candidate of candidates) {
    if (/\.(cmd|bat|ps1)$/i.test(candidate.command) || !await exists(candidate.command)) continue;
    const result = await run(candidate.command, ["--version"], 5000).catch(() => null);
    const reported = result?.status === 0 ? /(?:codex(?:-app-server|-cli)?\s+)?(\d+\.\d+\.\d+)(?:\s|$)/.exec(result.stdout.trim())?.[1] : undefined;
    if (!reported) { reason ??= "The selected Codex executable did not report a supported version."; continue; }
    version ??= reported;
    if (!meetsCodexFloor(reported)) { reason ??= `Codex ${reported} is installed, but ${CODEX_MIN_VERSION} or newer is needed.`; continue; }
    const command = await realpath(candidate.command).catch(() => candidate.command);
    const helper = join(dirname(command), `codex-code-mode-host${process.platform === "win32" ? ".exe" : ""}`);
    if (!await exists(helper)) { reason ??= "Codex needs its codex-code-mode-host helper beside the executable. Install the complete matching Codex release."; continue; }
    // The helper deliberately has no --version. Its co-location identifies the installation;
    // the opt-in protocol smoke verifies the pair, rather than inventing a version assertion.
    const help = await run(helper, ["--help"], 5000).catch(() => null);
    if (help?.status !== 0 || !help.stdout.includes("--listen")) { reason ??= "Codex's code-mode helper could not start. Reinstall the complete matching release."; continue; }
    return { found: { ...candidate, command, args: codexServerArgs(command), helper, version: reported }, reason: null, version: reported };
  }
  return { found: null, reason: reason ?? "Codex was not found on this machine.", version };
}

export async function describeCodexAvailability(opts: CodexDiscoveryOptions = {}): Promise<HarnessAvailability> {
  const result = await discoverCodex(opts);
  return { id: "codex", label: "Codex", bundled: false, installed: result.found !== null,
    version: result.found?.version ?? result.version, source: result.found?.source ?? null, blocked: result.reason };
}
