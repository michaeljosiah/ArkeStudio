import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";

/**
 * The credential-store regression gate (SPEC-030 §3.2), against the REAL harness binary.
 *
 * §2.3's original in-place-write test guarded a property of the stable line's auth.json.
 * The v2 build keeps credentials in its database instead (measured 2026-08-26), so what a
 * harness upgrade must not silently change is now this: a key stored through the integration
 * surface lands inside the redirected profile, survives a restart of the server, and removal
 * removes it durably. A build that moves the store, stops honouring the profile redirect, or
 * changes the connect surface fails here before it ships.
 *
 * Opt-in twice over: it needs a real opencode2 binary AND ARKE_LIVE_HARNESS=1, because the
 * integration catalog is fetched from the network and two live spawns cost the better part of
 * a minute — a price a harness-upgrade PR pays once, not every test run.
 *
 * Synthetic key only. No real credential is read, written or reachable: the profile is a
 * temp directory born and deleted here.
 */

const EXE =
  process.env["ARKE_OPENCODE2_CMD"] ??
  join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Arke Studio", "resources", "opencode2", "opencode2.exe");
const OPTED_IN = process.env["ARKE_LIVE_HARNESS"] === "1";
const SKIP = !OPTED_IN
  ? "set ARKE_LIVE_HARNESS=1 to run the live credential-store gate"
  : !existsSync(EXE)
    ? "no opencode2 binary on this machine (set ARKE_OPENCODE2_CMD)"
    : false;

const PORT = 4599;

class LiveServer {
  child: ChildProcess | null = null;
  password: string | null = null;

  constructor(private readonly profile: string) {}

  async start(): Promise<void> {
    this.password = null;
    const child = spawn(EXE, ["serve", "--port", String(PORT), "--hostname", "127.0.0.1"], {
      env: {
        ...process.env,
        HOME: this.profile,
        USERPROFILE: this.profile,
        XDG_CONFIG_HOME: join(this.profile, ".config"),
        XDG_DATA_HOME: join(this.profile, ".local", "share"),
      },
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const match = /^server password (\S+)$/.exec(line.trim());
        if (match) this.password = match[1]!;
      }
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child?.pid) return;
    await new Promise<void>((resolve) => {
      if (process.platform === "win32") {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => resolve());
      } else {
        child.kill("SIGKILL");
        resolve();
      }
    });
    // Let the OS release the port and the db files before a restart or cleanup.
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

describe("the live credential store (SPEC-030 §3.2, R-8)", { skip: SKIP, timeout: 240_000 }, () => {
  const profile = join(tmpdir(), `arke-live-credential-gate-${process.pid}`);
  const server = new LiveServer(profile);
  const adapter = new OpenCodeV2Adapter({
    baseUrl: () => `http://127.0.0.1:${PORT}`,
    password: () => server.password,
    warmupMs: 60_000,
  });

  const waitForIntegrations = async (): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const listed = await adapter.listIntegrations().catch(() => []);
      if (listed.length > 0) return;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    assert.fail("the integration catalog never populated — is the network reachable?");
  };

  before(async () => {
    rmSync(profile, { recursive: true, force: true });
    mkdirSync(join(profile, ".config"), { recursive: true });
    mkdirSync(join(profile, ".local", "share"), { recursive: true });
    await server.start();
    await adapter.init();
    assert.equal(adapter.readiness().ready, true, adapter.readiness().reason);
    await waitForIntegrations();
  });

  after(async () => {
    await server.stop();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Windows can hold the db a beat longer; a leftover temp dir is not a failure */
    }
  });

  it("stores a synthetic key inside the redirected profile and reports the connection", async () => {
    await adapter.connectVendorKey("anthropic", "sk-ant-SYNTHETIC-gate-0000");
    const listed = await adapter.listIntegrations();
    const anthropic = listed.find((i) => i.id === "anthropic");
    assert.ok(anthropic, "the anthropic integration is listed");
    assert.ok(
      anthropic.connections.some((c) => c.kind === "stored"),
      "the stored connection is reported",
    );
    // R-8: the write landed in the profile this test owns — the store exists there now.
    assert.ok(
      existsSync(join(profile, ".local", "share", "opencode", "opencode.db")),
      "the credential store lives inside the redirected profile",
    );
  });

  it("the connection survives a restart of the server — the store is durable", async () => {
    await server.stop();
    await server.start();
    await adapter.init();
    await waitForIntegrations();
    const listed = await adapter.listIntegrations();
    const anthropic = listed.find((i) => i.id === "anthropic");
    assert.ok(anthropic?.connections.some((c) => c.kind === "stored"));
  });

  it("removal is durable too", async () => {
    const listed = await adapter.listIntegrations();
    const stored = listed.find((i) => i.id === "anthropic")?.connections.find((c) => c.kind === "stored");
    assert.ok(stored && stored.kind === "stored");
    await adapter.removeVendorCredential(stored.id);
    const again = await adapter.listIntegrations();
    assert.equal(
      again.find((i) => i.id === "anthropic")?.connections.some((c) => c.kind === "stored"),
      false,
    );
  });
});
