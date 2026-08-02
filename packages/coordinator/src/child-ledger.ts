import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "./world/atomic.js";

/**
 * Pidfile ledger for supervised children (SPEC-001 R-5: never leave an orphan).
 *
 * The Job Object leash ties child lifetime to the parent at the kernel; this ledger is the
 * fallback for the runs where the leash could not attach (PowerShell blocked, races) and for
 * orphans that predate it. Every spawn is recorded, every exit released, and the next
 * startup sweeps the file: a recorded child whose owner is gone is an orphan and is killed.
 *
 * PIDs are recycled aggressively on Windows, so a bare pid is never trusted. An owner only
 * counts as alive when the process behind its pid also started when the owner did; a child
 * is only killed when the process behind its pid still bears the recorded image name and
 * started when the record was made. When identity cannot be established the sweep leaves
 * the process alone — a leaked child is a nuisance, killing a stranger's process is not.
 */

export interface ChildRecord {
  /** The supervised child's pid. */
  pid: number;
  /** Child image name (exe basename, lowercased) — the identity guard before any kill. */
  image: string;
  /** Supervisor id ("opencode", "voxa") for reporting. */
  id: string;
  ownerPid: number;
  /** Owner's start time (epoch ms) — distinguishes the owner from a pid-reuse impostor. */
  ownerStartedAt: number;
  /** When the record was made (epoch ms) — immediately after spawn, so ≈ child start. */
  recordedAt: number;
  /**
   * For a grandchild found behind a shell-shim wrapper: the wrapper's recorded pid.
   * Lineage metadata only — the sweep treats every record the same way.
   */
  parentPid?: number;
}

export interface ProcessInfo {
  pid: number;
  /** Image/command name as the OS reports it, lowercased. */
  image: string;
  /** Start time (epoch ms), or null when the OS would not say. */
  startedAt: number | null;
}

/** Resolve live-process info for `pids`; missing pids are simply absent from the map. */
export type ProcessProbe = (pids: number[]) => Promise<Map<number, ProcessInfo>>;

export interface ReapReport {
  /** Records whose child was verified ours and killed. */
  reaped: ChildRecord[];
  /** Records kept because their owner is still alive. */
  kept: number;
  /** Records dropped without a kill: the child was already gone or its pid was reused. */
  cleared: number;
  /** Set when the sweep could not probe processes and therefore touched nothing. */
  skipped?: string;
}

/** An owner probed within this of its recorded start is the same process, not a reused pid. */
export const OWNER_START_TOLERANCE_MS = 15_000;
/** A child probed within this of its record time is the recorded child, not a reused pid. */
export const CHILD_START_TOLERANCE_MS = 60_000;

/** The recording process's identity stamp; recorded so a later sweep can tell it is dead. */
export function ownerStamp(): { ownerPid: number; ownerStartedAt: number } {
  return {
    ownerPid: process.pid,
    ownerStartedAt: Math.round(Date.now() - process.uptime() * 1000),
  };
}

const validPids = (pids: number[]): number[] =>
  [...new Set(pids)].filter((p) => Number.isSafeInteger(p) && p > 0);

/** One CIM query for the whole batch; name and creation time back the pid-reuse guards. */
async function probeWin32(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const filter = pids.map((p) => `ProcessId=${p}`).join(" OR ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$rows = @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object {`,
    "  [pscustomobject]@{ p = [int]$_.ProcessId; n = [string]$_.Name; s = if ($_.CreationDate) { ([System.DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null } }",
    "})",
    "ConvertTo-Json -Compress -InputObject $rows",
  ].join("\n");
  const stdout = await runCollect(
    powershellPath(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  );
  const rows = JSON.parse(stdout.trim() === "" ? "[]" : stdout) as { p: number; n: string; s: number | null }[];
  return new Map(rows.map((r) => [r.p, { pid: r.p, image: r.n.toLowerCase(), startedAt: r.s ?? null }]));
}

/** `ps` speaks pid, elapsed seconds, and command name on both Linux and macOS. */
async function probePosix(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const now = Date.now();
  // ps exits non-zero when any pid is absent; absence is an answer here, not a failure.
  const stdout = await runCollect("ps", ["-o", "pid=,etimes=,comm=", "-p", pids.join(",")], { okCodes: [0, 1] });
  const map = new Map<number, ProcessInfo>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const comm = m[3]!.trim();
    const base = comm.slice(comm.lastIndexOf("/") + 1).toLowerCase();
    map.set(Number(m[1]), { pid: Number(m[1]), image: base, startedAt: now - Number(m[2]) * 1000 });
  }
  return map;
}

function powershellPath(): string {
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function runCollect(
  command: string,
  args: string[],
  opts: { okCodes?: number[] } = {},
): Promise<string> {
  const okCodes = opts.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    child.once("error", (e) => reject(e));
    child.once("exit", (code) => {
      if (code !== null && okCodes.includes(code)) resolve(out);
      else reject(new Error(`${command} exited ${code}${err ? `: ${err.trim().split("\n", 1)[0]}` : ""}`));
    });
  });
}

export const platformProbe: ProcessProbe = async (pids) => {
  const valid = validPids(pids);
  if (valid.length === 0) return new Map();
  return process.platform === "win32" ? probeWin32(valid) : probePosix(valid);
};

export interface DescendantInfo extends ProcessInfo {
  parentPid: number;
}

/**
 * Live descendants of `rootPid`, transitively. taskkill /T can only walk a tree whose root
 * is still alive; this snapshot is what lets a stop or sweep reach the grandchildren after
 * the wrapper between them has died. Windows-only — elsewhere there is no shell shim and no
 * wrapper, so the answer is always empty. Throws when the process table cannot be read.
 */
export async function listDescendants(rootPid: number): Promise<DescendantInfo[]> {
  if (process.platform !== "win32") return [];
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return [];
  // One query for the whole table; ParentProcessId is not filterable transitively in CIM,
  // so the tree walk happens here. Dead parents keep their pid in ParentProcessId, which is
  // exactly what makes orphaned grandchildren findable.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$rows = @(Get-CimInstance Win32_Process | ForEach-Object {",
    "  [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; n = [string]$_.Name; s = if ($_.CreationDate) { ([System.DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null } }",
    "})",
    "ConvertTo-Json -Compress -InputObject $rows",
  ].join("\n");
  const stdout = await runCollect(
    powershellPath(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  );
  const rows = JSON.parse(stdout.trim() === "" ? "[]" : stdout) as { p: number; pp: number; n: string; s: number | null }[];
  const byParent = new Map<number, typeof rows>();
  for (const row of rows) {
    const siblings = byParent.get(row.pp);
    if (siblings) siblings.push(row);
    else byParent.set(row.pp, [row]);
  }
  const found: DescendantInfo[] = [];
  const visited = new Set<number>([rootPid]);
  const queue = [rootPid];
  // Recycled pids can make the parent graph cyclic; the visited set keeps the walk finite.
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const row of byParent.get(pid) ?? []) {
      if (visited.has(row.p)) continue;
      visited.add(row.p);
      found.push({ pid: row.p, parentPid: row.pp, image: row.n.toLowerCase(), startedAt: row.s ?? null });
      queue.push(row.p);
    }
  }
  return found;
}

/** Force-kill the whole tree under `pid` — grandchildren orphan on Windows otherwise. */
export async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await runCollect("taskkill", ["/pid", String(pid), "/T", "/F"], { okCodes: [0, 128, 255, 1] }).catch(() => "");
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export interface ChildLedgerDeps {
  probe?: ProcessProbe;
  kill?: (pid: number) => Promise<void>;
}

export class ChildLedger {
  private readonly probe: ProcessProbe;
  private readonly kill: (pid: number) => Promise<void>;
  /** All file access is funnelled through one chain — two supervisors share one ledger. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    deps: ChildLedgerDeps = {},
  ) {
    this.probe = deps.probe ?? platformProbe;
    this.kill = deps.kill ?? killTree;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async read(): Promise<ChildRecord[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as { children?: unknown };
      if (!Array.isArray(parsed.children)) return [];
      return parsed.children.filter(
        (c): c is ChildRecord =>
          typeof c === "object" && c !== null && Number.isSafeInteger((c as ChildRecord).pid),
      );
    } catch {
      // Absent or corrupt: an empty ledger, rebuilt by the next record. Never fatal (R-5
      // cleanup must not stop the app from starting).
      return [];
    }
  }

  private async write(children: ChildRecord[]): Promise<void> {
    await atomicWriteFile(this.path, JSON.stringify({ children }, null, 2) + "\n");
  }

  /** Record a freshly spawned child. Call immediately after spawn so recordedAt ≈ start. */
  record(rec: ChildRecord): Promise<void> {
    return this.enqueue(async () => {
      const children = await this.read();
      await this.write([...children.filter((c) => c.pid !== rec.pid), rec]);
    });
  }

  /** Drop a child that exited under supervision — nothing left to reap. */
  release(pid: number): Promise<void> {
    return this.enqueue(async () => {
      const children = await this.read();
      if (!children.some((c) => c.pid === pid)) return;
      await this.write(children.filter((c) => c.pid !== pid));
    });
  }

  /**
   * Kill recorded children whose owner no longer exists. Run at startup, before spawning
   * anything new. Identity is verified both ways (see the module header) and a sweep that
   * cannot probe reaps nothing rather than guessing.
   */
  reapStale(): Promise<ReapReport> {
    return this.enqueue(async () => {
      const records = await this.read();
      if (records.length === 0) return { reaped: [], kept: 0, cleared: 0 };
      let probed: Map<number, ProcessInfo>;
      try {
        probed = await this.probe(records.flatMap((r) => [r.pid, r.ownerPid]));
      } catch (err) {
        return { reaped: [], kept: records.length, cleared: 0, skipped: String(err) };
      }
      const keep: ChildRecord[] = [];
      const reaped: ChildRecord[] = [];
      for (const rec of records) {
        const owner = probed.get(rec.ownerPid);
        const ownerAlive =
          owner !== undefined &&
          (owner.startedAt === null ||
            Math.abs(owner.startedAt - rec.ownerStartedAt) <= OWNER_START_TOLERANCE_MS);
        if (ownerAlive) {
          keep.push(rec);
          continue;
        }
        const child = probed.get(rec.pid);
        const isOurs =
          child !== undefined &&
          child.image === rec.image.toLowerCase() &&
          (child.startedAt === null ||
            Math.abs(child.startedAt - rec.recordedAt) <= CHILD_START_TOLERANCE_MS);
        if (isOurs) {
          await this.kill(rec.pid);
          reaped.push(rec);
        }
        // Not ours (gone, or the pid now belongs to a stranger): drop the record, touch nothing.
      }
      await this.write(keep);
      return { reaped, kept: keep.length, cleared: records.length - keep.length - reaped.length };
    });
  }
}
