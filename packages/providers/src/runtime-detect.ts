import { statfs } from "node:fs/promises";
import { totalmem } from "node:os";
import { execFile } from "node:child_process";
import type { RuntimeProbes } from "@arke-studio/contracts";

/**
 * Local runtime probing (SPEC-008 §2.8, SPEC-033 §1.5): measure VRAM, memory, disk headroom and
 * what this machine can accelerate with. The judgement over the figures is `gateLocalRuntimes`
 * in @arke-studio/contracts — shared with the coordinator; this file is only the
 * platform-specific measuring. A failed probe returns null → unknown, never unavailable (D12).
 */

export interface ProbeDeps {
  /** Registry read for dedicated VRAM (Windows); injectable so tests need no GPU. */
  queryVramBytes?: () => Promise<number | null>;
  totalMemBytes?: () => number;
  diskFreeBytes?: (path: string) => Promise<number | null>;
  /**
   * What this machine can accelerate with. `null` means the probe could not answer; `[]` means
   * it answered and found none. Only the second refuses a model (SPEC-033 R-22), so the
   * implementations below return null wherever they would be guessing.
   */
  queryAccelerators?: () => Promise<string[] | null>;
  platform?: () => string;
}

/** The display-adapter class every Windows GPU registers under. */
const DISPLAY_CLASS_KEY =
  String.raw`HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*`;

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
        `(Get-ItemProperty -Path '${DISPLAY_CLASS_KEY}' -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize' | Sort-Object -Descending | Select-Object -First 1`,
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

/**
 * The display adapters this machine has, by driver description. The same registry class the
 * VRAM read uses, so one machine cannot report a card for one probe and none for the other.
 *
 * Vendor names rather than a driver capability query, because what a fit verdict asks is which
 * accelerator *family* a model would run on, and the description is the one string every
 * adapter publishes. An empty read is `null`, not `[]` — a Windows machine with no display
 * adapter at all is far less likely than a query that failed, and SPEC-033 R-22 forbids
 * refusing a model on a probe that did not answer.
 */
async function windowsAcceleratorNames(): Promise<string[] | null> {
  if (process.platform !== "win32") return null;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-ItemProperty -Path '${DISPLAY_CLASS_KEY}' -Name 'DriverDesc' -ErrorAction SilentlyContinue).DriverDesc`,
      ],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const lines = stdout
          .split(/\r?\n/)
          .map((line) => line.trim().toLowerCase())
          .filter((line) => line.length > 0);
        if (lines.length === 0) return resolve(null);
        const found = new Set<string>();
        for (const line of lines) {
          if (line.includes("nvidia") || line.includes("geforce") || line.includes("quadro")) found.add("cuda");
          // AMD's Windows compute stack is HIP/ROCm where it exists at all, and the driver
          // description is the only thing available to say which card is present.
          if (line.includes("amd") || line.includes("radeon")) found.add("rocm");
        }
        // Every Windows display adapter answers DirectML, Intel's integrated parts included, so
        // it is stated for any adapter that was read rather than inferred from a vendor name.
        found.add("directml");
        resolve([...found]);
      },
    );
  });
}

/** Apple's accelerator is the platform's, so there is nothing to detect and nothing to fail. */
async function acceleratorNames(): Promise<string[] | null> {
  if (process.platform === "darwin") return ["metal"];
  if (process.platform === "win32") return windowsAcceleratorNames();
  // Linux has no single read that answers this, and guessing would produce the one thing R-22
  // forbids: a refusal drawn from a probe nobody ran.
  return null;
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
  const accelerators = await (deps.queryAccelerators ?? acceleratorNames)().catch(() => null);
  return {
    vramMb: vramBytes === null ? null : Math.floor(vramBytes / (1024 * 1024)),
    memMb,
    diskFreeMb,
    accelerators,
    platform: (deps.platform ?? (() => process.platform))(),
  };
}
