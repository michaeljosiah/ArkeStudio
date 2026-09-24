import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { codexServerArgs } from "./discovery.js";

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
export interface RpcOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  killProcess?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  onNotification: (method: string, params: JsonObject) => void;
  onRequest: (method: string, params: JsonObject) => Promise<{ result: unknown; delivered?: () => void }>;
  onFailure: (error: Error) => void;
}
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }

/** Private JSONL, not a loopback listener. Unknown requests never become approval prompts. */
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly late = new Map<number, (value: unknown) => void>();
  private nextId = 0;
  private stopped = false;
  private disposal: Promise<void> | null = null;
  private buffer = "";
  constructor(private readonly opts: RpcOptions) {}

  async start(): Promise<void> {
    const child = spawn(this.opts.command, this.opts.args ?? codexServerArgs(this.opts.command), {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: this.opts.env ?? process.env,
      // A platform host supplies its ledger/leash. Standalone Linux callers can kill our group.
      detached: process.platform !== "win32",
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => this.consume(data));
    // Drain stderr without forwarding credentials, filesystem paths or server prompts to logs.
    child.stderr.resume();
    child.on("error", () => { this.fail(new Error("Codex app-server could not start.")); void this.dispose(); });
    child.on("exit", () => { this.fail(new Error("Codex app-server exited.")); void this.dispose(); });
    await this.opts.onSpawn?.(child);
    if (this.stopped) throw new Error("Codex app-server could not start.");
  }

  private consume(data: string): void {
    this.buffer += data;
    if (this.buffer.length > 16 * 1024 * 1024) { this.fail(new Error("Codex sent an oversized protocol message.")); void this.dispose(); return; }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: JsonObject;
      try { message = object(JSON.parse(line)); }
      catch { this.fail(new Error("Codex sent malformed protocol data.")); void this.dispose(); return; }
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          const id = message.id;
          void this.opts.onRequest(message.method, object(message.params)).then(
            async reply => { await this.write({ id, result: reply.result }); reply.delivered?.(); },
            () => this.write({ id, error: { code: -32601, message: "Denied by Arke Studio confinement." } }),
          ).catch(() => {});
        } else this.opts.onNotification(message.method, object(message.params));
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (pending) {
          pending.cleanup();
          // Do not surface raw server errors: they can contain configured headers or tokens.
          message.error ? pending.reject(new Error("Codex rejected the app-server request.")) : pending.resolve(message.result);
        } else {
          this.late.get(message.id)?.(message.result); this.late.delete(message.id);
        }
      } else { this.fail(new Error("Codex sent an invalid protocol envelope.")); void this.dispose(); return; }
    }
  }

  async write(message: unknown): Promise<void> {
    if (this.stopped || !this.child) throw new Error("Codex app-server is not running.");
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve()));
  }

  request(method: string, params: unknown, signal?: AbortSignal, onLateResult?: (value: unknown) => void): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error("Codex request cancelled."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const stop = (error: Error) => {
        this.pending.delete(id); cleanup();
        if (onLateResult) this.late.set(id, onLateResult);
        reject(error);
      };
      const abort = () => stop(new Error("Codex request cancelled."));
      const timer = setTimeout(() => stop(new Error("Codex app-server request timed out.")), this.opts.requestTimeoutMs ?? 30_000);
      timer.unref();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      void this.write({ id, method, params }).catch(() => stop(new Error("Codex app-server transport closed.")));
    });
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(error); }
    this.pending.clear(); this.late.clear();
    this.opts.onFailure(error);
  }

  dispose(): Promise<void> {
    return this.disposal ??= this.disposeOnce();
  }

  private async disposeOnce(): Promise<void> {
    this.fail(new Error("Codex adapter disposed."));
    const child = this.child; this.child = null;
    if (!child) return;
    child.stdin.destroy();
    if (this.opts.killProcess) await this.opts.killProcess(child);
    else if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    else if (child.pid) {
      await new Promise<void>(resolve => {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => { child.kill(); resolve(); }); killer.once("exit", () => resolve());
      });
    }
  }
}
