import { existsSync } from "node:fs";
import { join } from "node:path";
import { GpuMeasurementSchema, type GpuMeasurement } from "@arke-studio/contracts";
import { SetupProcessRunner, type ChildLedger } from "@arke-studio/coordinator";

export function parseNvidiaReadings(stdout: string, measuredAt: number): GpuMeasurement {
  const rows = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!rows.length || rows.length > 8) throw new Error("Unsupported GPU response.");
  const number = (text: string | undefined): number | null => text !== undefined && /^\d+(?:\.\d+)?$/.test(text.trim()) ? Number(text.trim()) : null;
  const value = rows.map((row, index) => {
    const fields = row.split(","); if (fields.length !== 3) throw new Error("Invalid GPU response.");
    const utilisation = number(fields[0]), used = number(fields[1]), total = number(fields[2]);
    return { index, utilisation, usedBytes: used === null ? null : Math.round(used * 1024 ** 2), totalBytes: total === null ? null : Math.round(total * 1024 ** 2) };
  });
  if (value.every(row => row.utilisation === null && row.usedBytes === null && row.totalBytes === null)) throw new Error("GPU counters unavailable.");
  return GpuMeasurementSchema.parse({ source: "nvidia-smi", state: "measured", measuredAt, value });
}

type OwnedReader = Pick<SetupProcessRunner, "running" | "run" | "confirmCleanup" | "dispose">;
/** Fixed native reader uses the existing gated job/parent leash/ledger executor. Failed cleanup
 * retains its owner; no new read starts until that same owner confirms cleanup. */
export function createDesktopGpuProbe(deps: { platform?: string; env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean;
  runner?: OwnedReader; ledger?: ChildLedger; now?: () => number; timeoutMs?: number } = {}): ((signal: AbortSignal) => Promise<GpuMeasurement>) & { dispose(): Promise<void> } {
  const env = deps.env ?? process.env, exists = deps.exists ?? existsSync;
  const candidates = (deps.platform ?? process.platform) === "win32"
    ? [env.SystemRoot && join(env.SystemRoot, "System32", "nvidia-smi.exe"), env.ProgramW6432 && join(env.ProgramW6432, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe")]
    : (deps.platform ?? process.platform) === "linux" ? ["/usr/bin/nvidia-smi"] : [];
  const executable = candidates.find((path): path is string => !!path && exists(path));
  const runner = deps.runner ?? (executable ? new SetupProcessRunner({ ledger: deps.ledger, ledgerId: "system-probe", cleanupTimeoutMs: 2_000, readyTimeoutMs: 3_000 }) : null);
  let disposed = false;
  const probe = async (signal: AbortSignal): Promise<GpuMeasurement> => {
    const unavailable: GpuMeasurement = { source: "nvidia-smi", state: runner ? "unavailable" : "unsupported", measuredAt: null, value: null };
    if (!runner || disposed || signal.aborted) return unavailable;
    const output = new AbortController(), bounded = AbortSignal.any([signal, output.signal, AbortSignal.timeout(deps.timeoutMs ?? 6_000)]);
    try {
      if (runner.running) await runner.confirmCleanup();
      bounded.throwIfAborted();
      let seen = 0;
      const result = await runner.run(executable ?? "injected-owned-reader", ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], bounded,
        text => { seen += Buffer.byteLength(text); if (seen > 8192) output.abort(); });
      if (result.code !== 0 || bounded.aborted) return unavailable;
      return parseNvidiaReadings(result.output, (deps.now ?? Date.now)());
    } catch { return unavailable; }
  };
  return Object.assign(probe, { async dispose() { disposed = true; await runner?.dispose(); } });
}
