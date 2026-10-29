import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { ChildSupervisor } from "../../src/supervisor.js";
import { ManagedStudioWriterTransport } from "../../src/harness/managed-writer-transport.js";
import { windowsConnectionOrigin } from "../../src/local-ai/windows-connection-origin.js";
import { tempDir } from "../tmp.js";
import { until, untilAsync } from "../wait.js";

const CHILD = join(import.meta.dirname, "../fixtures/managed-http-origin.mjs"), authorization = "Basic " + Buffer.from("opencode:writer-fixture").toString("base64");
const request = () => ({ model: "ollama/test", system: "private fixture system", prompt: "private captured prompt", outputTokenLimit: 4096 });
async function fixture(hold = false) {
  const root = await tempDir("arke-native-writer-"), marker = join(root, "requests.jsonl"), release = join(root, "release");
  const supervisor = new ChildSupervisor({ id: "writer-origin", command: process.execPath, args: [CHILD], readyTimeoutMs: 20_000,
    env: { ORIGIN_MARKER: marker, ...(hold ? { WRITER_RELEASE: release } : {}) } });
  await supervisor.start(); const origin = supervisor.captureProcessOrigin(); assert(origin);
  const base = `http://127.0.0.1:${origin.port}`, directory = root.replaceAll("\\", "/");
  return { root, marker, release, supervisor, origin, base, directory,
    create: JSON.stringify({ location: { directory }, model: { providerID: "ollama", id: "test" } }),
    rows: async () => (await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { path: string; body: string; clientPort: number }) };
}
async function create(h: Awaited<ReturnType<typeof fixture>>, writer: ManagedStudioWriterTransport) {
  assert(writer.bindDirectory(h.root, "studio-assistant"));
  const response = await writer.fetch(h.base + "/api/session", { method: "POST", body: h.create, headers: { authorization } });
  const value = await response.json() as { data: { id: string } }; assert.equal(value.data.id, "writer-session"); assert(writer.bindSession(value.data.id));
}

it("captures the selected effort and refuses a changed native model reference before sending", { timeout: 60_000 }, async () => {
  const h = await fixture(), input = { ...request(), variant: "high" as "high" | "low" };
  let proofs = 0;
  const writer = new ManagedStudioWriterTransport({ origin: h.origin, current: () => true, request: input, authorization, verify: async () => { proofs++; return true; } });
  try {
    assert(writer.bindDirectory(h.root, "studio-assistant")); input.variant = "low";
    const body = (variant?: string) => JSON.stringify({ location: { directory: h.directory }, model: { providerID: "ollama", id: "test", ...(variant ? { variant } : {}) } });
    for (const variant of [undefined, "default", "low"]) await assert.rejects(writer.fetch(h.base + "/api/session", { method: "POST", body: body(variant), headers: { authorization } }));
    assert.equal(proofs, 0);
    const accepted = await writer.fetch(h.base + "/api/session", { method: "POST", body: body("high"), headers: { authorization } }); await accepted.arrayBuffer();
    assert.equal((await h.rows())[0]?.body, body("high")); assert.equal(proofs, 1);
  } finally { await writer.close(); await h.supervisor.stopAndConfirm(); }
});

it("pins one private directory/session and preserves closed native 204/404 status without raw errors", { timeout: 60_000 }, async () => {
  const h = await fixture(), writer = new ManagedStudioWriterTransport({ origin: h.origin, current: () => true, request: request(), authorization, verify: async () => true });
  try {
    assert.equal(writer.bindSession("writer-session"), false); await create(h, writer);
    assert.equal(writer.bindDirectory(h.root, "studio-assistant"), false); assert.equal(writer.bindSession("other"), false);
    const agent = await writer.fetch(h.base + "/api/session/writer-session/agent", { method: "POST", body: JSON.stringify({ agent: "studio-assistant" }), headers: { authorization } });
    assert.equal(agent.status, 204); assert.equal(await agent.text(), "");
    const generated = await writer.fetch(h.base + "/api/session/writer-session/generate", { method: "POST", body: JSON.stringify({ prompt: request().prompt }), headers: { authorization } });
    assert.deepEqual(await generated.json(), { data: { text: "private writer result" } });
    await assert.rejects(writer.fetch(h.base + "/api/session/writer-session/generate", { method: "POST", body: JSON.stringify({ prompt: request().prompt }), headers: { authorization } }));
    writer.seal();
    const removed = await writer.fetch(h.base + "/api/session/writer-session", { method: "DELETE", headers: { authorization } }); assert.equal(removed.status, 204);
    const absent = await writer.fetch(h.base + "/api/session/writer-session", { headers: { authorization } }); assert.equal(absent.status, 404); assert.equal(await absent.text(), "");
    assert(!absent.statusText.includes("PRIVATE_NATIVE_ERROR"));
    assert.equal((await h.rows()).filter(row => row.path.endsWith("/generate")).length, 1); assert(h.origin.current());
  } finally { await writer.close(); await h.supervisor.stopAndConfirm(); }
});

it("rejects alternate scope, session, credentials, prompt and tool paths before process proof", { timeout: 60_000 }, async () => {
  const h = await fixture(); let proofs = 0;
  const input = request(), writer = new ManagedStudioWriterTransport({ origin: h.origin, current: () => true, request: input, authorization, verify: async () => { proofs++; return true; } });
  try {
    await assert.rejects(writer.fetch(h.base + "/api/session", { method: "POST", body: h.create, headers: { authorization } })); assert.equal(proofs, 0);
    assert.equal(writer.bindDirectory(h.root, "world-builder"), false); await create(h, writer); const baseline = proofs;
    input.prompt = "MUTATED_CALLER_PROMPT";
    for (const [path, method, body] of [
      ["/api/session/other", "GET", undefined], ["/api/session/writer-session/prompt", "POST", "{}"],
      ["/api/session/writer-session/generate", "POST", JSON.stringify({ prompt: input.prompt })],
      ["/api/session/writer-session/permission/permission-one/reply", "POST", JSON.stringify({ decision: "always" })],
      ["/api/credential/secret", "DELETE", undefined], ["/api/model?location%5Bdirectory%5D=other", "GET", undefined],
    ] as const) await assert.rejects(writer.fetch(h.base + path, { method, ...(body === undefined ? {} : { body }), headers: { authorization } }));
    const scoped = new URL(h.base + "/api/model"); scoped.searchParams.set("location[directory]", h.directory);
    await assert.rejects(writer.fetch(scoped, { headers: { authorization: "Basic d3Jvbmc=" } }));
    assert.equal(proofs, baseline); assert.equal((await h.rows()).length, 1);
    const metadata = await writer.fetch(scoped, { headers: { authorization } }); assert.equal(metadata.status, 200); await metadata.arrayBuffer();
    assert.equal(proofs, baseline + 1);
  } finally { await writer.close(); await h.supervisor.stopAndConfirm(); }
});

it("seals a generation waiting on proof without sending late private bytes", { timeout: 60_000 }, async () => {
  const h = await fixture(); let held = false, entered = false, finish!: (value: boolean) => void;
  const proof = new Promise<boolean>(resolve => { finish = resolve; });
  const writer = new ManagedStudioWriterTransport({ origin: h.origin, current: () => true, request: request(), authorization,
    verify: async () => { if (!held) return true; entered = true; return proof; } });
  try {
    await create(h, writer); held = true;
    const failed = assert.rejects(writer.fetch(h.base + "/api/session/writer-session/generate", { method: "POST", body: JSON.stringify({ prompt: request().prompt }), headers: { authorization } }));
    await until(() => entered, "original private generation proof"); writer.seal(); finish(true); await failed;
    assert(!writer.busy()); assert.equal((await h.rows()).length, 1); assert(writer.current());
  } finally { finish(false); await writer.close(); await h.supervisor.stopAndConfirm(); }
});

it("sealing blocks new dispatch while retaining the already-sent native completion observation", { timeout: 60_000 }, async () => {
  const h = await fixture(true), writer = new ManagedStudioWriterTransport({ origin: h.origin, current: () => true, request: request(), authorization, verify: async () => true });
  try {
    await create(h, writer);
    const generated = writer.fetch(h.base + "/api/session/writer-session/generate", { method: "POST", body: JSON.stringify({ prompt: request().prompt }), headers: { authorization } });
    await untilAsync(async () => (await h.rows()).some(row => row.path.endsWith("/generate")), "original native generation is sent");
    writer.seal(); assert(writer.busy()); assert(writer.current());
    await assert.rejects(writer.fetch(h.base + "/api/session/writer-session/generate", { method: "POST", body: JSON.stringify({ prompt: request().prompt }), headers: { authorization } }));
    await writeFile(h.release, "complete original observation");
    assert.deepEqual(await (await generated).json(), { data: { text: "private writer result" } });
    assert(!writer.busy()); assert(h.origin.current()); assert.equal((await h.rows()).filter(row => row.path.endsWith("/generate")).length, 1);
  } finally { await writeFile(h.release, "stop"); await writer.close(); await h.supervisor.stopAndConfirm(); }
});

it("uses actual Windows socket/process proof for the private writer's native API", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const h = await fixture(); const ports: number[] = [];
  const writer = new ManagedStudioWriterTransport({ origin: h.origin, current: () => true, request: request(), authorization,
    verify: async (origin, connection, signal) => { ports.push(connection.clientPort); return windowsConnectionOrigin(origin, connection, signal); } });
  try {
    await create(h, writer);
    const generated = await writer.fetch(h.base + "/api/session/writer-session/generate", { method: "POST", body: JSON.stringify({ prompt: request().prompt }), headers: { authorization } });
    assert.deepEqual(await generated.json(), { data: { text: "private writer result" } });
    assert.deepEqual((await h.rows()).map(row => row.clientPort), ports); assert(h.origin.current());
  } finally { await writer.close(); await h.supervisor.stopAndConfirm(); }
});
