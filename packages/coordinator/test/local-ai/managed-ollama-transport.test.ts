import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { ChildSupervisor } from "../../src/supervisor.js";
import { ManagedOllamaTransport } from "../../src/local-ai/managed-ollama-transport.js";
import { windowsConnectionOrigin, type LoopbackConnection } from "../../src/local-ai/windows-connection-origin.js";
import { tempDir } from "../tmp.js";
import { until, untilAsync } from "../wait.js";

const CHILD = join(import.meta.dirname, "../fixtures/managed-http-origin.mjs");
const deferred = () => { let resolve!: (value: boolean) => void; const promise = new Promise<boolean>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const root = await tempDir("arke-private-socket-"), marker = join(root, "requests.jsonl"), release = join(root, "release");
  const supervisor = new ChildSupervisor({ id: "private-socket", command: process.execPath, args: [CHILD], env: { ORIGIN_MARKER: marker, PROVIDER_RELEASE: release }, readyTimeoutMs: 20_000 });
  await supervisor.start(); const origin = supervisor.captureProcessOrigin(); assert(origin);
  return { supervisor, origin, marker, release, base: `http://127.0.0.1:${origin.port}`,
    rows: async () => (await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { body: string; path: string; headers: Record<string, string>; clientPort: number }) };
}

it("prepares two unwritten original sockets and consumes them once for fresh metadata", { timeout: 60_000 }, async () => {
  const h = await fixture(); const ports: number[] = [];
  const transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true,
    verify: async (_origin, connection) => { ports.push(connection.clientPort); return true; } });
  try {
    await transport.prepareMetadata(); assert.equal(ports.length, 2);
    await assert.rejects(readFile(h.marker), { code: "ENOENT" });
    const tags = await transport.fetch(h.base + "/api/tags"); await tags.arrayBuffer();
    const show = await transport.fetch(h.base + "/api/show", { method: "POST", body: JSON.stringify({ model: "fixture" }) }); await show.arrayBuffer();
    assert.equal(ports.length, 2, "the native metadata window contains no new process/helper startup");
    const fresh = await transport.fetch(h.base + "/api/show", { method: "POST", body: JSON.stringify({ model: "fixture" }) }); await fresh.arrayBuffer();
    assert.equal(ports.length, 3, "later metadata is a new verified request, never a cached response");
    assert.deepEqual((await h.rows()).map(row => row.clientPort), ports);
    assert.equal(await transport.stop(), true);
  } finally { await transport.stop(); await h.supervisor.stopAndConfirm(); }
});
it("Stop drains unused prepared sockets and retains preparation proof that ignores cancellation", { timeout: 60_000 }, async () => {
  const h = await fixture(), proof = deferred(); let entered = false;
  const transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true, shutdownMs: 20,
    verify: async () => true });
  try {
    await transport.prepareMetadata(); assert.equal(await transport.stop(), true); assert(!transport.busy());
    await assert.rejects(readFile(h.marker), { code: "ENOENT" });
    const next = new ManagedOllamaTransport({ origin: h.origin, current: () => true, shutdownMs: 20,
      verify: async () => { entered = true; return proof.promise; } });
    try {
      const failed = assert.rejects(next.prepareMetadata()); await until(() => entered, "original preparation proof");
      assert.equal(await next.stop(), false); assert(next.busy()); proof.resolve(true); await failed;
      assert.equal(await next.stop(), true); assert(!next.busy()); await assert.rejects(readFile(h.marker), { code: "ENOENT" });
    } finally { proof.resolve(false); await next.stop(); }
  } finally { proof.resolve(false); await transport.stop(); await h.supervisor.stopAndConfirm(); }
});

it("uses the exact verified socket and forwards only a bounded closed response", { timeout: 60_000 }, async () => {
  const h = await fixture(); let connection: LoopbackConnection | undefined;
  // Injected proof tests HTTP behavior on all platforms; separate tests use the native port.
  const transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true,
    verify: async (_origin, tuple) => { connection = tuple; return true; } });
  try {
    const body = JSON.stringify({ mode: "ok", private: "exact-reviewed-test-body" });
    const response = await transport.fetch(h.base + "/v1/chat/completions", { method: "POST", body, redirect: "error", headers: { "content-type": "application/json", authorization: "Bearer captured-host-key" } });
    assert.match(await response.text(), /fixture-complete/); assert.equal(response.headers.get("set-cookie"), null); assert.equal(response.headers.get("x-internal-trace"), null);
    const rows = await h.rows(); assert.equal(rows.length, 1); assert.equal(rows[0]?.body, body);
    assert.equal(rows[0]?.clientPort, connection?.clientPort, "HTTP must use the socket that was verified, without a pool reconnect");
    assert.equal(rows[0]?.headers.authorization, "Bearer captured-host-key"); assert.equal(rows[0]?.headers.connection, "close");
    assert(!transport.busy()); assert.equal(h.supervisor.pid, h.origin.pid, "HTTP settlement did not stop the inference owner");
    const metadata = await transport.fetch(h.base + "/api/tags"); assert.deepEqual(await metadata.json(), { models: [] });
  } finally { await transport.stop(); await h.supervisor.stopAndConfirm(); }
});

it("refuses alternate destinations, unsupported headers and oversized input before connecting", { timeout: 60_000 }, async () => {
  const h = await fixture(); let proofs = 0;
  const transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true, verify: async () => { proofs++; return true; } });
  try {
    const input = { method: "POST", body: "{}" };
    for (const url of [h.base.replace("127.0.0.1", "localhost") + "/v1/chat/completions", h.base + "/v1/chat/completions?extra=1", h.base + "/v1/chat/completions#fragment", h.base + "/api/pull", "http://127.0.0.1:1/v1/chat/completions", h.base.replace("http://", "http://user@") + "/v1/chat/completions"]) {
      await assert.rejects(transport.fetch(url, input), /managed private connection/);
    }
    await assert.rejects(transport.fetch(h.base + "/v1/chat/completions", { ...input, body: "x".repeat(1024 ** 2 + 1) }));
    await assert.rejects(transport.fetch(h.base + "/api/show", { ...input, body: "x".repeat(4097) }));
    await assert.rejects(transport.fetch(h.base + "/api/tags", { ...input, method: "GET" }));
    await assert.rejects(transport.fetch(h.base + "/v1/chat/completions", { ...input, headers: { "x-native-trace": "not permitted" } }));
    await assert.rejects(transport.fetch(new Request(h.base + "/api/tags")));
    await assert.rejects(transport.fetch("not a URL"), error => {
      assert(error instanceof Error); assert.equal("input" in error, false); assert.match(error.message, /managed private connection/); return true;
    });
    assert.equal(proofs, 0); await assert.rejects(readFile(h.marker), { code: "ENOENT" });
    assert.throws(() => new ManagedOllamaTransport({ origin: { ...h.origin }, current: () => true }));
  } finally { await transport.stop(); await h.supervisor.stopAndConfirm(); }
});

it("retains a timed-out proof and refuses any late dispatch", { timeout: 60_000 }, async () => {
  const h = await fixture(), proof = deferred(); let entered = false;
  const transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true, timeoutMs: 5000, shutdownMs: 20,
    verify: async () => { entered = true; return proof.promise; } });
  try {
    const failed = assert.rejects(transport.fetch(h.base + "/v1/chat/completions", { method: "POST", body: "{}" }));
    await until(() => entered, "proof starts before observation timeout"); await failed; assert(transport.busy());
    assert.equal(await transport.stop(), false); proof.resolve(true);
    await until(() => !transport.busy(), "timed-out proof owner finally closes");
    await assert.rejects(readFile(h.marker), { code: "ENOENT" });
  } finally { proof.resolve(false); await transport.stop(); await h.supervisor.stopAndConfirm(); }
});
it("sealing refuses a proof-waiting provider dispatch without releasing its original cleanup owner", { timeout: 60_000 }, async () => {
  const h = await fixture(), proof = deferred(); let entered = false;
  const transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true, verify: async () => { entered = true; return proof.promise; } });
  try {
    const failed = assert.rejects(transport.fetch(h.base + "/v1/chat/completions", { method: "POST", body: "{}" }));
    await until(() => entered, "original provider proof is pending"); transport.seal(); assert(transport.busy());
    await assert.rejects(transport.fetch(h.base + "/api/tags")); proof.resolve(true); await failed;
    assert(!transport.busy()); assert(h.origin.current()); await assert.rejects(readFile(h.marker), { code: "ENOENT" });
  } finally { proof.resolve(false); await transport.stop(); await h.supervisor.stopAndConfirm(); }
});
it("sealing preserves the original already-sent provider response until its bounded completion", { timeout: 60_000 }, async () => {
  const h = await fixture(), transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true, verify: async () => true });
  try {
    const response = transport.fetch(h.base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ mode: "hold" }) });
    await untilAsync(async () => !!await readFile(h.marker, "utf8").catch(() => ""), "the provider accepted the original request");
    transport.seal(); assert(transport.busy()); await assert.rejects(transport.fetch(h.base + "/api/tags"));
    await writeFile(h.release, "complete"); assert.match(await (await response).text(), /fixture-complete/);
    assert(!transport.busy()); assert(h.origin.current()); assert.equal((await h.rows()).length, 1);
  } finally { await writeFile(h.release, "finish"); await transport.stop(); await h.supervisor.stopAndConfirm(); }
});

it("retains cancelled proof work until it actually settles and never sends on a late answer", { timeout: 60_000 }, async () => {
  const h = await fixture(), proof = deferred(); let entered = false;
  const transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true, shutdownMs: 20,
    verify: async () => { entered = true; return proof.promise; } });
  try {
    const failed = assert.rejects(transport.fetch(h.base + "/v1/chat/completions", { method: "POST", body: "{}" }), /managed private connection/);
    await until(() => entered, "connected proof admission");
    assert.equal(await transport.stop(), false); await failed; assert(transport.busy());
    await assert.rejects(readFile(h.marker), { code: "ENOENT" });
    proof.resolve(true); await until(() => !transport.busy(), "original proof and socket close");
    assert.equal(await transport.stop(), true); await assert.rejects(readFile(h.marker), { code: "ENOENT" });
    await assert.rejects(transport.fetch(h.base + "/api/tags"));
  } finally { proof.resolve(false); await transport.stop(); await h.supervisor.stopAndConfirm(); }
});

it("rechecks original service ownership after proof and before any HTTP bytes", { timeout: 60_000 }, async () => {
  const h = await fixture(), proof = deferred(); let entered = false, current = true;
  const transport = new ManagedOllamaTransport({ origin: h.origin, current: () => current,
    verify: async () => { entered = true; return proof.promise; } });
  try {
    const failed = assert.rejects(transport.fetch(h.base + "/v1/chat/completions", { method: "POST", body: "{}" }));
    await until(() => entered, "held original proof"); current = false; proof.resolve(true); await failed;
    assert(!transport.busy()); await assert.rejects(readFile(h.marker), { code: "ENOENT" });
  } finally { proof.resolve(false); await transport.stop(); await h.supervisor.stopAndConfirm(); }
});

it("bounds concurrent abandoned proof owners without admitting a replacement", { timeout: 60_000 }, async () => {
  const h = await fixture(), proof = deferred(); let proofs = 0;
  const transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true, shutdownMs: 20,
    verify: async () => { proofs++; return proof.promise; } });
  const pending = Array.from({ length: 8 }, () => assert.rejects(transport.fetch(h.base + "/api/tags")));
  try {
    await until(() => proofs === 8, "eight bounded connection owners");
    await assert.rejects(transport.fetch(h.base + "/api/tags")); assert.equal(proofs, 8);
    assert.equal(await transport.stop(), false); await Promise.all(pending); assert(transport.busy());
    proof.resolve(false); await until(() => !transport.busy(), "original connection owners close");
    await assert.rejects(readFile(h.marker), { code: "ENOENT" });
  } finally { proof.resolve(false); await transport.stop(); await h.supervisor.stopAndConfirm(); }
});

it("refuses oversized, redirected, failed or mistyped upstream responses without leaking raw content or retrying", { timeout: 60_000 }, async () => {
  const h = await fixture();
  const transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true, verify: async () => true });
  try {
    for (const mode of ["declared", "stream", "redirect", "failed", "wrong-type"]) {
      await assert.rejects(transport.fetch(h.base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ mode }) }), error => {
        assert(error instanceof Error); assert.match(error.message, /managed private connection/); assert(!error.message.includes("private upstream error")); return true;
      });
    }
    assert.equal((await h.rows()).length, 5); assert(!transport.busy());
  } finally { await transport.stop(); await h.supervisor.stopAndConfirm(); }
});

it("cancels a pending response without claiming that the provider process or inference stopped", { timeout: 60_000 }, async () => {
  const h = await fixture(), abort = new AbortController();
  const transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true, verify: async () => true });
  try {
    const failed = assert.rejects(transport.fetch(h.base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ mode: "hold" }), signal: abort.signal }));
    await until(() => transport.busy(), "retained response owner");
    await untilAsync(async () => !!await readFile(h.marker, "utf8").catch(() => ""), "provider accepts one pending response");
    abort.abort(); await failed; await until(() => !transport.busy(), "HTTP response close");
    assert(h.origin.current()); assert.equal(h.supervisor.pid, h.origin.pid); assert.equal((await h.rows()).length, 1);
  } finally { await transport.stop(); await h.supervisor.stopAndConfirm(); }
});

it("uses actual Windows process/socket proof for a complete private HTTP request", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const h = await fixture(); let connection: LoopbackConnection | undefined;
  const transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true,
    verify: async (origin, tuple, signal) => { connection = tuple; return windowsConnectionOrigin(origin, tuple, signal); } });
  try {
    const response = await transport.fetch(h.base + "/v1/chat/completions", { method: "POST", body: "{}" });
    assert.match(await response.text(), /fixture-complete/);
    const rows = await h.rows(); assert.equal(rows.length, 1); assert.equal(rows[0]?.clientPort, connection?.clientPort);
    assert(h.origin.current()); assert(!transport.busy());
  } finally { await transport.stop(); await h.supervisor.stopAndConfirm(); }
});

it("keeps the default native transport closed on platforms without qualified process/socket proof", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const h = await fixture(), transport = new ManagedOllamaTransport({ origin: h.origin, current: () => true });
  try {
    await assert.rejects(transport.fetch(h.base + "/v1/chat/completions", { method: "POST", body: "{}" }));
    await assert.rejects(readFile(h.marker), { code: "ENOENT" }); assert(h.origin.current()); assert(!transport.busy());
  } finally { await transport.stop(); await h.supervisor.stopAndConfirm(); }
});
