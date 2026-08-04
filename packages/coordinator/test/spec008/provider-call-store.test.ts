import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, it } from "node:test";
import { ProviderCallStore } from "../../src/providers/call-store.js";
import { SecretRegistry } from "../../src/redact.js";

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
});
