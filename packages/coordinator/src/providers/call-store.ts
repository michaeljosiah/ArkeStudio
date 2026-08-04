import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  ProviderCallRecordSchema,
  newId,
  type ProviderCallRecord,
  type ProviderId,
} from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";
import { REDACTED, type SecretRegistry } from "../redact.js";

const MAX_CALLS = 2_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_STRING = 64 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
const SECRET_FIELD = /(api[-_]?key|authorization|cookie|password|secret|token|credential)/i;
const execFileAsync = promisify(execFile);

async function lockDown(path: string): Promise<void> {
  try {
    if (process.platform === "win32") {
      const user = `${process.env["USERDOMAIN"] ?? "."}\\${process.env["USERNAME"] ?? ""}`;
      await execFileAsync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${user}:F`], {
        timeout: 10_000,
        windowsHide: true,
      });
    } else {
      await chmod(path, 0o600);
    }
  } catch {
    /* Payload history remains usable on filesystems without ACL support. */
  }
}

function stripSignedQueries(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return raw;
    }
  });
}

function sanitize(value: unknown, secrets: SecretRegistry, key = "", depth = 0): unknown {
  if (SECRET_FIELD.test(key)) return REDACTED;
  if (typeof value === "string") {
    const scrubbed = stripSignedQueries(secrets.scrub(value));
    return scrubbed.length > MAX_STRING
      ? `${scrubbed.slice(0, MAX_STRING)}...[truncated ${scrubbed.length - MAX_STRING}]`
      : scrubbed;
  }
  if (depth >= 12) return "[depth limited]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, secrets, "", depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([name, item]) => [name, sanitize(item, secrets, name, depth + 1)]),
    );
  }
  return value;
}

function safeError(error: unknown, secrets: SecretRegistry): ProviderCallRecord["error"] {
  const item = error instanceof Error ? error : new Error(String(error));
  const cause = item.cause as { code?: unknown } | undefined;
  return {
    name: item.name,
    message: secrets.scrub(item.message).slice(0, 4000),
    code: typeof cause?.code === "string" ? cause.code : null,
  };
}

/** Bounded, local-only provider payload history. It is deliberately excluded from support diagnostics. */
export class ProviderCallStore {
  private readonly queue = new WriteQueue();
  private readonly current = new Map<string, ProviderCallRecord>();
  private loaded = false;
  private aclSet = false;

  constructor(
    readonly path: string,
    private readonly secrets: SecretRegistry,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw = "";
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      try {
        const parsed = ProviderCallRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) this.current.set(parsed.data.id, parsed.data);
      } catch {
        /* malformed/torn records do not hide intact call history */
      }
    }
  }

  private append(record: ProviderCallRecord): Promise<void> {
    return this.queue.enqueue(async () => {
      await this.load();
      let clean = ProviderCallRecordSchema.parse(sanitize(record, this.secrets));
      if (Buffer.byteLength(JSON.stringify(clean), "utf8") > MAX_RECORD_BYTES) {
        clean = ProviderCallRecordSchema.parse({
          ...clean,
          response: clean.response
            ? {
                ...clean.response,
                body: { truncated: true, reason: "provider response exceeded the 512 KiB call-record limit" },
              }
            : null,
        });
      }
      if (Buffer.byteLength(JSON.stringify(clean), "utf8") > MAX_RECORD_BYTES) {
        throw new Error("provider call metadata exceeded the 512 KiB record limit");
      }
      if (Buffer.byteLength(JSON.stringify(clean), "utf8") > MAX_RECORD_BYTES) {
        clean = ProviderCallRecordSchema.parse({
          ...clean,
          request: {
            ...clean.request,
            body: { truncated: true, reason: "provider request exceeded the 512 KiB call-record limit" },
          },
        });
      }
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(clean)}\n`, "utf8");
      if (!this.aclSet) {
        await lockDown(this.path);
        this.aclSet = true;
      }
      this.current.set(clean.id, clean);
      const size = await stat(this.path)
        .then((item) => item.size)
        .catch(() => 0);
      if (this.current.size > MAX_CALLS || size > MAX_FILE_BYTES) await this.compact();
    });
  }

  private async compact(): Promise<void> {
    const keep = [...this.current.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, MAX_CALLS)
      .reverse();
    const tmp = join(dirname(this.path), `.tmp-${basename(this.path)}-${process.pid}`);
    await writeFile(
      tmp,
      keep.map((record) => JSON.stringify(record)).join("\n") + (keep.length ? "\n" : ""),
      "utf8",
    );
    await rename(tmp, this.path);
    await lockDown(this.path);
    this.aclSet = true;
    this.current.clear();
    for (const record of keep) this.current.set(record.id, record);
  }

  async start(input: {
    provider: ProviderId;
    operation: string;
    context?: { jobId?: string; attempt?: number; model?: string };
    method: string;
    endpoint: string;
    headers: Record<string, string>;
    body: unknown;
  }): Promise<string> {
    const id = newId("pc");
    await this.append({
      schemaVersion: 1,
      id,
      provider: input.provider,
      operation: input.operation,
      jobId: input.context?.jobId ?? null,
      attempt: input.context?.attempt ?? null,
      model: input.context?.model ?? null,
      method: input.method,
      endpoint: input.endpoint,
      startedAt: new Date().toISOString(),
      completedAt: null,
      elapsedMs: null,
      status: "pending",
      httpStatus: null,
      request: { headers: input.headers, body: input.body },
      response: null,
      error: null,
    });
    return id;
  }

  async finish(
    id: string,
    input: { status: number; headers: Record<string, string>; body: unknown },
  ): Promise<void> {
    await this.load();
    const record = this.current.get(id);
    if (!record) return;
    const completedAt = new Date().toISOString();
    await this.append({
      ...record,
      completedAt,
      elapsedMs: Math.max(0, Date.parse(completedAt) - Date.parse(record.startedAt)),
      status: input.status >= 400 ? "rejected" : record.operation === "submit" ? "accepted" : "succeeded",
      httpStatus: input.status,
      response: { headers: input.headers, body: input.body },
      error: null,
    });
  }

  async fail(id: string, error: unknown): Promise<void> {
    await this.load();
    const record = this.current.get(id);
    if (!record || record.status !== "pending") return;
    const completedAt = new Date().toISOString();
    await this.append({
      ...record,
      completedAt,
      elapsedMs: Math.max(0, Date.parse(completedAt) - Date.parse(record.startedAt)),
      status: "transport-failed",
      error: safeError(error, this.secrets),
    });
  }

  async listForJob(jobId: string): Promise<ProviderCallRecord[]> {
    await this.queue.enqueue(() => this.load());
    return [...this.current.values()]
      .filter((record) => record.jobId === jobId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((record) => ProviderCallRecordSchema.parse(sanitize(record, this.secrets)));
  }

  async listRecent(): Promise<ProviderCallRecord[]> {
    await this.queue.enqueue(() => this.load());
    return [...this.current.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 100)
      .map((record) => ProviderCallRecordSchema.parse(sanitize(record, this.secrets)));
  }

  drain(): Promise<void> {
    return this.queue.drain();
  }
}
