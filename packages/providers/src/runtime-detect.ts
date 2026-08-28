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
  /**
   * The per-adapter read both figures above derive from when neither legacy dep is injected.
   * One read on purpose: VRAM and vendor read separately let a two-vendor machine marry the
   * Radeon's 24 GB to the GeForce's CUDA.
   */
  queryAdapters?: () => Promise<DetectedAdapter[] | null>;
  platform?: () => string;
}

/** One display adapter as the registry describes it. `vramBytes` null when the key was absent. */
export interface DetectedAdapter {
  description: string;
  vramBytes: number | null;
}

/** The display-adapter class every Windows GPU registers under. */
const DISPLAY_CLASS_KEY =
  String.raw`HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*`;

/**
 * Every display adapter, in one registry read — description and dedicated VRAM together.
 * `qwMemorySize` is the one figure that survives >4 GB adapters
 * (Win32_VideoController.AdapterRAM is a 32-bit lie), and reading it BESIDE the description
 * matters as much as reading it at all: two separate queries let a two-vendor machine report
 * the Radeon's memory and the GeForce's vendor as though they were one card.
 *
 * An empty read is `null`, not `[]` — a Windows machine with no display adapter at all is far
 * less likely than a query that failed, and SPEC-033 R-22 forbids refusing a model on a probe
 * that did not answer.
 */
async function windowsAdapters(): Promise<DetectedAdapter[] | null> {
  if (process.platform !== "win32") return null;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-ItemProperty -Path '${DISPLAY_CLASS_KEY}' -Name 'DriverDesc','HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.DriverDesc)\`t$($_.'HardwareInformation.qwMemorySize')" }`,
      ],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const adapters = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("\t"))
          .map((line) => {
            const [description = "", raw = ""] = line.split("\t");
            const value = Number.parseInt(raw.trim(), 10);
            return {
              description: description.trim(),
              vramBytes: Number.isFinite(value) && value > 0 ? value : null,
            };
          })
          .filter((adapter) => adapter.description.length > 0);
        resolve(adapters.length === 0 ? null : adapters);
      },
    );
  });
}

/**
 * Which accelerator *family* a fit verdict would ask about, from the driver description —
 * the one string every adapter publishes. AMD's Windows compute stack is HIP/ROCm where it
 * exists at all, and the description is the only thing available to say which card is present.
 */
function familiesOf(description: string): string[] {
  const line = description.toLowerCase();
  const found: string[] = [];
  if (line.includes("nvidia") || line.includes("geforce") || line.includes("quadro")) found.push("cuda");
  if (line.includes("amd") || line.includes("radeon")) found.push("rocm");
  return found;
}

/** Apple's accelerator is the platform's, so there is nothing to detect and nothing to fail. */
async function platformAdapters(): Promise<DetectedAdapter[] | null> {
  if (process.platform === "win32") return windowsAdapters();
  // Linux has no single read that answers this, and guessing would produce the one thing R-22
  // forbids: a refusal drawn from a probe nobody ran. Darwin is handled by name below.
  return null;
}

export async function probeRuntime(appRoot: string, deps: ProbeDeps = {}): Promise<RuntimeProbes> {
  /**
   * The adapter read powers three answers — total VRAM, per-family VRAM, accelerator names —
   * unless a legacy dep overrides one, in which case that answer comes from the override and
   * the per-family map is withheld: a map derived from a different read than the figures it
   * qualifies would reintroduce the disagreement it exists to end.
   */
  const adapters =
    deps.queryVramBytes || deps.queryAccelerators
      ? null
      : await (deps.queryAdapters ?? platformAdapters)().catch(() => null);
  const adapterVramBytes =
    adapters === null
      ? null
      : adapters.reduce<number | null>(
          (max, a) => (a.vramBytes === null ? max : Math.max(max ?? 0, a.vramBytes)),
          null,
        );
  const vramBytes = deps.queryVramBytes ? await deps.queryVramBytes().catch(() => null) : adapterVramBytes;
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
  const platform = (deps.platform ?? (() => process.platform))();
  let accelerators: string[] | null;
  if (deps.queryAccelerators) {
    accelerators = await deps.queryAccelerators().catch(() => null);
  } else if (platform === "darwin") {
    accelerators = ["metal"];
  } else if (adapters !== null) {
    const found = new Set(adapters.flatMap((a) => familiesOf(a.description)));
    // Every Windows display adapter answers DirectML, Intel's integrated parts included, so it
    // is stated for any adapter that was read rather than inferred from a vendor name.
    found.add("directml");
    accelerators = [...found];
  } else {
    accelerators = null;
  }
  /** Per-family dedicated VRAM, from the same read as the names — see the note on `adapters`. */
  let vramMbByAccelerator: Record<string, number> | null = null;
  if (adapters !== null) {
    vramMbByAccelerator = {};
    for (const adapter of adapters) {
      if (adapter.vramBytes === null) continue;
      const mb = Math.floor(adapter.vramBytes / (1024 * 1024));
      for (const family of familiesOf(adapter.description)) {
        vramMbByAccelerator[family] = Math.max(vramMbByAccelerator[family] ?? 0, mb);
      }
    }
    if (Object.keys(vramMbByAccelerator).length === 0) vramMbByAccelerator = null;
  }
  return {
    vramMb: vramBytes === null ? null : Math.floor(vramBytes / (1024 * 1024)),
    memMb,
    diskFreeMb,
    accelerators,
    ...(vramMbByAccelerator !== null ? { vramMbByAccelerator } : {}),
    platform,
  };
}
