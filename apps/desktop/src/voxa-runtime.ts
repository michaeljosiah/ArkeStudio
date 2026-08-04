import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { VoiceRuntimeFailure, VoiceRuntimeSource, VoxaSettings } from "@arke-studio/contracts";

export interface VoxaSelection {
  source: VoiceRuntimeSource;
  command: string | null;
  configured: boolean;
  bundledAvailable: boolean;
  executableName: string | null;
  warning: string | null;
  failure: VoiceRuntimeFailure | null;
}

export function executableArchitecture(path: string): "x64" | "arm64" | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const dos = Buffer.alloc(64);
    if (readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos[0] !== 0x4d || dos[1] !== 0x5a) return null;
    const pe = dos.readUInt32LE(0x3c);
    const header = Buffer.alloc(6);
    if (readSync(fd, header, 0, header.length, pe) !== header.length || header.toString("ascii", 0, 4) !== "PE\0\0") return null;
    const machine = header.readUInt16LE(4);
    if (machine === 0x8664) return "x64";
    if (machine === 0xaa64) return "arm64";
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return null;
}

export function validateVoxaExecutable(
  path: string,
  expectedArchitecture: "x64" | "arm64" | null,
): { ok: true } | { ok: false; category: VoiceRuntimeFailure; detail: string } {
  if (extname(path).toLowerCase() !== ".exe" || !existsSync(path)) {
    return { ok: false, category: "runtime-missing", detail: "The selected Voxa executable is missing." };
  }
  try {
    if (!statSync(path).isFile()) {
      return { ok: false, category: "runtime-missing", detail: "The selected Voxa executable is not a file." };
    }
  } catch {
    return { ok: false, category: "runtime-missing", detail: "The selected Voxa executable cannot be read." };
  }
  const actual = executableArchitecture(path);
  if (actual === null) {
    return { ok: false, category: "launch-failed", detail: "The selected file is not a supported Windows executable." };
  }
  if (expectedArchitecture !== null && actual !== expectedArchitecture) {
    return {
      ok: false,
      category: "architecture-mismatch",
      detail: `The selected Voxa executable is ${actual}; this Arke build requires ${expectedArchitecture}.`,
    };
  }
  return { ok: true };
}

export function selectVoxa(input: {
  settings: VoxaSettings;
  environmentPath?: string;
  bundledPath: string | null;
  expectedArchitecture: "x64" | "arm64" | null;
}): VoxaSelection {
  const { settings, environmentPath, bundledPath, expectedArchitecture } = input;
  const bundledAvailable = bundledPath !== null;
  if (environmentPath) {
    const validation = validateVoxaExecutable(environmentPath, expectedArchitecture);
    return {
      source: "environment",
      command: validation.ok ? environmentPath : null,
      configured: settings.executablePath !== null,
      bundledAvailable,
      executableName: basename(environmentPath),
      warning: validation.ok ? null : validation.detail,
      failure: validation.ok ? null : validation.category,
    };
  }
  if (settings.executablePath) {
    const validation = validateVoxaExecutable(settings.executablePath, expectedArchitecture);
    if (validation.ok) {
      return {
        source: "configured",
        command: settings.executablePath,
        configured: true,
        bundledAvailable,
        executableName: basename(settings.executablePath),
        warning: null,
        failure: null,
      };
    }
    if (bundledPath) {
      return {
        source: "bundled",
        command: bundledPath,
        configured: true,
        bundledAvailable: true,
        executableName: basename(bundledPath),
        warning: `${validation.detail} Arke fell back to bundled Voxa.`,
        failure: null,
      };
    }
    return {
      source: "absent",
      command: null,
      configured: true,
      bundledAvailable: false,
      executableName: null,
      warning: validation.detail,
      failure: validation.category,
    };
  }
  if (bundledPath) {
    return {
      source: "bundled",
      command: bundledPath,
      configured: false,
      bundledAvailable: true,
      executableName: basename(bundledPath),
      warning: null,
      failure: null,
    };
  }
  return {
    source: "absent",
    command: null,
    configured: false,
    bundledAvailable: false,
    executableName: null,
    warning: null,
    failure: "runtime-missing",
  };
}

export function environmentVoxaArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((arg) => typeof arg === "string") ? parsed : [];
  } catch {
    return [];
  }
}

const MANAGED_OPTIONS = new Set([
  "--host",
  "--port",
  "--kokoro-model",
  "--kokoro-config",
  "--kokoro-voices",
  "--whisper-model",
  "--espeak",
  "--espeak-data",
]);

/** Advanced arguments cannot replace Arke's loopback, port, model, or phonemizer contract. */
export function safeVoxaExtraArgs(args: string[]): string[] {
  const safe: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    const name = option.split("=", 1)[0]!.toLowerCase();
    if (!MANAGED_OPTIONS.has(name)) {
      safe.push(option);
      continue;
    }
    if (!option.includes("=") && args[index + 1] && !args[index + 1]!.startsWith("--")) index += 1;
  }
  return safe;
}
