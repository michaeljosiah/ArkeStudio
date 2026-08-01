import { spawnSync } from "node:child_process";
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

function versionOf(command: string): string | null {
  try {
    const result = spawnSync(command, ["--version"], {
      timeout: 10_000,
      encoding: "utf8",
      shell: process.platform === "win32", // .cmd shims need the shell
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    const line = (result.stdout || "").trim().split("\n")[0] ?? "";
    const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(line);
    return match ? match[1]! : line || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a PATH command to a spawnable absolute path. On Windows, `where` returns every
 * match; the extension-bearing entry (.cmd/.exe) is the one child_process can start.
 */
function resolveOnPath(command: string): string | null {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(probe, [command], { timeout: 5_000, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) return null;
    const lines = (result.stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    if (process.platform === "win32") {
      const executable = lines.find((l) => /\.(exe|cmd|bat)$/i.test(l));
      return executable ?? lines[0]!;
    }
    return lines[0]!;
  } catch {
    return null;
  }
}

export interface DiscoveryOptions {
  /** A path the user configured in Settings; wins when it responds. */
  configuredPath?: string;
  /** Where the packaged app ships its bundled copy (SPEC-016). */
  bundledPath?: string;
}

/** Resolve the OpenCode to use, or null with the honest reason. */
export function discoverOpenCode(opts: DiscoveryOptions = {}): DiscoveredOpenCode | null {
  if (opts.configuredPath && existsSync(opts.configuredPath)) {
    const version = versionOf(opts.configuredPath);
    if (version !== null) return { command: opts.configuredPath, source: "configured", version };
  }
  const fromPath = resolveOnPath("opencode");
  if (fromPath) {
    return { command: fromPath, source: "path", version: versionOf(fromPath) };
  }
  if (opts.bundledPath && existsSync(opts.bundledPath)) {
    return { command: opts.bundledPath, source: "bundled", version: versionOf(opts.bundledPath) };
  }
  return null;
}
