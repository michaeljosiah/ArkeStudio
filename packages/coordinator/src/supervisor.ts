import { EventEmitter } from "node:events";
import net from "node:net";
import { basename } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  killTree,
  listDescendants,
  ownerStamp,
  platformProbe,
  type ChildLedger,
  type DescendantInfo,
  type ProcessInfo,
} from "./child-ledger.js";
import { leashChildToParent } from "./job-leash.js";

/**
 * Generic child-process supervisor (SPEC-001 R-5, D3). OpenCode and Voxa differ in protocol
 * but not in lifecycle: spawn, allocate a loopback port, probe health, restart with backoff,
 * stop gracefully, never leave an orphan. One implementation, two configurations.
 *
 * "Never leave an orphan" has to hold when this process is force-killed and no code here
 * runs at all, so every spawn is tethered twice: leashed to this process's lifetime with a
 * kernel Job Object (job-leash.ts), and recorded in the pidfile ledger (child-ledger.ts)
 * that the next startup sweeps.
 *
 * A Windows shell-shim spawn adds a third tether: the pid we hold is a cmd.exe wrapper, and
 * the process doing the real work is its grandchild. Killing the wrapper's pid alone leaves
 * that grandchild running (this is how opencode.exe orphans accumulated), so once the child
 * is healthy its live descendants are snapshotted and recorded in the ledger too — the
 * stop/restart paths and a later run's sweep can then reach past a dead wrapper.
 */

export type SupervisorStatus =
  | "unconfigured"
  | "starting"
  | "healthy"
  | "unhealthy"
  | "stopped"
  | "failed";

export interface SupervisorStatusEvent {
  id: string;
  status: SupervisorStatus;
  reason?: string;
}

export interface SupervisedSpec {
  id: string;
  /** null → the child is not configured on this machine; status reports why (R-6). */
  command: string | null;
  /** `{port}` in an argument is replaced with the allocated loopback port. */
  args?: string[];
  env?: Record<string, string>;
  /** Path probed at http://127.0.0.1:<port>; 2xx → healthy. Default "/health". */
  healthPath?: string;
  /**
   * Headers for the health probe, resolved per attempt. An OpenCode v2 child authenticates
   * its whole API — health included — with a password it prints at launch, so the probe must
   * be able to carry credentials that did not exist when the spec was written (issue 327 §4).
   * Until the resolver can supply them, the probe runs bare and the 401s read as "not yet".
   */
  healthHeaders?: () => Record<string, string>;
  /**
   * One call per complete stdout line. The v2 launch protocol arrives this way (`server
   * password <secret>`); the line is handed over verbatim and never logged here — what is in
   * it is the caller's secret to keep (issue 327 §4).
   */
  onStdoutLine?: (line: string) => void;
  /**
   * Optional protocol validation after a 2xx response.
   *
   * `false` means not ready yet — keep probing. `{ ok: false, reason }` means the contract is
   * wrong, which is terminal: waiting cannot make a version mismatch compatible, so probing stops
   * and the reason is reported straight away.
   */
  validateHealth?: (
    response: Response,
  ) => boolean | { ok: boolean; reason?: string } | Promise<boolean | { ok: boolean; reason?: string }>;
  /** Replace the inherited environment instead of passing credentials and unrelated host state. */
  inheritEnv?: boolean;
  /** How long the child has to become healthy before it is declared failed. */
  readyTimeoutMs?: number;
  probeIntervalMs?: number;
  /** Continue probing after startup. Zero disables continuous health monitoring. */
  healthIntervalMs?: number;
  /** Consecutive failed continuous probes before the child is restarted. */
  healthFailureThreshold?: number;
  /** Restart budget after an unexpected exit; exceeded → failed with a stated reason. */
  maxRestarts?: number;
  backoffMs?: number;
}

/** Allocate a free loopback port by binding port 0 and closing again. */
export async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("no bound address"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

const pidExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Two probes of the same process report the same creation time; beyond this it's a reuse. */
const DESCENDANT_START_TOLERANCE_MS = 5_000;

export interface SupervisorDeps {
  /** When present, spawns are recorded and exits released so a later sweep can reap. */
  ledger?: ChildLedger;
}

export class ChildSupervisor extends EventEmitter {
  readonly id: string;
  private readonly spec: Required<
    Omit<SupervisedSpec, "command" | "args" | "env" | "validateHealth" | "healthHeaders" | "onStdoutLine">
  > &
    Pick<SupervisedSpec, "command" | "args" | "env" | "validateHealth" | "healthHeaders" | "onStdoutLine">;
  private readonly deps: SupervisorDeps;
  private child: ChildProcess | null = null;
  private _port: number | null = null;
  private _status: SupervisorStatus = "stopped";
  private _reason: string | undefined;
  private stopping = false;
  private restarts = 0;
  private leashWarned = false;
  /** Live descendants of the current child (win32 shell shims) — see adoptDescendants. */
  private descendants: DescendantInfo[] = [];
  private healthFailure: string | undefined;
  /** A terminal startup verdict kills the child deliberately and must never spend restart budget. */
  private terminalStartupChild: ChildProcess | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private readonly sleepTimers = new Map<NodeJS.Timeout, () => void>();
  private consecutiveHealthFailures = 0;

  constructor(spec: SupervisedSpec, deps: SupervisorDeps = {}) {
    super();
    this.id = spec.id;
    this.deps = deps;
    this.spec = {
      ...spec,
      healthPath: spec.healthPath ?? "/health",
      readyTimeoutMs: spec.readyTimeoutMs ?? 15_000,
      probeIntervalMs: spec.probeIntervalMs ?? 250,
      healthIntervalMs: spec.healthIntervalMs ?? 0,
      healthFailureThreshold: Math.max(1, spec.healthFailureThreshold ?? 3),
      maxRestarts: spec.maxRestarts ?? 3,
      backoffMs: spec.backoffMs ?? 500,
      inheritEnv: spec.inheritEnv ?? true,
    };
  }

  get status(): SupervisorStatus {
    return this._status;
  }

  get reason(): string | undefined {
    return this._reason;
  }

  get port(): number | null {
    return this._port;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Monotonic process-attempt identity for lifecycle consumers such as local job recovery. */
  get spawnEpoch(): number {
    return this.launchEpoch;
  }

  /** Tracked descendant pids of the current child — for the exit backstop's sweep. */
  get descendantPids(): number[] {
    return this.descendants.map((d) => d.pid);
  }

  private setStatus(status: SupervisorStatus, reason?: string): void {
    this._status = status;
    this._reason = reason;
    const event: SupervisorStatusEvent = { id: this.id, status, ...(reason ? { reason } : {}) };
    this.emit("status", event);
  }

  async start(): Promise<void> {
    if (this.spec.command === null) {
      this.setStatus("unconfigured", `${this.id} is not configured`);
      return;
    }
    if (this.child !== null) return; // already running — a second start must not double-spawn
    this.stopping = false;
    this.restarts = 0;
    this.terminalStartupChild = null;
    await this.spawnOnce();
  }

  /** Stop, replace launch configuration, and start again without restarting the application. */
  async reconfigure(
    patch: Pick<SupervisedSpec, "command" | "args" | "env" | "inheritEnv">,
  ): Promise<void> {
    await this.stop();
    this.spec.command = patch.command;
    this.spec.args = patch.args;
    this.spec.env = patch.env;
    this.spec.inheritEnv = patch.inheritEnv ?? true;
    await this.start();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Apply an environment PATCH for the child: a string sets the variable, an explicit
   * `undefined` deletes it — a merge that cannot delete turns a revoked credential into one
   * that quietly survives every later spawn. Before the first start this only stores the
   * result; a running child restarts, because environment reaches a process exactly once,
   * at spawn — and only when something actually changed, so re-saving an identical key (or
   * clearing one that was never set) does not cost an in-flight turn its harness.
   */
  async updateEnv(patch: Record<string, string | undefined>): Promise<void> {
    const next: Record<string, string> = { ...this.spec.env };
    for (const [name, value] of Object.entries(patch)) {
      if (value === undefined) delete next[name];
      else next[name] = value;
    }
    const before = this.spec.env ?? {};
    const changed =
      Object.keys(next).length !== Object.keys(before).length ||
      Object.entries(next).some(([k, v]) => before[k] !== v);
    this.spec.env = next;
    if (changed && this.child !== null) await this.restart();
  }

  /**
   * Bumped by every spawn attempt and every stop. A continuation resumed from an await
   * (port allocation, the health probe) acts only if its epoch is still current — the
   * `stopping` flag alone cannot carry this, because an interleaved restart resets it, and
   * the superseded continuation then force-killed a recycled pid and reported a terminal
   * "failed" over a child that was coming up healthy (found in review of issue 327's
   * wiring slice).
   */
  private launchEpoch = 0;

  private async spawnOnce(): Promise<void> {
    const command = this.spec.command;
    if (command === null) return;
    const epoch = ++this.launchEpoch;
    this.setStatus("starting");
    this.healthFailure = undefined;
    this.clearHealthTimer();
    this.consecutiveHealthFailures = 0;
    const port = await allocateLoopbackPort();
    if (epoch !== this.launchEpoch || this.stopping) return;
    this._port = port;
    const args = (this.spec.args ?? []).map((a) => a.replaceAll("{port}", String(port)));

    // Windows batch shims (.cmd/.bat) are only startable through the shell (Node ≥18
    // refuses them otherwise). Args here are supervisor-authored, never user input.
    const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env: { ...(this.spec.inheritEnv ? process.env : {}), ...this.spec.env, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: needsShell,
      });
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "spawn error";
      this.setStatus("failed", `${this.id} failed to spawn (${code})`);
      return;
    }
    this.child = child;

    // Install exit handling before awaiting the spawn event: a command can spawn and exit in
    // the same turn. Registering afterwards loses that exit and probes a dead child to timeout.
    child.once("exit", (code, signal) => {
      if (child.pid !== undefined) {
        void this.deps.ledger?.release(child.pid).catch(() => {});
      }
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      if (this.terminalStartupChild === child) {
        this.terminalStartupChild = null;
        return;
      }
      void this.handleUnexpectedExit(code, signal);
    });

    // Both pipes are drained whether or not anyone listens: an unread pipe eventually fills
    // and blocks the child's writes. Stdout lines additionally reach the spec's handler —
    // the v2 launch protocol travels there — and are never logged or stored here.
    this.drain(child);

    const spawnError = new Promise<string | null>((resolve) => {
      child.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "spawn error"));
      child.once("spawn", () => resolve(null));
    });
    const errored = await spawnError;
    if (errored !== null) {
      this.child = null;
      this.setStatus("failed", `${this.id} failed to spawn: ${errored}`);
      return;
    }

    // With a shell shim the pid we hold is cmd.exe's; the ledger must record the image the
    // OS will actually report for it, or the sweep's identity check would never match.
    this.tether(child, needsShell ? "cmd.exe" : basename(command).toLowerCase());

    const healthy = await this.probeUntilHealthy(child);
    // A superseded attempt owns nothing: the child it probed was already stopped and
    // replaced, and both its verdicts — healthy or failed — describe a process that is no
    // longer this supervisor's child.
    if (epoch !== this.launchEpoch || this.stopping || this.child !== child) return;
    if (healthy) {
      this.setStatus("healthy");
      void this.adoptDescendants(child);
      this.scheduleHealthCheck(child, epoch);
      return;
    }
    // Never became healthy: kill it and report a stated reason, not a silent absence (R-5).
    // A typed validation failure or startup timeout is terminal for this launch. Mark the child
    // before killing it so its exit listener cannot race this continuation and consume the
    // unexpected-exit restart budget (or start a replacement behind the terminal status).
    this.terminalStartupChild = child;
    await this.forceStop(child);
    if (this.child === child) this.child = null;
    this.setStatus(
      "failed",
      this.healthFailure ??
        `${this.id} did not become healthy within ${Math.round(this.spec.readyTimeoutMs / 1000)}s`,
    );
  }

  /**
   * Tie the child's lifetime to this process (R-5 under force-kill): kernel leash plus
   * ledger record. Both are best-effort and neither delays startup — health probing races
   * ahead while they attach.
   */
  private tether(child: ChildProcess, image: string): void {
    const pid = child.pid;
    if (pid === undefined) return;
    void this.deps.ledger
      ?.record({ pid, image, id: this.id, ...ownerStamp(), recordedAt: Date.now() })
      .catch(() => {});
    if (process.platform !== "win32") return;
    void leashChildToParent(pid).then((leash) => {
      // A child that already exited explains its own leash failure; anything else is worth
      // one warning, because orphan cleanup now rests on the startup sweep alone.
      if (leash.ok || this.leashWarned || child.exitCode !== null || child.signalCode !== null) return;
      this.leashWarned = true;
      console.warn(
        `[supervisor] ${this.id}: could not leash pid ${pid} to this process (${leash.reason ?? "unknown"}); if this process is force-killed, cleanup falls to the next startup's sweep`,
      );
    });
  }

  /**
   * Snapshot the child's live descendants and record them in the ledger. A shell-shim child
   * is only a wrapper; the process serving the port is its grandchild, unreachable through
   * the wrapper's pid once the wrapper dies. Runs after the health probe succeeds because
   * that is the first moment the real tree is guaranteed to exist. Best-effort and off the
   * status path, like tether(); a wrapper that dies before this lands is the one gap left,
   * and a wait-style shim (npm's shape) cannot die before its worker does.
   */
  private async adoptDescendants(child: ChildProcess): Promise<void> {
    if (process.platform !== "win32") return;
    const pid = child.pid;
    if (pid === undefined) return;
    let found: DescendantInfo[];
    try {
      found = await listDescendants(pid);
    } catch {
      return; // no snapshot; taskkill /T on the live wrapper remains the cover
    }
    if (this.child !== child) return; // stopped or restarted while enumerating
    this.descendants = found;
    for (const d of found) {
      // recordedAt carries the probed creation time so the sweep's ≈-start check is exact.
      void this.deps.ledger
        ?.record({
          pid: d.pid,
          image: d.image,
          id: this.id,
          parentPid: pid,
          ...ownerStamp(),
          recordedAt: d.startedAt ?? Date.now(),
        })
        .catch(() => {});
    }
  }

  /**
   * Kill tracked descendants that outlived the child — on Windows the wrapper's death
   * (graceful exit, kill(), taskkill on an already-dead root) never takes them with it.
   * Every kill is identity-checked against the adoption snapshot first: a recycled pid is a
   * stranger and is left alone. Verified-dead descendants release their ledger records; a
   * failed probe keeps them so the next startup's sweep still has something to go on.
   */
  private async reapSurvivors(): Promise<void> {
    const tracked = this.descendants;
    this.descendants = [];
    if (tracked.length === 0) return;
    const survivors: DescendantInfo[] = [];
    for (const d of tracked) {
      if (pidExists(d.pid)) survivors.push(d);
      else void this.deps.ledger?.release(d.pid).catch(() => {});
    }
    if (survivors.length === 0) return;
    let probed: Map<number, ProcessInfo>;
    try {
      probed = await platformProbe(survivors.map((d) => d.pid));
    } catch {
      return; // cannot verify identity — kill nothing, keep the records for the sweep
    }
    for (const d of survivors) {
      const live = probed.get(d.pid);
      const isOurs =
        live !== undefined &&
        live.image === d.image &&
        (live.startedAt === null ||
          d.startedAt === null ||
          Math.abs(live.startedAt - d.startedAt) <= DESCENDANT_START_TOLERANCE_MS);
      if (isOurs) await killTree(d.pid);
      if (live === undefined || isOurs) void this.deps.ledger?.release(d.pid).catch(() => {});
      // A stranger wearing the pid keeps its record; the sweep clears it without a kill.
    }
  }

  private drain(child: ChildProcess): void {
    child.stderr?.on("data", () => {});
    const handler = this.spec.onStdoutLine;
    if (!handler) {
      child.stdout?.on("data", () => {});
      return;
    }
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        try {
          handler(line);
        } catch {
          /* a broken line handler must never take the supervisor down */
        }
      }
      // A child that streams without newlines (spinners, progress frames) must not grow this
      // buffer forever; the launch line is short and early, so a capped tail loses nothing.
      if (buffer.length > 65_536) buffer = buffer.slice(-1_024);
    });
  }

  private healthUrl(): string {
    return `http://127.0.0.1:${this._port}${this.spec.healthPath}`;
  }

  private clearHealthTimer(): void {
    if (this.healthTimer !== null) clearTimeout(this.healthTimer);
    this.healthTimer = null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.sleepTimers.delete(timer);
        resolve();
      }, ms);
      this.sleepTimers.set(timer, resolve);
      // This timer directly settles an awaited startup, backoff, or shutdown promise. Unref'ing
      // it lets Node exit with that promise unresolved when no other handle happens to be alive
      // (the Linux test runner exposes this reliably). Periodic background health checks remain
      // unref'd in scheduleHealthCheck(); awaited lifecycle deadlines must keep the loop alive.
    });
  }

  private clearSleepTimers(): void {
    for (const [timer, resolve] of this.sleepTimers) {
      clearTimeout(timer);
      resolve();
    }
    this.sleepTimers.clear();
  }

  private async healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }> {
    let headers: Record<string, string> | undefined;
    try {
      headers = this.spec.healthHeaders?.();
    } catch (err) {
      return {
        ok: false,
        reason: `${this.id} health-header resolver failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      const res = await fetch(this.healthUrl(), {
        signal: AbortSignal.timeout(1_000),
        ...(headers ? { headers } : {}),
      });
      if (!res.ok) return { ok: false, reason: `${this.id} health answered HTTP ${res.status}` };
      if (!this.spec.validateHealth) return { ok: true };
      const validation = await this.spec.validateHealth(res);
      const ok = typeof validation === "boolean" ? validation : validation.ok;
      if (ok) return { ok: true };
      return {
        ok: false,
        reason:
          typeof validation === "boolean"
            ? `${this.id} health contract was not ready`
            : (validation.reason ?? `${this.id} health contract was not ready`),
      };
    } catch {
      return { ok: false, reason: `${this.id} health did not answer` };
    }
  }

  private scheduleHealthCheck(child: ChildProcess, epoch: number): void {
    if (this.spec.healthIntervalMs <= 0 || this.stopping || this.child !== child) return;
    this.clearHealthTimer();
    this.healthTimer = setTimeout(() => {
      this.healthTimer = null;
      void this.runHealthCheck(child, epoch);
    }, this.spec.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  private async runHealthCheck(child: ChildProcess, epoch: number): Promise<void> {
    if (epoch !== this.launchEpoch || this.stopping || this.child !== child) return;
    const result = await this.healthCheck();
    if (epoch !== this.launchEpoch || this.stopping || this.child !== child) return;
    if (result.ok) {
      this.consecutiveHealthFailures = 0;
      if (this.status !== "healthy") this.setStatus("healthy");
      this.scheduleHealthCheck(child, epoch);
      return;
    }

    this.consecutiveHealthFailures += 1;
    const threshold = this.spec.healthFailureThreshold;
    this.setStatus(
      "unhealthy",
      `${result.reason}; failed ${this.consecutiveHealthFailures} of ${threshold} continuous health checks`,
    );
    if (this.consecutiveHealthFailures < threshold) {
      this.scheduleHealthCheck(child, epoch);
      return;
    }

    // Killing the current child feeds the ordinary unexpected-exit path, preserving its bounded
    // backoff and restart budget instead of creating a second recovery policy for hung health.
    await this.forceStop(child);
  }

  private async probeUntilHealthy(child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + this.spec.readyTimeoutMs;
    while (Date.now() < deadline && !this.stopping && this.child === child) {
      let headers: Record<string, string> | undefined;
      try {
        headers = this.spec.healthHeaders?.();
      } catch (err) {
        // A broken resolver cannot heal by retrying; report IT, not a misleading timeout.
        this.healthFailure = `${this.id} health-header resolver failed: ${err instanceof Error ? err.message : String(err)}`;
        this.terminalStartupChild = child;
        return false;
      }
      try {
        const res = await fetch(this.healthUrl(), {
          signal: AbortSignal.timeout(1_000),
          ...(headers ? { headers } : {}),
        });
        if (res.ok) {
          if (!this.spec.validateHealth) return true;
          const validation = await this.spec.validateHealth(res);
          const ok = typeof validation === "boolean" ? validation : validation.ok;
          if (ok) return true;
          if (typeof validation !== "boolean" && validation.reason) {
            // A stated incompatibility is an answer, not an absence. Continuing to probe would
            // spend the whole readiness budget re-learning it, and then report the timeout
            // instead of the reason — which is exactly backwards for someone trying to find out
            // what is wrong.
            this.healthFailure = validation.reason;
            this.terminalStartupChild = child;
            return false;
          }
        }
      } catch {
        /* not up yet */
      }
      await this.sleep(this.spec.probeIntervalMs);
    }
    return false;
  }

  private async handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.clearHealthTimer();
    // The wrapper exiting says nothing about its grandchildren: they survive it, still
    // holding the old port. Clear them out before deciding whether to restart.
    await this.reapSurvivors();
    const why = signal ? `signal ${signal}` : `exit code ${code}`;
    if (this.restarts >= this.spec.maxRestarts) {
      this.setStatus("failed", `${this.id} exited (${why}) and exceeded its restart budget`);
      return;
    }
    this.restarts += 1;
    this.setStatus("unhealthy", `${this.id} exited (${why}); restarting (attempt ${this.restarts})`);
    await this.sleep(this.spec.backoffMs * 2 ** (this.restarts - 1));
    if (this.stopping) return;
    await this.spawnOnce();
  }

  /** Graceful stop: signal, wait, then force-kill the process tree. Never leaves an orphan. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.terminalStartupChild = null;
    this.launchEpoch += 1; // any in-flight spawn continuation is now superseded
    this.clearHealthTimer();
    this.clearSleepTimers();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      if (process.platform === "win32") {
        // kill() here is TerminateProcess on the direct child alone — a shell-shim wrapper
        // dies "gracefully" while its grandchild lives on. Windows has no polite signal to
        // try first, so nothing is lost by taking the whole tree at once.
        await this.forceStop(child);
        await Promise.race([exited, this.sleep(2_000)]);
      } else {
        child.kill();
        const graceful = await Promise.race([exited.then(() => true), this.sleep(3_000).then(() => false)]);
        if (!graceful) {
          await this.forceStop(child);
          await Promise.race([exited, this.sleep(2_000)]);
        }
      }
    }
    // Descendants the tree kill could not reach (the wrapper was already dead) die here.
    await this.reapSurvivors();
    this.clearSleepTimers();
    if (this._status !== "unconfigured") this.setStatus("stopped", `${this.id} stopped`);
  }

  private async forceStop(child: ChildProcess): Promise<void> {
    if (child.pid === undefined) return;
    // taskkill /T takes the whole tree — a bare kill() orphans grandchildren on Windows.
    await killTree(child.pid);
  }
}

/**
 * Last-resort cleanup for exits that skip the graceful path — process.exit, an uncaught
 * exception, a signal handler that raced. "exit" handlers must be synchronous, so this
 * spawnSyncs taskkill; the kernel leash covers the deaths where not even this runs.
 */
export function registerExitBackstop(...supervisors: ChildSupervisor[]): () => void {
  const backstop = () => {
    for (const supervisor of supervisors) {
      // Tracked descendants ride along: when the wrapper is already dead, its pid reaches
      // nothing and the grandchildren are only killable by their own pids.
      const pids = [supervisor.pid, ...supervisor.descendantPids].filter((p): p is number => p !== null);
      for (const pid of pids) {
        try {
          if (process.platform === "win32") {
            spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          } else {
            process.kill(pid, "SIGKILL");
          }
        } catch {
          /* best effort by definition */
        }
      }
    }
  };
  process.once("exit", backstop);
  return () => process.off("exit", backstop);
}
