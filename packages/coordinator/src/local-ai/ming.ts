import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ChildLedger } from "../child-ledger.js";
import { EngineLog } from "../supervisor.js";
import { SetupProcessRunner, SetupProcessCleanupPending } from "../setup/process.js";
import type { SetupProcessJob } from "../setup/process-job.js";

export interface MingBatchCommand {
  /** Host-resolved ComfyUI interpreter and qualified Ming worker, never renderer input. */
  python: string;
  worker: string;
  args: readonly string[];
  cacheRoot: string;
}

export class MingProcessCleanupPending extends Error {
  constructor() { super("Ming has not confirmed process exit; the graphics card remains reserved."); this.name = "MingProcessCleanupPending"; }
}

/** A separate process borrows Python/Torch on disk, never ComfyUI's interpreter state.
 * The existing native command owner gates execution and retains ordinary helpers; one
 * completed Python parent cannot release its descendants' CUDA context or batch files. */
export class MingProcess {
  get running(): boolean { return this.programs.running || this.launching; }
  private launching = false;
  private disposed = false;
  private readonly programs: SetupProcessRunner;

  constructor(ledger?: ChildLedger, private readonly options: {
    job?: SetupProcessJob; cleanupTimeoutMs?: number;
    /** Native fixtures use Node in place of Python, preserving the real gate/job/cleanup. */
    prepareCommand?: (command: string, args: readonly string[]) => { command: string; args: readonly string[] };
  } = {}) {
    this.programs = new SetupProcessRunner({ ledger, job: options.job, cleanupTimeoutMs: options.cleanupTimeoutMs, ledgerId: "ming" });
  }

  async run(command: MingBatchCommand, signal: AbortSignal): Promise<void> {
    if (this.disposed || this.running) throw new Error("Ming is stopped or already running a batch.");
    if (![command.python, command.worker, command.cacheRoot].every(isAbsolute)) throw new Error("Ming paths must be resolved by the host.");
    signal.throwIfAborted(); this.launching = true;
    try {
      const cache = (name: string) => join(command.cacheRoot, name);
      for (const name of ["temp", "hub", "triton", "inductor", "torch", "extensions"]) await mkdir(cache(name), { recursive: true });
      signal.throwIfAborted(); if (this.disposed) throw new Error("Ming is stopped.");
      const allowed = new Set(["SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "PATH", "COMSPEC", "PATHEXT", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME", "LD_LIBRARY_PATH"]);
      const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined && allowed.has(row[0].toUpperCase())));
      const log = new EngineLog(join(command.cacheRoot, "worker.log"));
      log.open(`=== ${new Date().toISOString()} Ming batch ===\n`);
      try {
        const program = this.options.prepareCommand?.(command.python, ["-B", command.worker, ...command.args])
          ?? { command: command.python, args: ["-B", command.worker, ...command.args] };
        const result = await this.programs.run(program.command, program.args, signal, text => log.write(Buffer.from(text)), "stream", {
          cwd: command.cacheRoot,
          env: { ...env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", PYTHONUTF8: "1", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", TOKENIZERS_PARALLELISM: "false",
            TEMP: cache("temp"), TMP: cache("temp"), TMPDIR: cache("temp"), HF_HOME: cache("hub"), TRITON_CACHE_DIR: cache("triton"), TORCHINDUCTOR_CACHE_DIR: cache("inductor"), TORCH_HOME: cache("torch"), TORCH_EXTENSIONS_DIR: cache("extensions"), USER: "arke-ming" },
        });
        signal.throwIfAborted();
        if (result.code !== 0) throw new Error("Ming generation failed. Check the batch's private diagnostics.");
      } catch (error) {
        if (error instanceof SetupProcessCleanupPending || this.programs.running) throw new MingProcessCleanupPending();
        signal.throwIfAborted();
        throw new Error("Ming generation failed. Check the batch's private diagnostics.");
      } finally { await log.close(); }
    } finally { this.launching = false; }
  }

  async unload(signal: AbortSignal): Promise<void> {
    let abort!: () => void;
    try {
      // Cleanup has its own deadline and continues if this caller stops waiting. A rejected
      // wait grants no release; a later owner confirmation can settle the retained GPU lane.
      await Promise.race([this.programs.confirmCleanup(), new Promise<never>((_, reject) => {
        abort = () => reject(new MingProcessCleanupPending());
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      })]);
    } catch { throw new MingProcessCleanupPending(); }
    finally { signal.removeEventListener("abort", abort); }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    try { await this.programs.dispose(); } catch { throw new MingProcessCleanupPending(); }
  }
}
