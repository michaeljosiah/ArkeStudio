import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import type { ChildLedger } from "../child-ledger.js";
import { ownerStamp } from "../child-ledger.js";
import { NativeSetupProcessJob, type SetupProcessJob } from "./process-job.js";

/** The anchor does no filesystem work. It stays alive until its owner confirms all ordinary
 * helpers exited, so a POSIX group cannot recycle its identity while a command is admitted. */
const WORKER = String.raw`
const { spawn } = require('node:child_process');
const { writeSync } = require('node:fs');
const readline = require('node:readline');
const owner = Number(process.env.ARKE_SETUP_OWNER_PID);
const frame = value => writeSync(3, JSON.stringify(value) + '\n');
let started = false, finishing = false, bytes = 0;
const abandon = () => {
  if (process.platform !== 'win32') { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }
  process.exit(1);
};
const heartbeat = process.platform === 'win32' ? null : setInterval(() => { if (process.ppid !== owner) abandon(); }, 500);
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  bytes += Buffer.byteLength(line); if (bytes > 65536) abandon();
  if (started) {
    if (line !== 'finish') abandon();
    finishing = true; if (heartbeat) clearInterval(heartbeat); process.exit(0);
  }
  started = true;
  try {
    const spec = JSON.parse(line);
    if (typeof spec.command !== 'string' || !Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string')) abandon();
    const child = spawn(spec.command, spec.args, { shell: false, windowsHide: true, detached: false, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', () => {});
    child.once('close', code => frame({ code: code ?? 1 }));
  } catch { frame({ code: 1 }); }
});
input.on('close', () => { if (!finishing) abandon(); });
frame({ ready: true });
`;

export class SetupProcessCleanupPending extends Error {
  constructor() { super("Setup has not confirmed native process exit. Its installation and disk reservations remain held."); this.name = "SetupProcessCleanupPending"; }
}
interface Active {
  child: ChildProcess; closed: Promise<void>; bound: boolean; launched: boolean;
  cleaning?: Promise<void>; binding?: Promise<void>; finishing?: boolean; removeBackstop(): void;
}
const live = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
/** Host-only catalogue commands. There is one executor, no automatic command replay, and
 * unresolved cleanup retains the anchor/job for an explicit later owner cleanup attempt. */
export class SetupProcessRunner {
  private active: Active | null = null;
  private closing = false;
  private readonly lifetime = new AbortController();
  private readonly job: SetupProcessJob;
  constructor(private readonly deps: { ledger?: ChildLedger; job?: SetupProcessJob; cleanupTimeoutMs?: number; readyTimeoutMs?: number } = {}) {
    this.job = deps.job ?? new NativeSetupProcessJob();
  }
  private async wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort!: () => void;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new Error("Setup was stopped."));
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      })]);
    } finally { signal.removeEventListener("abort", abort); }
  }
  private pause(signal: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return this.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, 250); }), signal).finally(() => { if (timer) clearTimeout(timer); });
  }
  private cleanup(active: Active): Promise<void> {
    if (active.cleaning) return active.cleaning;
    active.cleaning = (async () => {
      const signal = AbortSignal.timeout(this.deps.cleanupTimeoutMs ?? 30_000), pid = active.child.pid;
      if (active.binding) await this.wait(active.binding.catch(() => {}), signal);
      if (!pid) { await this.wait(active.closed, signal); return; }
      if (!active.launched) {
        // No catalogue program was released from the gate. The anchor's own handle is
        // sufficient even when native ownership could not be established.
        if (live(active.child)) active.child.kill("SIGKILL");
      } else if (process.platform === "win32" || live(active.child)) {
        await this.job.terminate(pid, signal);
      } else if (await this.job.active(pid, signal) !== 0) {
        // A lost POSIX anchor no longer proves a group id still belongs to this operation.
        // Never kill a possibly recycled group just because a stale number is retained.
        throw new SetupProcessCleanupPending();
      }
      await this.wait(active.closed, signal);
      if (active.bound) while (await this.job.active(pid, signal) !== 0) await this.pause(signal);
    })().catch(() => { throw new SetupProcessCleanupPending(); }).then(async () => {
      active.removeBackstop(); if (active.child.pid) await this.wait(this.deps.ledger?.release(active.child.pid) ?? Promise.resolve(), AbortSignal.timeout(this.deps.cleanupTimeoutMs ?? 30_000)).catch(() => {});
      if (this.active === active) this.active = null;
    }).finally(() => { active.cleaning = undefined; });
    return active.cleaning;
  }
  async run(command: string, args: readonly string[], signal: AbortSignal, onOutput?: (text: string) => void, captureMode: "full" | "metadata" = "full"): Promise<{ code: number; output: string }> {
    if (this.closing || this.active) throw new SetupProcessCleanupPending(); signal.throwIfAborted();
    const request = JSON.stringify({ command, args }); if (Buffer.byteLength(request) > 64 * 1024) throw new Error("Setup command exceeds its supported bound.");
    const allowed = new Set(["SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "PATH", "COMSPEC", "PATHEXT", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME", "TMP", "TEMP", "TMPDIR", "LD_LIBRARY_PATH", "OLLAMA_HOST", "OLLAMA_MODELS"]);
    const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined && allowed.has(row[0].toUpperCase())));
    const child = spawn(process.execPath, ["-e", WORKER], { shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "pipe"], env: { ...env, ELECTRON_RUN_AS_NODE: "1", ARKE_SETUP_OWNER_PID: String(process.pid), LC_ALL: "C" } });
    child.stdin?.on("error", () => {}); child.once("error", () => {});
    const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); });
    const backstop = () => {
      if (process.platform !== "win32" && child.pid && live(child)) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* ledger is the backstop */ } }
      else if (live(child)) { try { child.kill("SIGKILL"); } catch { /* kernel job is the backstop */ } }
    };
    process.once("exit", backstop);
    const active: Active = { child, closed, bound: false, launched: false, removeBackstop: () => { process.off("exit", backstop); } }; this.active = active;
    const internal = new AbortController(), combined = AbortSignal.any([signal, internal.signal, this.lifetime.signal]);
    let output = "", outputBytes = 0, protocol = "", ready!: () => void, complete!: (code: number) => void;
    const readyFrame = new Promise<void>(resolve => { ready = resolve; }), completed = new Promise<number>(resolve => { complete = resolve; });
    const capture = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > (captureMode === "metadata" ? 32 : 1) * 1024 * 1024) { internal.abort(new Error("Setup program output exceeded its supported bound.")); return; }
      const text = chunk.toString("utf8"); if (captureMode === "full") output += text; try { onOutput?.(text); } catch { /* Progress presentation cannot grant authority. */ }
    };
    child.stdout?.on("data", capture); child.stderr?.on("data", capture);
    child.stdio[3]?.on("data", (chunk: Buffer) => {
      protocol += chunk.toString("utf8"); if (Buffer.byteLength(protocol) > 4096) { internal.abort(new Error("Setup process protocol is invalid.")); return; }
      let end: number;
      while ((end = protocol.indexOf("\n")) >= 0) {
        const line = protocol.slice(0, end); protocol = protocol.slice(end + 1);
        try { const value = JSON.parse(line) as { ready?: unknown; code?: unknown };
          if (value.ready === true) ready();
          else if (typeof value.code === "number" && Number.isSafeInteger(value.code)) complete(value.code);
          else internal.abort(new Error("Setup process protocol is invalid."));
        } catch { internal.abort(new Error("Setup process protocol is invalid.")); }
      }
    });
    child.once("exit", () => { if (this.active === active && !active.cleaning && !active.finishing) internal.abort(new Error("Setup process exited before owned completion.")); });
    const stop = () => { void this.cleanup(active).catch(() => {}); };
    combined.addEventListener("abort", stop, { once: true });
    try {
      const readySignal = AbortSignal.any([combined, AbortSignal.timeout(this.deps.readyTimeoutMs ?? 30_000)]);
      await this.wait(readyFrame, readySignal);
      if (!child.pid) throw new Error("Setup native process did not start.");
      active.binding = this.job.bind(child.pid, readySignal).then(() => { active.bound = true; });
      await this.wait(active.binding, readySignal);
      await this.wait(this.deps.ledger?.record({ id: "setup", pid: child.pid, image: process.platform === "linux" ? basename(process.execPath) : basename(process.execPath).toLowerCase(),
        ...(process.platform === "linux" ? { imageKind: "executable" as const, processGroupLeader: true as const } : {}), ...ownerStamp(), recordedAt: Date.now() }) ?? Promise.resolve(), readySignal);
      combined.throwIfAborted(); active.launched = true; child.stdin?.write(request + "\n");
      const code = await this.wait(completed, combined);
      while (await this.job.active(child.pid, combined) > 1) await this.pause(combined);
      // The anchor is the last live process. Its exit now cannot strand a helper.
      combined.throwIfAborted(); active.finishing = true; child.stdin?.end("finish\n");
      await this.wait(closed, AbortSignal.timeout(this.deps.cleanupTimeoutMs ?? 30_000));
      if (await this.job.active(child.pid, combined) !== 0) throw new SetupProcessCleanupPending();
      active.removeBackstop(); await this.wait(this.deps.ledger?.release(child.pid) ?? Promise.resolve(), AbortSignal.timeout(this.deps.cleanupTimeoutMs ?? 30_000)).catch(() => {}); if (this.active === active) this.active = null;
      return { code, output };
    } catch (error) {
      await this.cleanup(active);
      throw error instanceof SetupProcessCleanupPending ? error : new Error(combined.aborted ? "Setup was stopped before owned completion." : "Setup native program could not complete.");
    } finally { combined.removeEventListener("abort", stop); }
  }
  async confirmCleanup(): Promise<void> { if (this.active) await this.cleanup(this.active); }
  async dispose(): Promise<void> { this.closing = true; this.lifetime.abort(); await this.confirmCleanup(); }
}
