import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { killTree, ownerStamp, type ChildLedger } from "../child-ledger.js";
import { leashChildToParent } from "../job-leash.js";
import { EngineLog } from "../supervisor.js";

export interface MingBatchCommand {
  /** Host-resolved ComfyUI interpreter and qualified Ming worker, never renderer input. */
  python: string;
  worker: string;
  args: readonly string[];
  cacheRoot: string;
}

/** A separate process borrows Python/Torch on disk, never ComfyUI's interpreter state.
 * One process serves a batch of chunks; exit is the release of its CUDA context. */
export class MingProcess {
  private active: { child: ChildProcess; closed: Promise<void> } | null = null;
  private launching = false;
  private disposed = false;
  private readonly backstop = () => {
    const pid = this.active?.child.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5_000 });
      else process.kill(-pid, "SIGKILL");
    } catch { /* the ledger is the next-start backstop */ }
  };

  constructor(private readonly ledger?: ChildLedger,
    private readonly spawnProcess: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess = spawn,
    private readonly cleanup: { kill?: (pid: number) => Promise<void>; timeoutMs?: number } = {},
  ) { process.once("exit", this.backstop); }

  private cleanupSignal(): AbortSignal { return AbortSignal.timeout(this.cleanup.timeoutMs ?? 30_000); }

  async run(command: MingBatchCommand, signal: AbortSignal): Promise<void> {
    if (this.disposed || this.active || this.launching) throw new Error("Ming is stopped or already running a batch.");
    if (![command.python, command.worker, command.cacheRoot].every(isAbsolute)) throw new Error("Ming paths must be resolved by the host.");
    signal.throwIfAborted();
    this.launching = true;
    try {
      const cache = (name: string) => join(command.cacheRoot, name);
      for (const name of ["temp", "hub", "triton", "inductor", "torch", "extensions"]) await mkdir(cache(name), { recursive: true });
      const image = process.platform === "win32" ? basename(command.python).toLowerCase() : basename(await realpath(command.python));
      signal.throwIfAborted();
      if (this.disposed) throw new Error("Ming is stopped.");
      const allowed = new Set(["SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "PATH", "COMSPEC", "PATHEXT", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME", "LD_LIBRARY_PATH"]);
      const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined && allowed.has(row[0].toUpperCase())));
      const log = new EngineLog(join(command.cacheRoot, "worker.log"));
      log.open(`=== ${new Date().toISOString()} Ming batch ===\n`);
      let child: ChildProcess;
      try { child = this.spawnProcess(command.python, ["-B", command.worker, ...command.args], {
        shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], cwd: command.cacheRoot,
        env: { ...env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", TOKENIZERS_PARALLELISM: "false",
          TEMP: cache("temp"), TMP: cache("temp"), TMPDIR: cache("temp"), HF_HOME: cache("hub"), TRITON_CACHE_DIR: cache("triton"), TORCHINDUCTOR_CACHE_DIR: cache("inductor"), TORCH_HOME: cache("torch"), TORCH_EXTENSIONS_DIR: cache("extensions"), USER: "arke-ming" },
      }); } catch (error) { await log.close(); throw error; }
      child.stdout?.on("data", (chunk: Buffer) => log.write(chunk));
      child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));
      let failed = false, code: number | null = null;
      let didClose = false;
      const closed = new Promise<void>(resolve => {
        child.once("error", () => { failed = true; });
        child.once("close", value => { didClose = true; code = value; resolve(); });
      });
      const active = { child, closed };
      this.active = active;
      let cleanupFailed!: (error: unknown) => void;
      const cancellation = new Promise<never>((_resolve, reject) => { cleanupFailed = reject; });
      void cancellation.catch(() => {}); // Cleanup may fail while the flushed ledger write is still settling.
      const abort = () => { void this.unload(this.cleanupSignal()).catch(cleanupFailed); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        if (child.pid) {
          const pid = child.pid;
          await this.ledger?.record({ id: "ming", pid, image,
            ...(process.platform !== "win32" ? { imageKind: "executable" as const, processGroupLeader: true as const } : {}), ...ownerStamp(), recordedAt: Date.now() });
          if (process.platform === "win32") void leashChildToParent(pid);
        }
        await Promise.race([closed, cancellation]);
        signal.throwIfAborted();
        if (failed || code !== 0) throw new Error("Ming generation failed. Check the batch's private diagnostics.");
      } finally {
        signal.removeEventListener("abort", abort);
        // A failed ledger write must still stop the process before its reservation can end.
        try {
          if (!didClose) await this.unload(this.cleanupSignal());
          if (didClose) {
            if (this.active === active) this.active = null;
            if (child.pid) await this.ledger?.release(child.pid);
          }
        } finally { await log.close(); }
      }
    } finally { this.launching = false; }
  }

  async unload(signal: AbortSignal): Promise<void> {
    const active = this.active;
    if (!active) return;
    const { child, closed } = active;
    const bounded = AbortSignal.any([signal, this.cleanupSignal()]);
    const stop = async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (this.cleanup.kill) await this.cleanup.kill(child.pid);
        else if (process.platform === "win32") await killTree(child.pid);
        else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* await close below */ } }
      }
      await closed;
    };
    let abort!: () => void;
    try {
      await Promise.race([stop(), new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("Ming has not confirmed process exit; the graphics card remains reserved."));
        bounded.addEventListener("abort", abort, { once: true });
        if (bounded.aborted) abort();
      })]);
      if (this.active === active) this.active = null;
      if (child.pid) await this.ledger?.release(child.pid);
    } finally { bounded.removeEventListener("abort", abort); }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.unload(this.cleanupSignal());
    process.off("exit", this.backstop);
  }
}
