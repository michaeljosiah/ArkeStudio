import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DIAGNOSTICS_LOG_TAIL_RECORDS } from "@arke-studio/contracts";
import { AppLog } from "../../src/app-log.js";
import { ProviderService } from "../../src/providers/service.js";
import { SecretRegistry } from "../../src/redact.js";
import { tempDir } from "../tmp.js";

/**
 * SPEC-032 R-18: the operational log tail is bounded at 500 records, the bound is the
 * derivation's own, and the read never loads the whole file. Matrix row 29.
 */

async function logAt(dir: string, name = "app.jsonl") {
  const path = join(dir, name);
  return { path, log: new AppLog(path, new SecretRegistry()) };
}

describe("the bounded log tail (R-18)", () => {
  it("row 29: a log of 5,000 records yields at most 500, the newest, parsed", async () => {
    const dir = await tempDir("arke-taillog-");
    const { path, log } = await logAt(dir);
    // Written directly: 5,000 queued appends cost minutes of fsync; the reader only needs bytes.
    const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ at: "2026-08-28T00:00:00.000Z", kind: "note", n: i }));
    await writeFile(path, lines.join("\n") + "\n", "utf8");
    const tail = await log.diagnosticsTail();
    assert.notEqual(tail, "unavailable");
    assert.equal((tail as ReadonlyArray<Record<string, unknown>>).length, DIAGNOSTICS_LOG_TAIL_RECORDS);
    const records = tail as ReadonlyArray<Record<string, unknown>>;
    assert.equal(records[0]!["n"], 4500);
    assert.equal(records[records.length - 1]!["n"], 4999);
  });

  it("spans chunk boundaries without tearing a record", async () => {
    const dir = await tempDir("arke-taillog-");
    const { path, log } = await logAt(dir);
    // ~200 KB of ~200-byte lines: several 64 KB chunks, and no line lands on a boundary by luck.
    const pad = "x".repeat(160);
    const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ at: "2026-08-28T00:00:00.000Z", kind: "note", n: i, pad }));
    await writeFile(path, lines.join("\n") + "\n", "utf8");
    const tail = (await log.diagnosticsTail()) as ReadonlyArray<Record<string, unknown>>;
    assert.equal(tail.length, DIAGNOSTICS_LOG_TAIL_RECORDS);
    for (const [index, record] of tail.entries()) {
      assert.equal(record["n"], 500 + index, "every record parsed whole");
    }
  });

  it("a single line larger than the chunk still reads whole", async () => {
    const dir = await tempDir("arke-taillog-");
    const { path, log } = await logAt(dir);
    const huge = JSON.stringify({ at: "2026-08-28T00:00:00.000Z", kind: "note", blob: "y".repeat(100_000) });
    await writeFile(path, JSON.stringify({ kind: "first" }) + "\n" + huge + "\n", "utf8");
    const tail = (await log.diagnosticsTail()) as ReadonlyArray<Record<string, unknown>>;
    assert.equal(tail.length, 2);
    assert.equal((tail[1]!["blob"] as string).length, 100_000);
  });

  it("a torn final line is not a record; the whole ones before it are", async () => {
    const dir = await tempDir("arke-taillog-");
    const { path, log } = await logAt(dir);
    await writeFile(path, `${JSON.stringify({ kind: "whole" })}\n{"kind":"torn`, "utf8");
    const tail = (await log.diagnosticsTail()) as ReadonlyArray<Record<string, unknown>>;
    assert.equal(tail.length, 1);
    assert.equal(tail[0]!["kind"], "whole");
  });

  it("a log that does not exist yet is a log with nothing in it — never unavailable (R-19)", async () => {
    const dir = await tempDir("arke-taillog-");
    const { log } = await logAt(dir, "never-written.jsonl");
    assert.deepEqual(await log.diagnosticsTail(), []);
  });

  it("an unreadable log is named unavailable, not read as quiet (R-21)", async () => {
    const dir = await tempDir("arke-taillog-");
    // A NUL byte makes open() fail with a non-ENOENT error on every platform — the portable
    // stand-in for permission-denied, which Windows will not fabricate without ACL surgery.
    const log = new AppLog(join(dir, "app\0.jsonl"), new SecretRegistry());
    assert.equal(await log.diagnosticsTail(), "unavailable");
  });

  it("returns records as written — the derivation boundary is the scrub that can say it scrubbed (R-13)", async () => {
    const dir = await tempDir("arke-taillog-");
    const registry = new SecretRegistry();
    const path = join(dir, "app.jsonl");
    const log = new AppLog(path, registry);
    // Written through append, so write-time redaction has already run; what survives it is
    // what the derivation must see raw, or the carried-and-altered marker never fires.
    await log.append({ kind: "note", detail: "key sk-late-secret-1234 rejected" });
    await log.drain();
    registry.register("sk-late-secret-1234");
    const tail = (await log.diagnosticsTail()) as ReadonlyArray<Record<string, unknown>>;
    assert.equal(tail[0]!["detail"], "key sk-late-secret-1234 rejected");
    // tail() — the bundle's read — still scrubs late-registered secrets itself.
    const lines = await log.tail(10);
    assert.match(lines[0]!, /\[redacted\]/);
  });

  it("tail(lines) keeps its contract: the last N raw lines, bounded read, [] on failure", async () => {
    const dir = await tempDir("arke-taillog-");
    const { path, log } = await logAt(dir);
    const lines = Array.from({ length: 250 }, (_, i) => JSON.stringify({ kind: "note", n: i }));
    await writeFile(path, lines.join("\n") + "\n", "utf8");
    const tail = await log.tail(100);
    assert.equal(tail.length, 100);
    assert.match(tail[0]!, /"n":150/);
    assert.match(tail[99]!, /"n":249/);
    const missing = new AppLog(join(dir, "absent.jsonl"), new SecretRegistry());
    assert.deepEqual(await missing.tail(100), []);
  });

  it("markFault stamps the fault's category on the record, so the correlation never re-reads the sentence", async () => {
    const dir = await tempDir("arke-taillog-");
    const log = new AppLog(join(dir, "app.jsonl"), new SecretRegistry());
    const service = new ProviderService(null, {}, log);
    await service.init();
    service.markFault("fal", "quota exhausted for this billing period (HTTP 402)");
    service.markFault("fal", "FAL rejected the key (HTTP 401)");
    await log.drain();
    const tail = (await log.diagnosticsTail()) as ReadonlyArray<Record<string, unknown>>;
    assert.equal(tail[0]!["category"], "billing");
    assert.equal(tail[1]!["category"], "auth");
  });

  it("says when a record lands, after it landed — the re-read trigger (R-33)", async () => {
    const dir = await tempDir("arke-taillog-");
    let notified = 0;
    const log = new AppLog(join(dir, "app.jsonl"), new SecretRegistry(), () => {
      notified += 1;
    });
    await log.append({ kind: "provider.fault", provider: "fal", message: "HTTP 500" });
    await log.append({ kind: "provider.fault", provider: "fal", message: "HTTP 500" });
    await log.drain();
    assert.equal(notified, 2);
    const tail = (await log.diagnosticsTail()) as ReadonlyArray<Record<string, unknown>>;
    assert.equal(tail.length, 2);
    assert.equal(tail[0]!["kind"], "provider.fault");
  });
});
