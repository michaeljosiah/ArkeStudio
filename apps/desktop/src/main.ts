import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { app, BrowserWindow, safeStorage } from "electron";
import {
  ChildSupervisor,
  Coordinator,
  defaultAppRoot,
  FsWorldProvider,
  type Cipher,
  type DatabaseCtor,
} from "@arke-studio/coordinator";
import {
  agentForPurpose,
  buildSessionConfig,
  credentialEnv,
  discoverOpenCode,
  OpenCodeAdapter,
} from "@arke-studio/adapter-opencode";
import { createProviderClients, probeRuntime, SHIPPED_MANIFEST } from "@arke-studio/providers";

/**
 * The Electron-ABI SQLite binding (SPEC-003 R-7). Aliased so the Node-ABI copy used by tests
 * never collides. Loaded defensively: a missing or mismatched binary degrades the derived
 * index (a cache), never the app.
 */
function loadElectronSqlite(): DatabaseCtor | undefined {
  try {
    // The main bundle is CJS: import.meta.url is undefined there, __filename is real.
    const req = createRequire(__filename);
    return req("better-sqlite3-electron") as DatabaseCtor;
  } catch (err) {
    console.warn("[arke] better-sqlite3-electron unavailable — index disabled:", String(err));
    return undefined;
  }
}

declare const __APP_VERSION__: string;

/**
 * Electron main: embeds the coordinator (SPEC-001 D2 — it is the domain layer, not a server),
 * supervises the two foreign runtimes, and opens the sandboxed window. Quitting stops
 * everything; nothing survives the app (R-4, R-5).
 */

const isDev = !app.isPackaged;

/** Repo root in dev (dist/ is two levels below apps/desktop). */
const repoRoot = resolve(__dirname, "../../..");
const clientIndex = isDev
  ? join(repoRoot, "packages/client/dist/index.html")
  : join(process.resourcesPath, "client/index.html");

/** The real on-disk app root (SPEC-002 §2.2): %USERPROFILE%\ArkeStudio, env-overridable. */
const appRoot = defaultAppRoot();

/** Child commands come from the environment until SPEC-005/SPEC-011 manage them properly. */
function childSpec(id: string, cmdVar: string, argsVar: string) {
  const command = process.env[cmdVar] ?? null;
  const args = process.env[argsVar]?.split(" ").filter(Boolean) ?? [];
  return { id, command, args };
}

let coordinator: Coordinator | null = null;
let window: BrowserWindow | null = null;
let shuttingDown = false;

async function start(): Promise<void> {
  const sqlite = loadElectronSqlite();
  const provider = new FsWorldProvider(appRoot, sqlite ? { sqlite } : {});
  await provider.ensureAppRoot();

  // OpenCode discovery (SPEC-005 R-1): configured path → PATH → bundled, reported with its
  // version. Absent → authoring degrades with the reason stated (R-4).
  const discovered = discoverOpenCode({
    ...(process.env["ARKE_OPENCODE_CMD"] ? { configuredPath: process.env["ARKE_OPENCODE_CMD"] } : {}),
    ...(app.isPackaged ? { bundledPath: join(process.resourcesPath, "opencode", "opencode.exe") } : {}),
  });
  const opencodeSupervisor = new ChildSupervisor({
    id: "opencode",
    command: discovered?.command ?? null,
    args: ["serve", "--port", "{port}", "--hostname", "127.0.0.1"],
    env: credentialEnv({}), // SPEC-008 supplies real keys from safeStorage
    healthPath: "/api/health",
    readyTimeoutMs: 30_000,
  });
  const adapter = discovered
    ? new OpenCodeAdapter({ baseUrl: () => `http://127.0.0.1:${opencodeSupervisor.port ?? 0}` })
    : null;
  if (discovered) {
    console.log(`[arke] OpenCode: ${discovered.source} (${discovered.version ?? "unknown version"})`);
  } else {
    console.log("[arke] OpenCode: not found — authoring disabled");
  }

  // Credentials encrypt against the OS user's key (SPEC-008 R-5); safeStorage is the cipher,
  // the coordinator's store is the store.
  const cipher: Cipher = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (buf) => safeStorage.decryptString(buf),
  };

  coordinator = new Coordinator({
    provider,
    adapter,
    changeLogPath: join(appRoot, "logs", "coordinator.jsonl"),
    appVersion: __APP_VERSION__,
    jobsSeedPath: join(appRoot, "queue", "jobs.jsonl"),
    ledgerSeedPath: join(appRoot, "ledger.jsonl"),
    appRoot,
    authoring: { buildConfig: buildSessionConfig, agentForPurpose },
    cipher,
    validators: createProviderClients((url, init) => fetch(url, init)),
    manifest: SHIPPED_MANIFEST,
    probeRuntime: () => probeRuntime(appRoot),
  });

  // Both children are allowed to be absent: the app opens, browses and navigates regardless,
  // and the affected features carry a stated reason (R-6).
  coordinator.superviseAs("harness", opencodeSupervisor);
  coordinator.superviseAs("voice", new ChildSupervisor(childSpec("voxa", "ARKE_VOXA_CMD", "ARKE_VOXA_ARGS")));

  const { port } = await coordinator.start(0);

  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: "#FFFFFF",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--arke-ws-port=${port}`, `--arke-app-version=${__APP_VERSION__}`],
    },
  });
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = null;
  });

  const devServer = process.env.ARKE_DEV_SERVER_URL;
  if (devServer) {
    await window.loadURL(devServer);
  } else {
    await window.loadFile(clientIndex);
  }

  // Updater wiring only — the real update flow is SPEC-016. Never in dev.
  if (app.isPackaged) {
    import("electron-updater")
      .then(({ autoUpdater }) => autoUpdater.checkForUpdatesAndNotify())
      .catch(() => {
        /* updates unavailable is not an error the user can act on here */
      });
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const stop = coordinator?.stop() ?? Promise.resolve();
  // A child that will not die must not hold the app open forever.
  await Promise.race([stop, new Promise((r) => setTimeout(r, 5_000))]);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(() => void start());

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    void shutdown().then(() => app.quit());
  });
}
