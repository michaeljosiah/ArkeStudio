import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./tmp.js";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  assembleHarness,
  HarnessPasswordHolder,
  harnessProfileDir,
  passwordFromLine,
  v2LaunchEnv,
  v2ProfileEnv,
} from "../src/harness/v2-launch.js";
import { ChildSupervisor, type SupervisorStatusEvent } from "../src/supervisor.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "fixtures", "child.mjs");

// 40s default: above every spec's 10s ready budget, because this wait's clock starts at
// start() while the ready budget starts after the spawn settles — and the updateEnv paths
// put a stop and a respawn inside the same wait. Sized for a starved shard, like the budgets
// in supervisor.test.ts; a genuinely expired ready budget reports as "(at failed)".
function waitForStatus(sup: ChildSupervisor, wanted: string, timeoutMs = 40_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (sup.status === wanted) return resolve();
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${wanted}" (at "${sup.status}")`)),
      timeoutMs,
    );
    sup.on("status", (e: SupervisorStatusEvent) => {
      if (e.status === wanted) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

describe("the v2 launch protocol (issue 327 §4)", () => {
  for (const version of ["1.18.18", "2.0.25", "2.0.27"]) {
    it(`reports unsupported ${version} without a fallback and creates no launchable child`, async () => {
      const appRoot = await tempDir("v2-rejected-");
      const wiring = await assembleHarness({ appRoot,

        v2: { runCommand: async (command, args) => {
          if (command === "where" || command === "which") return args[0] === "opencode"
            ? { status: 0, stdout: "C:\\bin\\opencode.exe\n" } : { status: 1, stdout: "" };
          return { status: 0, stdout: `opencode v${version}` };
        } },
      });
      assert.equal(wiring.harness, null);
      assert.equal(wiring.adapter, null);
      assert.equal(wiring.supervisor, null);
      assert.equal(wiring.harnessInfo?.rejectedV2Version, version);
      assert.match(wiring.unavailableReason ?? "", /installed but unsupported/);
      assert.ok(wiring.unavailableReason?.includes(version));
      assert.ok(wiring.unavailableReason?.includes("2.0.26"));
      assert.deepEqual(wiring.logLines, [wiring.unavailableReason]);
    });
  }

  it("retires generated Ollama rows before launch while retaining endpoint and other provider configuration", async () => {
    const appRoot = await tempDir("v2-profile-retirement-");
    const configDir = join(harnessProfileDir(appRoot), ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    const path = join(configDir, "opencode.json");
    const ollama = { name: "Ollama", package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
      models: { deleted: { name: "deleted", capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: { input: 0, output: 0 } } } };
    const custom = { models: { configured: { name: "Configured model" } } };
    const launch = () => assembleHarness({ appRoot,
      v2: { runCommand: async (command) => command === "where" || command === "which"
        ? { status: 0, stdout: "C:/bin/opencode2.exe" } : { status: 0, stdout: "opencode v2.0.26" } },

    });
    await writeFile(path, JSON.stringify({ providers: { ollama, custom }, model: "custom/configured" }));
    await launch();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      providers: { ollama: { name: ollama.name, package: ollama.package, settings: ollama.settings }, custom }, model: "custom/configured",
    });
    const userConfig = { providers: { ollama: { ...ollama, models: { custom: { name: "My custom model", settings: { temperature: 0.4 } } } } } };
    const original = JSON.stringify(userConfig);
    await writeFile(path, original);
    await launch();
    assert.equal(await readFile(path, "utf8"), original, "user model configuration is not the generated inventory");
  });

  it("points native Ollama discovery at the selected service without generating a model inventory", async () => {
    const appRoot = await tempDir("v2-owned-ollama-");
    let endpoint = "http://127.0.0.1:24567";
    const wiring = await assembleHarness({ appRoot, ollamaEndpoint: () => endpoint,
      v2: { runCommand: async command => command === "where" || command === "which"
        ? { status: 0, stdout: "C:/bin/opencode2.exe" } : { status: 0, stdout: "opencode v2.0.26" } },

    });
    try {
      const path = join(harnessProfileDir(appRoot), ".config", "opencode", "opencode.json");
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { providers: { ollama: { settings: { baseURL: `${endpoint}/v1` } } } });
      endpoint = "http://localhost:11434";
      await wiring.reconfigureOllama!();
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { providers: { ollama: { settings: { baseURL: `${endpoint}/v1` } } } });
    } finally { await wiring.supervisor?.stop(); }
  });

  it("boots the pinned native runtime through the shared launcher and authenticated readiness route", {
    skip: !process.env["ARKE_TEST_OPENCODE2"], timeout: 75_000,
  }, async () => {
    const appRoot = await tempDir("v2-native-launch-");
    const personal = await tempDir("v2-synthetic-personal-");
    const personalDatabase = join(personal, "personal.db");
    await writeFile(personalDatabase, "SYNTHETIC_PERSONAL_DATABASE_DO_NOT_OPEN");
    const configDir = join(harnessProfileDir(appRoot), ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ providers: { ollama: {
      name: "Ollama", package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: "http://127.0.0.1:1/v1", apiKey: "ollama" },
      models: { "deleted-inventory-model": { name: "deleted-inventory-model", capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: { input: 0, output: 0 } } },
    } } }));
    const poison = {
      opencode_password: "synthetic-personal-password", OpenCode_Server_Password: "synthetic-legacy-password",
      opencode_server_username: "personal-user", OPENCODE_DB: personalDatabase,
      OPENCODE_CONFIG_CONTENT: "invalid synthetic personal configuration",
      OPENCODE_CONFIG_DIR: personal, XDG_STATE_HOME: join(personal, "state"), XDG_CACHE_HOME: join(personal, "cache"),
    };
    const inherited = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]));
    let wiring: Awaited<ReturnType<typeof assembleHarness>>;
    try {
      Object.assign(process.env, poison);
      wiring = await assembleHarness({
        appRoot,
        v2: { configuredPath: process.env["ARKE_TEST_OPENCODE2"]! },

      });
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    assert.equal(wiring.isV2, true);
    assert.equal(wiring.harnessInfo?.version, "2.0.26");
    assert.equal(wiring.harnessInfo?.beta, false);
    assert.ok(wiring.supervisor && wiring.adapter);
    try {
      await wiring.relaunchHarness({});
      await wiring.supervisor.start();
      await waitForStatus(wiring.supervisor, "healthy");
      await wiring.adapter.init?.();
      assert.equal(wiring.adapter.readiness().ready, true);
      assert.ok(!(await wiring.adapter.listModels?.())?.some(model => model.provider === "ollama" && model.id === "deleted-inventory-model"),
        "the real server cannot offer a stale row from Studio's retired generated inventory");
      assert.ok(!wiring.logLines.some(line => line.includes("[beta]")));
      await access(join(harnessProfileDir(appRoot), ".local", "share", "opencode", "opencode.db"));
      assert.equal(await readFile(personalDatabase, "utf8"), "SYNTHETIC_PERSONAL_DATABASE_DO_NOT_OPEN");
      for (const path of ["state", "cache", "personal.db-wal", "personal.db-shm"]) {
        await assert.rejects(access(join(personal, path)), { code: "ENOENT" });
      }
    } finally {
      await wiring.adapter.dispose?.(); await wiring.supervisor.stop();
    }
  });

  it("parses the password line and only the password line", () => {
    assert.equal(passwordFromLine("server password s3cret_value"), "s3cret_value");
    assert.equal(passwordFromLine("  server password s3cret_value \r"), "s3cret_value");
    assert.equal(passwordFromLine("server listening on http://127.0.0.1:14099"), null);
    assert.equal(passwordFromLine("server password"), null);
    assert.equal(passwordFromLine(""), null);
  });

  it("answers bare headers before the password and Basic auth after", () => {
    const holder = new HarnessPasswordHolder();
    assert.deepEqual(holder.healthHeaders(), {}, "a bare probe reads as 'not yet', never a guess");
    holder.onStdoutLine("server listening on http://127.0.0.1:14099");
    holder.onStdoutLine("server password pw_1");
    assert.equal(holder.current(), "pw_1");
    assert.deepEqual(holder.healthHeaders(), {
      authorization: "Basic " + Buffer.from("opencode:pw_1").toString("base64"),
    });
    // A restarted child prints a fresh secret; the newest one wins.
    holder.onStdoutLine("server password pw_2");
    assert.equal(holder.current(), "pw_2");
  });

  it("redirects home, configuration, data, state and cache together (issue 327 §2)", () => {
    const env = v2ProfileEnv("C:\\root\\harness\\profile");
    assert.equal(env["HOME"], "C:\\root\\harness\\profile");
    assert.equal(env["USERPROFILE"], "C:\\root\\harness\\profile");
    assert.equal(env["XDG_CONFIG_HOME"], join("C:\\root\\harness\\profile", ".config"));
    assert.equal(env["XDG_DATA_HOME"], join("C:\\root\\harness\\profile", ".local", "share"));
    assert.equal(env["XDG_STATE_HOME"], join("C:\\root\\harness\\profile", ".local", "state"));
    assert.equal(env["XDG_CACHE_HOME"], join("C:\\root\\harness\\profile", ".cache"));
    assert.equal(harnessProfileDir("C:\\root"), join("C:\\root", "harness", "profile"));
  });

  it("does not inherit native DB/config/simulation, authentication or telemetry controls", () => {
    const inherited = { PATH: "synthetic-bin", SystemRoot: "synthetic-os", ANTHROPIC_API_KEY: "synthetic-key",
      OpEnCoDe_Db: "personal.db", OPENCODE_CONFIG_CONTENT: "personal configuration", OPENCODE_SIMULATE: "1",
      opencode_server_password: "personal password", OTEL_EXPORTER_OTLP_ENDPOINT: "https://synthetic.invalid",
      otel_resource_attributes: "private=value", OPENCODE_DISABLE_AUTOUPDATE: "0", OTEL_SDK_DISABLED: "false",
      XDG_CACHE_HOME: "personal cache", XDG_STATE_HOME: "personal state", EMPTY: undefined };
    const original = { ...inherited };
    assert.deepEqual(v2LaunchEnv("profile", inherited), { PATH: "synthetic-bin", SystemRoot: "synthetic-os", ANTHROPIC_API_KEY: "synthetic-key",
      ...v2ProfileEnv("profile"), OPENCODE_DISABLE_AUTOUPDATE: "1", OTEL_SDK_DISABLED: "true" });
    assert.deepEqual(inherited, original, "launch isolation never changes the parent environment");
  });


  it("carries a v2 child from password line to authenticated health, no secret in any status", async () => {
    const holder = new HarnessPasswordHolder();
    const events: SupervisorStatusEvent[] = [];
    const sup = new ChildSupervisor({
      id: "opencode",
      command: process.execPath,
      args: [CHILD],
      env: { PASSWORD: "spike-launch-secret" },
      healthPath: "/api/health",
      healthHeaders: holder.healthHeaders,
      onStdoutLine: holder.onStdoutLine,
      readyTimeoutMs: 10_000,
    });
    sup.on("status", (e: SupervisorStatusEvent) => events.push(e));
    try {
      await sup.start();
      await waitForStatus(sup, "healthy");
      assert.equal(holder.current(), "spike-launch-secret", "the launch line reached the holder");
      // The fixture 401s unauthenticated requests, so healthy PROVES the header flowed.
      const serialized = JSON.stringify(events);
      assert.ok(!serialized.includes("spike-launch-secret"), "the password appears in no status event");
    } finally {
      await sup.stop();
    }
  });

  it("updateEnv before start only stores; after start it restarts the child", async () => {
    const sup = new ChildSupervisor({
      id: "opencode",
      command: process.execPath,
      args: [CHILD],
      env: { MODE: "healthy" },
      healthPath: "/api/health",
      readyTimeoutMs: 10_000,
    });
    try {
      // Before the first start: stored, nothing spawned.
      await sup.updateEnv({ ANTHROPIC_API_KEY: "sk-test" });
      assert.equal(sup.pid, null, "an unstarted child stays unstarted");
      await sup.start();
      await waitForStatus(sup, "healthy");
      const firstPid = sup.pid;
      assert.ok(firstPid !== null);
      // After start: the merge restarts, because environment reaches a process only at spawn.
      await sup.updateEnv({ OPENAI_API_KEY: "sk-test-2" });
      await waitForStatus(sup, "healthy");
      assert.notEqual(sup.pid, firstPid, "a running child restarts to pick up the new env");
    } finally {
      await sup.stop();
    }
  });

  it("updateEnv honours deletion markers and skips restarts when nothing changed", async () => {
    const sup = new ChildSupervisor({
      id: "opencode",
      command: process.execPath,
      args: [CHILD],
      env: { MODE: "healthy", ANTHROPIC_API_KEY: "sk-revoke-me" },
      healthPath: "/api/health",
      readyTimeoutMs: 10_000,
    });
    const events: SupervisorStatusEvent[] = [];
    sup.on("status", (e: SupervisorStatusEvent) => events.push(e));
    try {
      await sup.start();
      await waitForStatus(sup, "healthy");
      const firstPid = sup.pid;

      // An identical patch must not cost an in-flight turn its harness.
      const restartsBefore = events.filter((e) => e.status === "starting").length;
      await sup.updateEnv({ ANTHROPIC_API_KEY: "sk-revoke-me" });
      assert.equal(sup.pid, firstPid, "re-saving the same key does not restart");
      assert.equal(
        events.filter((e) => e.status === "starting").length,
        restartsBefore,
        "no restart cycle ran for a no-op patch",
      );

      // A cleared credential is a DELETION the merge must honour — the revoked key
      // surviving the next spawn is a revocation that did not happen (issue 327 review).
      await sup.updateEnv({ ANTHROPIC_API_KEY: undefined });
      await waitForStatus(sup, "healthy");
      assert.notEqual(sup.pid, firstPid, "removal restarts to shed the key");
      const port = sup.port;
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      const body = (await res.json()) as { env?: Record<string, string | undefined> };
      assert.equal(body.env?.["ANTHROPIC_API_KEY"], undefined, "the revoked key is gone from the child env");
    } finally {
      await sup.stop();
    }
  });

  it("assembles the absent case honestly: null adapter, unconfigured supervisor, stated reason", async () => {
    const nothing = async () => ({ status: 1, stdout: "" });
    const wiring = await assembleHarness({
      appRoot: await tempDir("v2-launch-"),

      v2: { runCommand: nothing },
    });
    assert.equal(wiring.harness, null);
    assert.equal(wiring.adapter, null);
    assert.equal(wiring.harnessInfo, undefined);
    assert.deepEqual(wiring.logLines, ["OpenCode: not found — authoring disabled"]);
    assert.ok(wiring.supervisor);
    await wiring.supervisor.start();
    assert.equal(wiring.supervisor.status, "unconfigured");
  });

});
