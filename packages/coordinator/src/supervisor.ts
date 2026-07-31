import { EventEmitter } from "node:events";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Generic child-process supervisor (SPEC-001 R-5, D3). OpenCode and Voxa differ in protocol
 * but not in lifecycle: spawn, allocate a loopback port, probe health, restart with backoff,
 * stop gracefully, never leave an orphan. One implementation, two configurations.
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
  /** How long the child has to become healthy before it is declared failed. */
  readyTimeoutMs?: number;
  probeIntervalMs?: number;
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ChildSupervisor extends EventEmitter {
  readonly id: string;
  private readonly spec: Required<Omit<SupervisedSpec, "command" | "args" | "env">> &
    Pick<SupervisedSpec, "command" | "args" | "env">;
  private child: ChildProcess | null = null;
  private _port: number | null = null;
  private _status: SupervisorStatus = "stopped";
  private _reason: string | undefined;
  private stopping = false;
  private restarts = 0;

  constructor(spec: SupervisedSpec) {
    super();
    this.id = spec.id;
    this.spec = {
      ...spec,
      healthPath: spec.healthPath ?? "/health",
      readyTimeoutMs: spec.readyTimeoutMs ?? 15_000,
      probeIntervalMs: spec.probeIntervalMs ?? 250,
      maxRestarts: spec.maxRestarts ?? 3,
      backoffMs: spec.backoffMs ?? 500,
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
    await this.spawnOnce();
  }

  private async spawnOnce(): Promise<void> {
    const command = this.spec.command;
    if (command === null) return;
    this.setStatus("starting");
    const port = await allocateLoopbackPort();
    this._port = port;
    const args = (this.spec.args ?? []).map((a) => a.replaceAll("{port}", String(port)));

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env: { ...process.env, ...this.spec.env, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      this.setStatus("failed", `${this.id} failed to spawn: ${String(err)}`);
      return;
    }
    this.child = child;

    const spawnError = new Promise<string | null>((resolve) => {
      child.once("error", (err) => resolve(String(err)));
      child.once("spawn", () => resolve(null));
    });
    const errored = await spawnError;
    if (errored !== null) {
      this.child = null;
      this.setStatus("failed", `${this.id} failed to spawn: ${errored}`);
      return;
    }

    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      void this.handleUnexpectedExit(code, signal);
    });

    const healthy = await this.probeUntilHealthy(child);
    if (this.stopping) return;
    if (healthy) {
      this.setStatus("healthy");
      return;
    }
    // Never became healthy: kill it and report a stated reason, not a silent absence (R-5).
    await this.forceStop(child);
    if (this.child === child) this.child = null;
    this.setStatus(
      "failed",
      `${this.id} did not become healthy within ${Math.round(this.spec.readyTimeoutMs / 1000)}s`,
    );
  }

  private healthUrl(): string {
    return `http://127.0.0.1:${this._port}${this.spec.healthPath}`;
  }

  private async probeUntilHealthy(child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + this.spec.readyTimeoutMs;
    while (Date.now() < deadline && !this.stopping && this.child === child) {
      try {
        const res = await fetch(this.healthUrl(), { signal: AbortSignal.timeout(1_000) });
        if (res.ok) return true;
      } catch {
        /* not up yet */
      }
      await sleep(this.spec.probeIntervalMs);
    }
    return false;
  }

  private async handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const why = signal ? `signal ${signal}` : `exit code ${code}`;
    if (this.restarts >= this.spec.maxRestarts) {
      this.setStatus("failed", `${this.id} exited (${why}) and exceeded its restart budget`);
      return;
    }
    this.restarts += 1;
    this.setStatus("unhealthy", `${this.id} exited (${why}); restarting (attempt ${this.restarts})`);
    await sleep(this.spec.backoffMs * 2 ** (this.restarts - 1));
    if (this.stopping) return;
    await this.spawnOnce();
  }

  /** Graceful stop: signal, wait, then force-kill the process tree. Never leaves an orphan. */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      const graceful = await Promise.race([exited.then(() => true), sleep(3_000).then(() => false)]);
      if (!graceful) {
        await this.forceStop(child);
        await Promise.race([exited, sleep(2_000)]);
      }
    }
    if (this._status !== "unconfigured") this.setStatus("stopped", `${this.id} stopped`);
  }

  private async forceStop(child: ChildProcess): Promise<void> {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      // taskkill /T takes the whole tree — a bare kill() orphans grandchildren on Windows.
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("exit", () => resolve());
        killer.once("error", () => resolve());
      });
    } else {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}
