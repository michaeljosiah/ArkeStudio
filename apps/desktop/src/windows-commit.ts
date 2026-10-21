import { execFile } from "node:child_process";
import { WindowsCommitValuesSchema, type WindowsCommitSnapshot } from "@arke-studio/contracts";

const QUERY = "$ErrorActionPreference='Stop'; $m=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -OperationTimeoutSec 3; " +
  "[pscustomobject]@{committedBytes=$m.CommittedBytes;limitBytes=$m.CommitLimit;physicalAvailableBytes=$m.AvailableBytes} | ConvertTo-Json -Compress";

function queryWindowsCommit(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", QUERY],
      { windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/** This is a bounded read, never paging configuration or a generation admission threshold.
 * Concurrent readiness readers share the process; every completed refresh gets a new attempt. */
export function createWindowsCommitProbe(deps: {
  platform?: string;
  query?: () => Promise<string>;
  now?: () => string;
} = {}): (() => Promise<WindowsCommitSnapshot>) | undefined {
  if ((deps.platform ?? process.platform) !== "win32") return undefined;
  let pending: Promise<WindowsCommitSnapshot> | null = null;
  return () => {
    if (pending !== null) return pending;
    pending = (async (): Promise<WindowsCommitSnapshot> => {
      let values: WindowsCommitSnapshot["values"] = null;
      try { values = WindowsCommitValuesSchema.parse(JSON.parse(await (deps.query ?? queryWindowsCommit)())); }
      catch { /* A failed or malformed measurement is unknown, never a physical-RAM fallback. */ }
      return { source: "windows-performance-memory", measuredAt: (deps.now ?? (() => new Date().toISOString()))(), values };
    })().finally(() => { pending = null; });
    return pending;
  };
}
