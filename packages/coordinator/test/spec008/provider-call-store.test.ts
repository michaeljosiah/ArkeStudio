import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, it } from "node:test";
import type { ProviderTransportDiagnostic } from "@arke-studio/contracts";
import { ProviderCallStore } from "../../src/providers/call-store.js";
import { AppLog } from "../../src/app-log.js";
import { SecretRegistry } from "../../src/redact.js";

const RESET_DIAGNOSTIC: ProviderTransportDiagnostic = {
  category: "connection-reset",
  code: "ECONNRESET",
  syscall: "read",
  errorName: "TypeError",
  safeMessage: "the connection closed before the response completed",
  causes: [{ name: "Error", code: "ECONNRESET", syscall: "read" }],
  deadline: null,
  policy: null,
};

describe("provider call store", () => {
  it("persists, folds after restart, correlates jobs, and scrubs credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-provider-calls-"));
    const path = join(dir, "calls.jsonl");
    const secrets = new SecretRegistry();
    secrets.register("sk-super-secret");
    const store = new ProviderCallStore(path, secrets);
    const jobId = `jb_${"0".repeat(26)}`;
    const id = await store.start({
      provider: "openai",
      operation: "submit",
      context: { jobId, attempt: 1, model: "gpt-image-2" },
      method: "POST",
      endpoint: "https://api.openai.com/v1/images/edits",
      headers: { authorization: "Bearer sk-super-secret", "content-type": "multipart/form-data" },
      body: { prompt: "A private portrait", nested: { apiKey: "sk-super-secret" } },
    });
    await store.finish(id, {
      status: 400,
      headers: { "x-request-id": "req-1" },
      body: { error: { message: "bad request sk-super-secret" } },
    });
    await store.drain();
    const raw = await readFile(path, "utf8");
    assert.doesNotMatch(raw, /sk-super-secret/);
    assert.match(raw, /A private portrait/);

    const reopened = new ProviderCallStore(path, secrets);
    const calls = await reopened.listForJob(jobId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.status, "rejected");
    assert.equal(calls[0]?.httpStatus, 400);
    assert.equal(calls[0]?.request.headers.authorization, "[redacted]");
    const response = calls[0]?.response?.body as { error: { message: string } } | undefined;
    assert.ok(response);
    assert.equal(response.error.message, "bad request [redacted]");
  });

  it("keeps an interrupted call pending so its outcome remains unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-provider-pending-"));
    const path = join(dir, "calls.jsonl");
    const jobId = `jb_${"1".repeat(26)}`;
    const store = new ProviderCallStore(path, new SecretRegistry());
    await store.start({
      provider: "openai",
      operation: "submit",
      context: { jobId, attempt: 1 },
      method: "POST",
      endpoint: "https://api.openai.com/v1/images/edits",
      headers: {},
      body: {},
    });
    const calls = await new ProviderCallStore(path, new SecretRegistry()).listForJob(jobId);
    assert.equal(calls[0]?.status, "pending");
    assert.equal(calls[0]?.response, null);
  });

  it("persists the safe cause and writes a payload-free operational record that survives restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-provider-transport-"));
    const registry = new SecretRegistry();
    registry.register("sk-secret");
    const store = new ProviderCallStore(join(dir, "calls.jsonl"), registry);
    const logPath = join(dir, "app.jsonl");
    const log = new AppLog(logPath, registry);
    store.setTransportFailureSink((record) => void log.append(record));
    const id = await store.start({
      provider: "openai",
      operation: "submit",
      method: "POST",
      endpoint: "https://private.example/v1/images?signature=secret",
      headers: { authorization: "Bearer sk-secret" },
      body: { prompt: "private world prose" },
    });
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET at C:\\Users\\private"), { code: "ECONNRESET", syscall: "read" }),
    });
    await store.fail(id, error, {
      category: "connection-reset",
      code: "ECONNRESET",
      syscall: "read",
      errorName: "TypeError",
      safeMessage: "the connection closed before the response completed",
      causes: [
        { name: "TypeError", code: null, syscall: null },
        { name: "Error", code: "ECONNRESET", syscall: "read" },
      ],
      deadline: null,
      policy: {
        implementation: "node-undici",
        runtime: "v22.test",
        proxyMode: "direct",
        connectMs: 10_000,
        headersMs: 540_000,
        bodyMs: 120_000,
        operationMs: 600_000,
      },
    });
    await store.drain();
    await log.drain();

    const calls = await new ProviderCallStore(join(dir, "calls.jsonl"), registry).listRecent();
    assert.equal(calls[0]?.status, "transport-failed");
    assert.equal(calls[0]?.error?.code, "ECONNRESET");
    assert.ok((calls[0]?.elapsedMs ?? -1) >= 0);

    const restarted = new AppLog(logPath, registry);
    const recent = await restarted.tail(100);
    assert.equal(recent.length, 1);
    const record = JSON.parse(recent[0]!) as Record<string, unknown>;
    assert.equal(record["kind"], "provider.transport-failed");
    assert.equal(record["category"], "connection-reset");
    assert.equal(record["outcomeWitnessed"], false);
    assert.doesNotMatch(recent[0]!, /private\.example|world prose|signature|sk-secret|Users/);
  });

  it("keeps a witnessed HTTP status when response-body capture fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-provider-body-timeout-"));
    const records: Array<{ outcomeWitnessed: boolean }> = [];
    const store = new ProviderCallStore(join(dir, "calls.jsonl"), new SecretRegistry());
    store.setTransportFailureSink((record) => records.push(record));
    const id = await store.start({
      provider: "openai",
      operation: "submit",
      method: "POST",
      endpoint: "https://api.openai.com/v1/images/generations",
      headers: {},
      body: {},
    });
    await store.respond(id, { status: 200, headers: { "x-request-id": "req-1" } });
    await store.fail(id, new TypeError("terminated"), {
      category: "body-timeout",
      code: "UND_ERR_BODY_TIMEOUT",
      syscall: "read",
      errorName: "TypeError",
      safeMessage: "response-body inactivity deadline reached",
      causes: [{ name: "BodyTimeoutError", code: "UND_ERR_BODY_TIMEOUT", syscall: "read" }],
      deadline: { kind: "body", ms: 120_000 },
      policy: null,
    });
    const calls = await store.listRecent();
    assert.equal(calls[0]?.httpStatus, 200);
    assert.deepEqual(calls[0]?.response, { headers: { "x-request-id": "req-1" }, body: null });
    assert.equal(records[0]?.outcomeWitnessed, true);
  });

  it("keeps a completed 5xx response distinct from a rejected request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-provider-server-error-"));
    const store = new ProviderCallStore(join(dir, "calls.jsonl"), new SecretRegistry());
    const id = await store.start({
      provider: "openai",
      operation: "submit",
      method: "POST",
      endpoint: "https://api.openai.com/v1/images/generations",
      headers: {},
      body: {},
    });
    await store.finish(id, { status: 503, headers: {}, body: { error: "unavailable" } });
    const calls = await store.listRecent();
    assert.equal(calls[0]?.status, "server-error");
    assert.equal(calls[0]?.httpStatus, 503);
  });

  it("serializes response, finish, and failure transitions so stale snapshots cannot resurrect a call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-provider-races-"));
    const store = new ProviderCallStore(join(dir, "calls.jsonl"), new SecretRegistry());
    const start = (endpoint: string) =>
      store.start({
        provider: "openai",
        operation: "submit",
        method: "POST",
        endpoint,
        headers: {},
        body: {},
      });

    const failedFirst = await start("https://api.openai.com/fail-first");
    await Promise.all([
      store.fail(failedFirst, new TypeError("fetch failed"), RESET_DIAGNOSTIC),
      store.respond(failedFirst, { status: 200, headers: {} }),
      store.finish(failedFirst, { status: 200, headers: {}, body: { data: [] } }),
    ]);
    const first = (await store.listRecent()).find((record) => record.id === failedFirst);
    assert.equal(first?.status, "transport-failed");
    assert.equal(first?.httpStatus, null);

    const witnessedFirst = await start("https://api.openai.com/witness-first");
    await Promise.all([
      store.respond(witnessedFirst, { status: 400, headers: { "x-request-id": "req-2" } }),
      store.fail(witnessedFirst, new TypeError("terminated"), RESET_DIAGNOSTIC),
    ]);
    const second = (await store.listRecent()).find((record) => record.id === witnessedFirst);
    assert.equal(second?.status, "transport-failed");
    assert.equal(second?.httpStatus, 400);
    assert.deepEqual(second?.response, { headers: { "x-request-id": "req-2" }, body: null });
  });

  it("drains detached response capture before the write queue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arke-provider-detached-capture-"));
    const store = new ProviderCallStore(join(dir, "calls.jsonl"), new SecretRegistry());
    let release: (() => void) | null = null;
    const capture = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.track(capture);
    let drained = false;
    const draining = store.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    release!();
    await draining;
    assert.equal(drained, true);
  });
});
