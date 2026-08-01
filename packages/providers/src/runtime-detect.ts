import { statfs } from "node:fs/promises";
import { totalmem } from "node:os";
import { execFile } from "node:child_process";
import type { RuntimeProbes } from "@arke-studio/contracts";

/**
 * Local runtime probing (SPEC-008 §2.8, R-22): measure VRAM, memory and disk headroom. The
 * judgement over the figures is `gateLocalRuntimes` in @arke-studio/contracts — shared with
 * the coordinator; this file is only the platform-specific measuring. A failed probe returns
 * null → unknown, never unavailable (D12).
 */

export interface ProbeDeps {
  /** Registry read for dedicated VRAM (Windows); injectable so tests need no GPU. */
  queryVramBytes?: () => Promise<number | null>;
  totalMemBytes?: () => number;
  diskFreeBytes?: (path: string) => Promise<number | null>;
}

/**
 * Dedicated VRAM from the display-class registry keys — `qwMemorySize` is the one figure
 * that survives >4 GB adapters (Win32_VideoController.AdapterRAM is a 32-bit lie).
 */
async function windowsVramBytes(): Promise<number | null> {
  if (process.platform !== "win32") return null;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`(Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*' -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize' | Sort-Object -Descending | Select-Object -First 1`,
      ],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const value = Number.parseInt(stdout.trim(), 10);
        resolve(Number.isFinite(value) && value > 0 ? value : null);
      },
    );
  });
}

export async function probeRuntime(appRoot: string, deps: ProbeDeps = {}): Promise<RuntimeProbes> {
  const vramBytes = await (deps.queryVramBytes ?? windowsVramBytes)().catch(() => null);
  let memMb: number | null = null;
  try {
    memMb = Math.floor((deps.totalMemBytes ?? totalmem)() / (1024 * 1024));
  } catch {
    memMb = null;
  }
  let diskFreeMb: number | null = null;
  try {
    const free = deps.diskFreeBytes
      ? await deps.diskFreeBytes(appRoot)
      : await statfs(appRoot).then((s) => s.bavail * s.bsize);
    diskFreeMb = free === null ? null : Math.floor(free / (1024 * 1024));
  } catch {
    diskFreeMb = null;
  }
  return { vramMb: vramBytes === null ? null : Math.floor(vramBytes / (1024 * 1024)), memMb, diskFreeMb };
}
