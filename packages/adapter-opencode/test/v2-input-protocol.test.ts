import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { HarnessAdapter } from "@arke-studio/contracts";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";

/**
 * T-1 evidence against the shipped binary, without a model/provider call. The isolated profile
 * has no credentials, all prompts use admission-only mode, and only this test's child is killed.
 * These observations do not qualify the engine for native steering; see docs/development/.
 */
it("measures the pinned native inbox without mistaking admission for active-turn targeting", {
  skip: !process.env["ARKE_TEST_OPENCODE2"], timeout: 60_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "arke-input-protocol-"));
  const cwd = join(profile, "session");
  await mkdir(cwd);
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, { HOME: profile, USERPROFILE: profile,
    XDG_CONFIG_HOME: join(profile, ".config"), XDG_DATA_HOME: join(profile, ".local", "share") });
  const child = spawn(process.env["ARKE_TEST_OPENCODE2"]!, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let password: string | null = null;
  let pending = "";
  let spawnError = false;
  child.on("error", () => { spawnError = true; });
  child.stderr.resume();
  child.stdout.on("data", chunk => {
    pending += String(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^server password (\S+)$/.exec(line.trim());
      if (match) password = match[1]!;
    }
  });
  const baseUrl = () => `http://127.0.0.1:${port}`;
  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(baseUrl() + path, { method,
      headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }
  try {
    const deadline = Date.now() + 35_000;
    while (!password) {
      assert.ok(!spawnError && child.exitCode === null && Date.now() < deadline, "native launch did not complete");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const health = await request("GET", "/api/health");
    assert.equal(health.body.version, "0.0.0-next-17444", "this measurement must be repeated for a different build");
    const adapter: HarnessAdapter = new OpenCodeV2Adapter({ baseUrl, password: () => password });
    assert.equal(adapter.nativeInput, undefined, "inbox support alone must not advertise native steering");
    const created = await request("POST", "/api/session", { location: { directory: cwd.replaceAll("\\", "/") } });
    assert.equal(created.status, 200);
    const sessionId = created.body.data.id as string;
    const input = { id: `msg_${Date.now().toString(16)}${"a".repeat(20)}`,
      text: "Synthetic admission-only input. No model call.", delivery: "steer", resume: false,
      expectedExecutionID: "nonexistent-execution" };
    const first = await request("POST", `/api/session/${sessionId}/prompt`, input);
    assert.equal(first.status, 200, "the native endpoint ignores an expected-execution field");
    assert.equal(first.body.data.id, input.id);
    const duplicate = await request("POST", `/api/session/${sessionId}/prompt`, input);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.data.id, input.id);
    assert.equal((await request("POST", `/api/session/${sessionId}/prompt`, { ...input, text: "Changed direction" })).status, 409);
    const inbox = await request("GET", `/api/session/${sessionId}/inbox`);
    assert.equal(inbox.body.data.length, 1);
    assert.equal((await request("DELETE", `/api/session/${sessionId}/inbox/${input.id}`)).status, 204);
    assert.equal((await request("GET", `/api/session/${sessionId}/inbox`)).body.data.length, 0);
    assert.equal((await request("POST", `/api/session/${sessionId}/interrupt`, {})).status, 204,
      "an idle interrupt also succeeds, so HTTP success cannot identify a settled execution");
  } finally {
    if (child.exitCode === null && !spawnError) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
