import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, safeStorage, shell } from "electron";
import electronUpdater from "electron-updater";
import {
  ChildLedger,
  ChildSupervisor,
  Coordinator,
  defaultAppRoot,
  FsWorldProvider,
  ProviderCallStore,
  SecretRegistry,
  nodeSetupDeps,
  harnessTrace,
  spoolBytes,
  sweepSpool,
  registerExitBackstop,
  type Cipher,
  type DatabaseCtor,
} from "@arke-studio/coordinator";
import {
  agentForPurpose,
  buildSessionConfig,
  ROSTER,
  credentialEnv,
  discoverOpenCode,
  OpenCodeAdapter,
} from "@arke-studio/adapter-opencode";
import {
  createProviderClients,
  probeRuntime,
  SHIPPED_MANIFEST,
  type VoiceCatalogueClient,
} from "@arke-studio/providers";
import {
  compatibleSidecarHealth,
  KOKORO_PRESETS,
  localCandidates,
  sidecarState,
  SidecarHealthSchema,
  VoxaClient,
  type SidecarHealth,
} from "@arke-studio/voice";
import { BackgroundNotificationController } from "./background-notifications.js";
import { resolveTheme, themePalette, type ResolvedTheme } from "./theme.js";
import type { ThemePreference } from "@arke-studio/contracts";

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
const desktopLog = join(appRoot, "logs", "desktop.jsonl");

function traceDesktop(kind: string, detail: Record<string, unknown> = {}): void {
  try {
    appendFileSync(
      desktopLog,
      `${JSON.stringify({ at: new Date().toISOString(), kind, ...detail })}\n`,
      "utf8",
    );
  } catch {
    /* Diagnostics must never prevent startup. */
  }
}

/**
 * Child commands: environment override first, then the bundled binary in a packaged build
 * (SPEC-016 R-8). Absent both, the feature degrades with its stated reason.
 */
function childSpec(id: string, cmdVar: string, argsVar: string, bundled?: string) {
  const bundledPath = app.isPackaged && bundled !== undefined ? join(process.resourcesPath, bundled) : null;
  const command =
    process.env[cmdVar] ?? (bundledPath !== null && existsSync(bundledPath) ? bundledPath : null);
  const args = process.env[argsVar]?.split(" ").filter(Boolean) ?? [];
  return { id, command, args };
}

/** The bundled ffmpeg (SPEC-013 R-19 via SPEC-016 R-8), or an explicit path, or nothing. */
function ffmpegPath(): string | null {
  if (process.env["ARKE_FFMPEG"]) return process.env["ARKE_FFMPEG"];
  const bundled = app.isPackaged ? join(process.resourcesPath, "ffmpeg", "ffmpeg.exe") : null;
  return bundled !== null && existsSync(bundled) ? bundled : null;
}

function windowsArchitecture(): "x64" | "arm64" | null {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  return null;
}

let coordinator: Coordinator | null = null;
let window: BrowserWindow | null = null;
let shuttingDown = false;
let activityActivationReady = false;
let pendingActivityActivation = false;
let themePreference: ThemePreference = "system";
let resolvedTheme: ResolvedTheme = "light";
let rendererThemeReady = false;
let windowReady = false;
let windowShowFallback: ReturnType<typeof setTimeout> | null = null;

function showWindowWhenThemed(): void {
  if (!windowReady || !rendererThemeReady || !window || window.isDestroyed()) return;
  if (windowShowFallback) clearTimeout(windowShowFallback);
  windowShowFallback = null;
  traceDesktop("window.shown", { reason: "themed" });
  window.show();
}

function applyHostTheme(preference: ThemePreference, notifyRenderer = true): void {
  themePreference = preference;
  nativeTheme.themeSource = preference;
  resolvedTheme = resolveTheme(preference, nativeTheme.shouldUseDarkColors);
  const palette = themePalette(resolvedTheme);
  if (window && !window.isDestroyed()) {
    window.setBackgroundColor(palette.background);
    window.setTitleBarOverlay({ color: palette.overlay, symbolColor: palette.symbols, height: 44 });
    if (notifyRenderer)
      window.webContents.send("arke:theme-changed", { preference, resolved: resolvedTheme });
  }
}

nativeTheme.on("updated", () => {
  if (themePreference === "system") applyHostTheme("system");
});

function activateActivity(): void {
  if (shuttingDown || !window || window.isDestroyed()) return;
  if (activityActivationReady) window.webContents.send("arke:activate-activity");
  else pendingActivityActivation = true;
}

const backgroundNotifications = new BackgroundNotificationController({
  packaged: app.isPackaged,
  platform: process.platform,
  supported: () => Notification.isSupported(),
  window: () =>
    window
      ? {
          isFocused: () => window?.isFocused() ?? false,
          isDestroyed: () => window?.isDestroyed() ?? true,
          isMinimized: () => window?.isMinimized() ?? false,
          isVisible: () => window?.isVisible() ?? false,
          restore: () => window?.restore(),
          show: () => window?.show(),
          focus: () => window?.focus(),
          activateActivity: activateActivity,
        }
      : null,
  create: (input) => {
    const notification = new Notification(input);
    return {
      onClick: (listener) => notification.on("click", listener),
      show: () => notification.show(),
    };
  },
});

async function start(): Promise<void> {
  // Updater posture (SPEC-016 D7): never auto-download, always install at exit.
  electronUpdater.autoUpdater.autoDownload = false;
  electronUpdater.autoUpdater.autoInstallOnAppQuit = true;

  const sqlite = loadElectronSqlite();
  const provider = new FsWorldProvider(appRoot, sqlite ? { sqlite } : {});
  await provider.ensureAppRoot();

  // A force-killed previous run leaves its children behind (no exit hook fires under
  // Stop-Process); the ledger sweep reaps them before this run spawns its own (R-5). One of
  // those orphans once held a file lock that broke packaging — this is not hypothetical.
  const childLedger = new ChildLedger(join(appRoot, "run", "children.json"));
  const swept = await childLedger.reapStale();
  if (swept.reaped.length > 0) {
    const named = swept.reaped.map((r) => `${r.id} (pid ${r.pid})`).join(", ");
    console.log(`[arke] reaped ${swept.reaped.length} orphaned child process(es): ${named}`);
  }

  // OpenCode discovery (SPEC-005 R-1): configured path → PATH → bundled, reported with its
  // version. Absent → authoring degrades with the reason stated (R-4).
  const discovered = discoverOpenCode({
    ...(process.env["ARKE_OPENCODE_CMD"] ? { configuredPath: process.env["ARKE_OPENCODE_CMD"] } : {}),
    ...(app.isPackaged ? { bundledPath: join(process.resourcesPath, "opencode", "opencode.exe") } : {}),
  });
  const opencodeSupervisor = new ChildSupervisor(
    {
      id: "opencode",
      command: discovered?.command ?? null,
      args: ["serve", "--port", "{port}", "--hostname", "127.0.0.1"],
      env: credentialEnv({}), // SPEC-008 supplies real keys from safeStorage
      healthPath: "/api/health",
      readyTimeoutMs: 30_000,
    },
    { ledger: childLedger },
  );
  const adapter = discovered
    ? new OpenCodeAdapter({
        baseUrl: () => `http://127.0.0.1:${opencodeSupervisor.port ?? 0}`,
        // The adapter's own account of itself — connects, stalls, resyncs, dispatches. When a
        // chat sticks, this file answers "what did the app hear, and when" without a debugger.
        onTrace: harnessTrace(appRoot),
      })
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

  // One client set serves validation (SPEC-008) and dispatch (SPEC-009).
  const providerSecrets = new SecretRegistry();
  const providerCalls = new ProviderCallStore(join(appRoot, "provider-calls", "calls.jsonl"), providerSecrets);
  const providerClients = createProviderClients((url, init) => fetch(url, init), providerCalls);

  // The Voxa sidecar (SPEC-011): supervised like the harness; local inference only (D1).
  // The client resolves the supervisor's port lazily so restarts keep working.
  const voxaSpec = childSpec("voxa", "ARKE_VOXA_CMD", "ARKE_VOXA_ARGS", join("voxa", "voxa.exe"));
  const bundledVoxa = app.isPackaged && process.env["ARKE_VOXA_CMD"] === undefined;
  const expectedArchitecture = windowsArchitecture();
  let voxaHealth: SidecarHealth | null = null;
  const voxaArgs = bundledVoxa
    ? [
        "--host", "127.0.0.1",
        "--port", "{port}",
        "--kokoro-model", join(appRoot, "models", "kokoro-82m", "model_quantized.onnx"),
        "--kokoro-config", join(appRoot, "models", "kokoro-82m", "config.json"),
        "--kokoro-voices", join(appRoot, "models", "kokoro-82m", "voices"),
        "--whisper-model", join(appRoot, "models", "whisper-base-en", "ggml-base.en.bin"),
        "--espeak", join(process.resourcesPath, "espeak-ng", "espeak-ng.exe"),
        "--espeak-data", join(process.resourcesPath, "espeak-ng", "share", "espeak-ng-data"),
      ]
    : voxaSpec.args;
  const voxaSupervisor = new ChildSupervisor(
    {
      ...voxaSpec,
      args: voxaArgs,
      healthPath: "/health",
      readyTimeoutMs: 30_000,
      inheritEnv: !bundledVoxa,
      ...(bundledVoxa ? { env: { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } } : {}),
      validateHealth: async (response) => {
        if (expectedArchitecture === null) return false;
        const parsed = await response.json().catch(() => null);
        const health = parsed ? SidecarHealthSchema.safeParse(parsed) : null;
        if (!health?.success || !compatibleSidecarHealth(health.data, expectedArchitecture)) return false;
        voxaHealth = health.data;
        return true;
      },
    },
    { ledger: childLedger },
  );
  registerExitBackstop(opencodeSupervisor, voxaSupervisor);
  const voxaAt = () =>
    new VoxaClient((url, init) => fetch(url, init), `http://127.0.0.1:${voxaSupervisor.port ?? 0}`);
  const voxaSidecar = {
    listVoices: () => voxaAt().listVoices(),
    synthesize: (input: { voiceId: string; text: string; params?: Record<string, number> }) =>
      voxaAt().synthesize(input),
    transcribe: (audio: Uint8Array, contentType: string) => voxaAt().transcribe(audio, contentType),
  };

  coordinator = new Coordinator({
    provider,
    adapter,
    changeLogPath: join(appRoot, "logs", "coordinator.jsonl"),
    appVersion: __APP_VERSION__,
    jobsSeedPath: join(appRoot, "queue", "jobs.jsonl"),
    ledgerSeedPath: join(appRoot, "ledger.jsonl"),
    appRoot,
    authoring: { buildConfig: buildSessionConfig, agentForPurpose, roster: ROSTER },
    cipher,
    secretRegistry: providerSecrets,
    providerCalls,
    validators: providerClients,
    manifest: SHIPPED_MANIFEST,
    probeRuntime: () => probeRuntime(appRoot),
    dispatchClients: providerClients,
    // Exports encode locally (SPEC-013 R-19): the bundled ffmpeg in a packaged build
    // (SPEC-016 R-8, invoked as a subprocess, never linked — D6), else ARKE_FFMPEG; its
    // absence is stated, never silent.
    ...(ffmpegPath() !== null
      ? {
          ffmpeg: {
            run: (args: string[], onProgress: (p: number) => void, signal: AbortSignal) =>
              new Promise<void>((resolvePromise, reject) => {
                const child = spawn(ffmpegPath()!, args, { windowsHide: true });
                signal.addEventListener("abort", () => child.kill("SIGKILL"));
                child.stderr.on("data", (chunk: Buffer) => {
                  const m = /time=(\d+):(\d+):(\d+)/.exec(chunk.toString());
                  if (m) onProgress(Math.min(99, Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])));
                });
                child.on("error", reject);
                child.on("exit", (code) =>
                  code === 0 ? resolvePromise() : reject(new Error(`ffmpeg exited ${code}`)),
                );
              }),
          },
        }
      : {}),
    // Updates (SPEC-016 R-12, R-13): check and download only. autoInstallOnAppQuit is the
    // whole deferral mechanism — the world lock, the commit journal and running jobs are never
    // interrupted, because nothing installs until the user quits.
    updates: {
      check: async () => {
        if (!app.isPackaged) return null;
        const result = await electronUpdater.autoUpdater.checkForUpdates();
        return result && result.updateInfo.version !== app.getVersion()
          ? { version: result.updateInfo.version }
          : null;
      },
      download: async () => {
        await electronUpdater.autoUpdater.downloadUpdate();
      },
    },
    // Attaching files. The dialog is the host's business and so is the path it hands back — the
    // renderer never sees either, it only sees artifacts appear (SPEC-001 R-9).
    pickFiles: async ({ accept }) => {
      const parent = window;
      if (!parent) return [];
      const result = await dialog.showOpenDialog(parent, {
        title: "Attach to this world",
        buttonLabel: "Attach",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Anything the studio can hold", extensions: [...accept] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      return result.canceled ? [] : result.filePaths;
    },
    // Fetching the local runtimes at setup: the shared Node seams (streamed HTTP, subprocesses).
    setup: nodeSetupDeps(),
    openPath: (p) => void shell.openPath(p),
    nativeIndex: sqlite
      ? { ok: true }
      : {
          ok: false,
          reason: "the native index binding did not load — search and counts degrade; authoring still works",
        },
    voice: {
      sidecar: voxaSidecar,
    sidecarHealth: async () => {
      const health = await voxaAt().health();
      voxaHealth = health;
      const status = sidecarState(health);
      return {
        ...status,
        runtime:
          voxaHealth && bundledVoxa
            ? {
                source: "bundled" as const,
                version: voxaHealth.version,
                protocolVersion: voxaHealth.protocolVersion,
                architecture: voxaHealth.architecture,
                engines: voxaHealth.engines,
                engineStatus: voxaHealth.engineStatus,
              }
            : null,
      };
    },
      localPresets: localCandidates(KOKORO_PRESETS),
      cloudSources: [
        {
          provider: "elevenlabs",
          list: (key: string) => (providerClients.elevenlabs as VoiceCatalogueClient).listVoicesCatalog(key),
        },
      ],
    },
    observeEvent: (event) => {
      backgroundNotifications.observe(event);
      if (event.type === "appearance.changed") applyHostTheme(event.preference);
    },
  });

  // Both children are allowed to be absent: the app opens, browses and navigates regardless,
  // and the affected features carry a stated reason (R-6).
  coordinator.superviseAs("harness", opencodeSupervisor);
  coordinator.superviseAs("voice", voxaSupervisor);

  const { port } = await coordinator.start(0);
  backgroundNotifications.arm(coordinator.getState());
  applyHostTheme(coordinator.getState().app.appearance.theme, false);

  // Pasting. A screenshot off the clipboard has no file behind it, so the bytes come here, land
  // in the spool and go into the world by the ordinary filing path. The window sends bytes and
  // gets back a path it never sees — the preload holds it just long enough to name it in a
  // file-artifact frame (SPEC-001 R-9). Last run's couriers are swept first; nothing in there
  // outlives the process that wrote it.
  await sweepSpool(appRoot);
  ipcMain.handle("arke:spool", async (event, input: { name?: unknown; bytes?: unknown }) => {
    if (!window || event.sender !== window.webContents) return { reason: "that window cannot attach" };
    const raw = input?.bytes;
    const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
    if (!bytes) return { reason: "the clipboard gave us nothing we could write" };
    const name = typeof input?.name === "string" ? input.name : "pasted";
    return await spoolBytes(appRoot, name, bytes).catch((err: unknown) => ({ reason: String(err) }));
  });
  ipcMain.on("arke:activity-activation-ready", (event) => {
    if (!window || event.sender !== window.webContents) return;
    activityActivationReady = true;
    if (pendingActivityActivation) {
      pendingActivityActivation = false;
      window.webContents.send("arke:activate-activity");
    }
  });
  ipcMain.on("arke:set-host-theme", (event, preference: unknown) => {
    if (!window || event.sender !== window.webContents) return;
    if (preference === "system" || preference === "light" || preference === "dark") {
      applyHostTheme(preference);
    }
  });
  ipcMain.on("arke:theme-ready", (event) => {
    if (!window || event.sender !== window.webContents) return;
    rendererThemeReady = true;
    traceDesktop("window.theme-ready");
    showWindowWhenThemed();
  });

  const palette = themePalette(resolvedTheme);

  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: palette.background,
    // The native frame is hidden; overlay controls sit inside the app's own 44px titlebars.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: palette.overlay, symbolColor: palette.symbols, height: 44 },
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--arke-ws-port=${port}`,
        `--arke-app-version=${__APP_VERSION__}`,
        `--arke-theme-preference=${themePreference}`,
        `--arke-resolved-theme=${resolvedTheme}`,
      ],
    },
  });
  traceDesktop("window.created", { themePreference, resolvedTheme });
  windowShowFallback = setTimeout(() => {
    if (!window || window.isDestroyed()) return;
    traceDesktop("window.shown", {
      reason: "readiness-timeout",
      windowReady,
      rendererThemeReady,
      loading: window.webContents.isLoading(),
      visible: window.isVisible(),
    });
    window.show();
  }, 5_000);
  window.once("ready-to-show", () => {
    windowReady = true;
    traceDesktop("window.ready-to-show");
    showWindowWhenThemed();
  });
  window.webContents.on("did-finish-load", () => traceDesktop("window.did-finish-load"));
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) traceDesktop("window.did-fail-load", { errorCode, errorDescription, validatedURL });
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    traceDesktop("window.preload-error", { preloadPath, error: String(error) });
  });
  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      activityActivationReady = false;
      rendererThemeReady = false;
      if (window?.isVisible()) window.hide();
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    activityActivationReady = false;
    traceDesktop("window.render-process-gone", { reason: details.reason, exitCode: details.exitCode });
  });
  window.on("closed", () => {
    if (windowShowFallback) clearTimeout(windowShowFallback);
    windowShowFallback = null;
    window = null;
    activityActivationReady = false;
    pendingActivityActivation = false;
    rendererThemeReady = false;
    windowReady = false;
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
  backgroundNotifications.stop();
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

  app.whenReady().then(() => {
    if (process.platform === "win32") app.setAppUserModelId("studio.arke.app");
    void start();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    void shutdown().then(() => app.quit());
  });
}
