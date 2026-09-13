import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { WINDOWS_FILES_BOOTSTRAP, WINDOWS_FILES_SOURCE } from "./windows-files.js";

export interface FileIdentity { dev: string; ino: string }
export interface FileEntry { name: string; directory: boolean }
const MAX_FILE = 16 * 1024 * 1024;
export class ConfinementError extends Error { constructor() { super("Denied by Arke Studio confinement."); } }
function nativePath(path: string): string {
  if (process.platform !== "win32") return path;
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}
export function within(root: string, target: string): boolean {
  const fold = (value: string) => process.platform === "win32" ? nativePath(value).toLowerCase() : value;
  const base = fold(root); const path = fold(target);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}
export async function resolveRoot(cwd: string): Promise<string> {
  const root = nativePath(await realpath(cwd));
  if (!(await lstat(root)).isDirectory()) throw new Error("Codex needs a session directory.");
  return root;
}
/** Lexical gate only. Actual access MUST use ConfinedFiles' pinned directory capability. */
export function confinedTarget(root: string, raw: string): string {
  if (!raw || raw.includes("\0")) throw new ConfinementError();
  const normal = nativePath(raw);
  const target = isAbsolute(normal) ? resolve(normal) : resolve(root, normal);
  if (!within(root, target)) throw new ConfinementError();
  // Windows alternate streams/device components are not ordinary proposal files.
  if (process.platform === "win32" && relative(root, target).split(sep).some(part => /[:]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new ConfinementError();
  return target;
}
const identity = (stat: { dev: bigint; ino: bigint }): FileIdentity => ({ dev: String(stat.dev), ino: String(stat.ino) });
const sameIdentity = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;
const powershell = () => join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
export async function fileConfinementUnavailable(platform = process.platform): Promise<string | null> {
  if (platform !== "linux" && platform !== "win32") return "Codex confined file tools currently require Windows or Linux.";
  try { await access(platform === "win32" ? powershell() : "/proc/self/fd"); }
  catch { return platform === "win32" ? "Codex confined file tools need Windows PowerShell." : "Codex confined file tools need the Linux /proc/self/fd filesystem."; }
  return null;
}

/** One private broker per top-level tool, reused by every leaf in a search. */
export class WindowsFiles {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly ended: Promise<void>;
  private readonly ready: Promise<void>;
  private rejectReady: (error: Error) => void = () => {};
  private pending: { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;
  private buffer = "";
  private closed = false;
  private startupStage: "launch" | "bootstrap" | "transport" | "source" | "parsed" | "entered" | "assembly" | "emitting" | "native" | "utility" = "launch";
  private stderrCategory: "none" | "syntax" | "security" | "encoding" | "runtime" | "other" = "none";
  private stderrTail = "";
  private readySeen = false;
  private readonly deadline: ReturnType<typeof setTimeout>;
  private readonly abort = () => this.fail(new Error("The confined file operation was cancelled."));
  private readonly exit = () => { this.child.kill(); };
  constructor(private readonly signal: AbortSignal, command = powershell(), args?: string[]) {
    // Static inline source, JSON data on stdin, no profile/module/credential inheritance.
    // Keep argv below CreateProcess's 32,767-character ceiling. Only this fixed bootstrap
    // executes source; the first pipe frame is our static broker, all later frames are JSON.
    // One private UTF-8 reader spans both frames; changing Console.InputEncoding would
    // discard prefetched bytes and invoke console-host code-page APIs for these pipes.
    this.child = spawn(command, args ?? ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_FILES_BOOTSTRAP, "utf16le").toString("base64")], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { SystemRoot: process.env["SystemRoot"], WINDIR: process.env["WINDIR"], TEMP: process.env["TEMP"], TMP: process.env["TMP"], PATH: dirname(powershell()) },
    });
    let readyResolve!: () => void; let readyReject!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    this.rejectReady = readyReject;
    // A helper that cannot initialize is a closed capability, not a pathname fallback.
    const startup = setTimeout(() => this.fail(this.startupError("timed out")), 30_000);
    this.ready.then(() => clearTimeout(startup), () => clearTimeout(startup));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 24 * 1024 * 1024) { this.fail(new Error("The confined file response exceeds its limit.")); return; }
      for (;;) {
        const end = this.buffer.indexOf("\n"); if (end < 0) break;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.startup === "bootstrap" || message.startup === "transport" || message.startup === "source" || message.startup === "parsed" || message.startup === "entered" || message.startup === "assembly" || message.startup === "emitting" || message.startup === "native" || message.startup === "utility") {
            this.startupStage = message.startup; continue;
          }
          if (message.startupError === true) {
            if (message.category === "syntax" || message.category === "security" || message.category === "encoding" || message.category === "runtime") this.stderrCategory = message.category;
            this.fail(this.startupError("failed")); return;
          }
          if (message.ready === true) { this.readySeen = true; readyResolve(); continue; }
          const pending = this.pending; this.pending = null;
          if (!pending) { this.fail(new Error("The confined file helper returned an unexpected response.")); return; }
          if (typeof message.error === "string") pending.reject(new Error(message.error));
          else pending.resolve(message.result as Record<string, unknown>);
        } catch { this.fail(this.readySeen ? new Error("The confined file helper returned an invalid response.") : this.startupError("failed", "invalid output")); }
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-8192);
      const raw = this.stderrTail;
      this.stderrCategory = /PSSecurityException|UnauthorizedAccess|ExecutionPolicy|ConstrainedLanguage|blocked by/i.test(raw) ? "security" :
        /InputEncoding|OutputEncoding|InvalidHandle|handle is invalid/i.test(raw) ? "encoding" :
          /ParseException|ParserError|UnexpectedToken/i.test(raw) ? "syntax" :
            /TypeLoadException|TypeInitializationException|Reflection\.Emit|MethodException|RuntimeException/i.test(raw) ? "runtime" : "other";
    });
    this.child.stdin.on("error", () => this.fail(new Error("The confined file helper stopped.")));
    this.child.on("error", () => this.fail(new Error("Codex's confined Windows file helper is unavailable.")));
    this.ended = new Promise(resolve => this.child.once("close", () => {
      if (!this.closed) this.fail(new Error("The confined file helper stopped."));
      readyReject(this.failure ?? new Error("The confined file helper stopped.")); resolve();
    }));
    this.child.once("exit", () => { readyReject(this.failure ?? this.startupError("failed")); });
    this.deadline = setTimeout(() => this.fail(new Error("The confined file operation exceeded 60 seconds.")), 60_000);
    signal.addEventListener("abort", this.abort, { once: true });
    process.once("exit", this.exit);
    this.child.stdin.write(Buffer.from(WINDOWS_FILES_SOURCE, "utf8").toString("base64") + "\n");
    if (signal.aborted) this.abort();
  }
  private startupError(outcome: "failed" | "timed out", output?: "invalid output"): Error {
    // These labels come only from the fixed bootstrap/broker protocol. Never forward
    // PowerShell stderr, script text, environment values or native exception details.
    const detail = output ?? (this.stderrCategory === "none" ? (this.buffer.length ? "incomplete output" : "no error output") : `${this.stderrCategory} error`);
    return new Error(`Codex's confined Windows file helper ${outcome} during ${this.startupStage} startup (${detail}).`);
  }
  private fail(error: Error): void {
    this.failure ??= error; this.rejectReady(this.failure); this.pending?.reject(this.failure); this.pending = null;
    this.child.kill();
  }
  async request(op: string, path: string, rest: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.ready; this.signal.throwIfAborted(); if (this.failure) throw this.failure;
    if (this.pending || this.closed) throw new Error("The confined file helper is not ready.");
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child.stdin.write(JSON.stringify({ op, path, ...rest }) + "\n", error => { if (error) this.fail(new Error("The confined file helper stopped.")); });
    });
  }
  async close(): Promise<void> {
    if (!this.closed) { this.closed = true; this.child.stdin.end(); this.child.kill(); }
    await this.ended;
    clearTimeout(this.deadline); this.signal.removeEventListener("abort", this.abort); process.removeListener("exit", this.exit);
  }
}

/**
 * Linux: walk from / using O_NOFOLLOW directory descriptors; all later operations are
 * relative to those descriptors through /proc/self/fd. A renamed ancestor cannot redirect
 * them. Windows: the broker uses native descriptor-relative operations while pinning
 * every ancestor against rename; in-place reparse changes cannot redirect relative I/O.
 * Merely checking realpath before open/rename is deliberately never an authorization step.
 */
export class ConfinedFiles {
  private readonly directories = new Map<string, FileHandle>();
  private broker?: WindowsFiles;
  private closed = false;
  private constructor(readonly root: string, private readonly signal: AbortSignal) {}
  static async create(root: string, expected: FileIdentity | undefined, signal: AbortSignal): Promise<ConfinedFiles> {
    signal.throwIfAborted();
    const reason = await fileConfinementUnavailable(); if (reason) throw new Error(reason);
    const files = new ConfinedFiles(root, signal);
    try {
      if (process.platform === "win32") files.broker = new WindowsFiles(signal);
      const actual = await files.pinDirectory(".");
      if (expected && !sameIdentity(actual, expected)) throw new ConfinementError();
      return files;
    } catch (error) { await files.close(); throw error; }
  }
  private async pinAbsolute(path: string, create: boolean): Promise<FileIdentity> {
    this.signal.throwIfAborted();
    if (this.closed) throw new Error("The confined file operation has ended.");
    if (this.broker) return await this.broker.request("pin", path, { create }) as unknown as FileIdentity;
    let current = parse(path).root;
    if (!this.directories.has(current)) this.directories.set(current, await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    for (const part of relative(current, path).split(sep).filter(Boolean)) {
      const parent = this.directories.get(current)!; current = join(current, part);
      if (this.directories.has(current)) continue;
      if (this.directories.size >= 256) throw new Error("The confined operation reached its directory handle limit.");
      const pinned = `/proc/self/fd/${parent.fd}/${part}`;
      let handle: FileHandle;
      try { handle = await open(pinned, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfinementError();
        this.signal.throwIfAborted(); await mkdir(pinned);
        handle = await open(pinned, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      }
      this.directories.set(current, handle);
    }
    return identity(await this.directories.get(path)!.stat({ bigint: true }));
  }
  async pinDirectory(raw: string, create = false): Promise<FileIdentity> { return this.pinAbsolute(confinedTarget(this.root, raw), create); }
  private async leaf(raw: string, create = false): Promise<string> {
    const path = confinedTarget(this.root, raw); if (path === this.root) throw new ConfinementError();
    await this.pinAbsolute(dirname(path), create); this.signal.throwIfAborted();
    return this.broker ? path : `/proc/self/fd/${this.directories.get(dirname(path))!.fd}/${basename(path)}`;
  }
  async read(raw: string, limit = MAX_FILE): Promise<Buffer> {
    const path = await this.leaf(raw);
    if (this.broker) return Buffer.from(String((await this.broker.request("read", path, { limit })).data), "base64");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new ConfinementError();
      if (stat.size > limit) throw new Error("This file exceeds the session read limit.");
      const chunks: Buffer[] = []; let total = 0;
      for (;;) {
        this.signal.throwIfAborted();
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) return Buffer.concat(chunks, total);
        total += bytesRead; if (total > limit) throw new Error("This file exceeds the session read limit.");
        chunks.push(buffer.subarray(0, bytesRead));
      }
    } finally { await handle.close(); }
  }
  async list(raw: string): Promise<FileEntry[]> {
    const path = confinedTarget(this.root, raw); await this.pinAbsolute(path, false);
    if (this.broker) return (await this.broker.request("list", path)).entries as FileEntry[];
    return (await readdir(`/proc/self/fd/${this.directories.get(path)!.fd}`, { withFileTypes: true }))
      .filter(entry => !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory())).slice(0, 3001)
      .map(entry => ({ name: entry.name, directory: entry.isDirectory() }));
  }
  async write(raw: string, content: string): Promise<void> {
    if (Buffer.byteLength(content) > MAX_FILE) throw new Error("The proposed file exceeds 16 MB.");
    const path = await this.leaf(raw, true);
    if (this.broker) { await this.broker.request("write", path, { data: Buffer.from(content).toString("base64") }); return; }
    const checkLeaf = async () => {
      try { const stat = await lstat(path); if (!stat.isFile() || stat.nlink !== 1) throw new ConfinementError(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    await checkLeaf(); this.signal.throwIfAborted();
    const temporary = join(dirname(path), `.arke-codex-write-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      this.signal.throwIfAborted(); await handle.writeFile(content, "utf8"); await handle.close();
      await checkLeaf(); this.signal.throwIfAborted();
      await rename(temporary, path);
    } finally { await handle.close(); await unlink(temporary).catch(() => {}); }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.broker?.close();
    await Promise.all([...this.directories.values()].map(handle => handle.close())); this.directories.clear();
  }
}
export async function captureRootIdentity(root: string, signal = new AbortController().signal): Promise<FileIdentity> {
  const files = await ConfinedFiles.create(root, undefined, signal);
  try { return await files.pinDirectory("."); } finally { await files.close(); }
}
