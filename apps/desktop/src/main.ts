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
  AppSettingsFile,
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
  KOKORO_PRESETS,
  localCandidates,
  sidecarState,
  SidecarHealthSchema,
  VoxaClient,
  type SidecarHealth,
} from "@arke-studio/voice";
import { BackgroundNotificationController } from "./background-notifications.js";
import { launchDesktop, StartupController, type StartupState } from "./startup.js";
import { resolveTheme, themePalette, type ResolvedTheme } from "./theme.js";
import { fileUpdateMarker, UpdateController } from "./updates.js";
import {
  environmentVoxaArgs,
  safeVoxaExtraArgs,
  selectVoxa,
  validateVoxaExecutable,
  type VoxaSelection,
} from "./voxa-runtime.js";
import type {
  ThemePreference,
  VoiceRuntimeFailure,
  VoiceRuntimeStatus,
  VoxaSettings,
} from "@arke-studio/contracts";

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

function bundledVoxaPath(): string | null {
  const path = app.isPackaged ? join(process.resourcesPath, "voxa", "voxa.exe") : null;
  return path !== null && existsSync(path) ? path : null;
}

let coordinator: Coordinator | null = null;
let window: BrowserWindow | null = null;
let shuttingDown = false;
let allowQuit = false;
let closeForUpdate: Promise<void> | null = null;
let normalShutdown: Promise<void> | null = null;
let updateController: UpdateController | null = null;
let activityActivationReady = false;
let pendingActivityActivation = false;
let themePreference: ThemePreference = "system";
let resolvedTheme: ResolvedTheme = "light";
let rendererThemeReady = false;
let windowReady = false;
let windowShowFallback: ReturnType<typeof setTimeout> | null = null;
let startupController: StartupController | null = null;
let startupProvider: FsWorldProvider | null = null;
let startupState: StartupState = { status: "initializing" };

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

function publishStartup(state: StartupState): void {
  startupState = state;
  traceDesktop(
    `startup.${state.status}`,
    state.status === "ready"
      ? { port: state.port }
      : state.status === "failed"
        ? { detail: state.detail }
        : {},
  );
  if (window && !window.isDestroyed()) window.webContents.send("arke:startup-state", state);
}

function registerHostIpc(): void {
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
  ipcMain.on("arke:startup-state-ready", (event) => {
    if (!window || event.sender !== window.webContents) return;
    window.webContents.send("arke:startup-state", startupState);
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
  ipcMain.on("arke:retry-startup", (event) => {
    if (!window || event.sender !== window.webContents) return;
    void startupController?.run();
  });
  ipcMain.on("arke:open-data-folder", (event) => {
    if (!window || event.sender !== window.webContents) return;
    void shell.openPath(appRoot);
  });
  ipcMain.on("arke:quit", (event) => {
    if (!window || event.sender !== window.webContents) return;
    app.quit();
  });
}

async function createWindow(): Promise<void> {
  const palette = themePalette(resolvedTheme);
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: palette.background,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: palette.overlay, symbolColor: palette.symbols, height: 44 },
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
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
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.ARKE_DEV_SERVER_URL ?? `file://${clientIndex.replace(/\\/g, "/")}`;
    if (!url.startsWith(allowed)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    activityActivationReady = false;
    traceDesktop("window.render-process-gone", { reason: details.reason, exitCode: details.exitCode });
  });
  window.on("close", (event) => {
    if (allowQuit || !updateController?.shouldKeepWindowVisible()) return;
    event.preventDefault();
    if (!updateController.isInstallOnCloseArmed() || closeForUpdate) return;
    closeForUpdate = updateController.prepareInstallOnClose().then((ready) => {
      closeForUpdate = null;
      if (ready) app.quit();
    });
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
  if (devServer) await window.loadURL(devServer);
  else await window.loadFile(clientIndex);
  if (!window.isVisible()) await new Promise<void>((resolve) => window?.once("show", resolve));
}

async function initialize(): Promise<{ port: number }> {
  const sqlite = loadElectronSqlite();
  const provider = new FsWorldProvider(appRoot, sqlite ? { sqlite } : {});
  startupProvider = provider;
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
  const discovered = await discoverOpenCode({
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

  // Voxa discovery is environment -> configured -> bundled -> absent. Configured paths stay
  // in the main process; renderer state receives only source, basename, and safe categories.
  const hostSettings = new AppSettingsFile(join(appRoot, "settings.json"));
  let voxaSettings = (await hostSettings.load()).voxa;
  const expectedArchitecture = windowsArchitecture();
  const discoverVoxa = (settings: VoxaSettings) =>
    selectVoxa({
      settings,
      environmentPath: process.env["ARKE_VOXA_CMD"],
      bundledPath: bundledVoxaPath(),
      expectedArchitecture,
    });
  let voxaSelection = discoverVoxa(voxaSettings);
  let voxaHealth: SidecarHealth | null = null;
  let endpointCompatible = false;
  let lastRuntimeFailure: VoiceRuntimeFailure | null = voxaSelection.failure;

  const voxaPaths = (settings: VoxaSettings) => {
    const modelRoot = settings.modelRoot ?? join(appRoot, "models");
    const espeakRoot = app.isPackaged
      ? join(process.resourcesPath, "espeak-ng")
      : join(repoRoot, "apps", "desktop", "build-resources", "espeak-ng", process.arch);
    return {
      kokoroModel: join(modelRoot, "kokoro-82m", "model_quantized.onnx"),
      kokoroConfig: join(modelRoot, "kokoro-82m", "config.json"),
      kokoroVoices: join(modelRoot, "kokoro-82m", "voices"),
      whisperModel: join(modelRoot, "whisper-base-en", "ggml-base.en.bin"),
      espeak: join(espeakRoot, "espeak-ng.exe"),
      espeakData: join(espeakRoot, "share", "espeak-ng-data"),
    };
  };
  const voxaLaunch = (selection: VoxaSelection, settings: VoxaSettings) => {
    const paths = voxaPaths(settings);
    const advanced = safeVoxaExtraArgs(
      selection.source === "environment"
        ? environmentVoxaArgs(process.env["ARKE_VOXA_ARGS_JSON"])
        : settings.extraArgs,
    );
    return {
      command: selection.command,
      args: [
        "--host", "127.0.0.1",
        "--port", "{port}",
        "--kokoro-model", paths.kokoroModel,
        "--kokoro-config", paths.kokoroConfig,
        "--kokoro-voices", paths.kokoroVoices,
        "--whisper-model", paths.whisperModel,
        "--espeak", paths.espeak,
        "--espeak-data", paths.espeakData,
        ...advanced,
      ],
      env: { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" },
      inheritEnv: false,
    };
  };
  const voxaSupervisor = new ChildSupervisor(
    {
      id: "voxa",
      ...voxaLaunch(voxaSelection, voxaSettings),
      healthPath: "/health",
      readyTimeoutMs: 30_000,
      validateHealth: async (response) => {
        const parsed = await response.json().catch(() => null);
        const health = parsed ? SidecarHealthSchema.safeParse(parsed) : null;
        if (!health?.success) {
          lastRuntimeFailure = "incompatible-health";
          return { ok: false, reason: "voxa health contract is incompatible" };
        }
        if (expectedArchitecture === null || health.data.architecture !== expectedArchitecture) {
          lastRuntimeFailure = "architecture-mismatch";
          return { ok: false, reason: "voxa architecture does not match this Arke build" };
        }
        if (!health.data.engines.includes("kokoro") || !health.data.engines.includes("whisper")) {
          lastRuntimeFailure = "incompatible-health";
          return { ok: false, reason: "voxa health contract omits a required engine" };
        }
        voxaHealth = health.data;
        endpointCompatible = true;
        lastRuntimeFailure = null;
        return { ok: true };
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

  const setupEngine = (id: string, healthReady: boolean) => {
    const component = coordinator?.getState().app.setup?.components.find((item) => item.id === id);
    if (component?.state === "downloading" || component?.state === "installing") {
      return { state: "downloading" as const, detail: "Model download is in progress." };
    }
    if (component?.state === "failed") {
      const verification = /checksum|verification|not the file/i.test(component.detail ?? "");
      return {
        state: verification ? "verification-failed" as const : "unavailable" as const,
        detail: verification ? "Model verification failed." : "Model setup failed.",
      };
    }
    if (component && component.state !== "ready" && component.state !== "present") {
      return { state: "missing" as const, detail: "Model files are missing." };
    }
    return healthReady
      ? { state: "ready" as const }
      : { state: "unavailable" as const, detail: "The runtime could not load this model." };
  };

  const runtimeStatus = (): VoiceRuntimeStatus => {
    const paths = voxaPaths(voxaSettings);
    const kokoro = setupEngine("kokoro-82m", voxaHealth?.engineStatus.kokoro.ready ?? false);
    const whisper = setupEngine("whisper-base-en", voxaHealth?.engineStatus.whisper.ready ?? false);
    const phonemizerReady = existsSync(paths.espeak) && existsSync(paths.espeakData);
    let failure = lastRuntimeFailure;
    if (failure === null && kokoro.state === "verification-failed") failure = "model-verification-failed";
    if (failure === null && whisper.state === "verification-failed") failure = "model-verification-failed";
    if (failure === null && voxaHealth?.unavailableReason !== undefined) failure = "model-verification-failed";
    if (failure === null && kokoro.state === "missing") failure = "kokoro-model-missing";
    if (failure === null && whisper.state === "missing") failure = "whisper-model-missing";
    if (failure === null && !phonemizerReady) failure = "phonemizer-unavailable";
    if (failure === null && voxaSupervisor.status === "failed") failure = "launch-failed";
    const detail =
      failure === "runtime-missing" ? "Runtime missing" :
      failure === "launch-failed" ? "Runtime would not start" :
      failure === "architecture-mismatch" ? "Runtime architecture does not match" :
      failure === "incompatible-health" ? "Runtime is running but /health is incompatible" :
      failure === "kokoro-model-missing" ? "Kokoro model missing" :
      failure === "whisper-model-missing" ? "Whisper model missing" :
      failure === "model-verification-failed" ? "Model verification failed" :
      failure === "phonemizer-unavailable" ? "Phonemizer unavailable" :
      voxaSupervisor.status === "healthy" && voxaHealth?.ok ? "Ready" : "Runtime is starting";
    return {
      source: voxaSelection.source,
      configured: voxaSelection.configured,
      bundledAvailable: voxaSelection.bundledAvailable,
      executableName: voxaSelection.executableName,
      version: voxaHealth?.version ?? null,
      protocolVersion: voxaHealth?.protocolVersion ?? null,
      architecture: voxaHealth?.architecture ?? null,
      expectedArchitecture,
      processState: voxaSupervisor.status,
      endpointCompatible,
      failureCategory: failure,
      detail,
      configurationWarning: voxaSelection.warning,
      engines: voxaHealth?.engines ?? [],
      engineStatus: {
        kokoro,
        whisper,
        phonemizer: phonemizerReady
          ? { state: "ready" }
          : { state: "unavailable", detail: "The managed espeak-ng runtime is missing." },
      },
    };
  };

  const publishRuntimeStatus = async (): Promise<void> => {
    const health = voxaSelection.command === null ? null : await voxaAt().health();
    if (health) {
      voxaHealth = health;
      endpointCompatible = health.architecture === expectedArchitecture;
    }
    const runtime = runtimeStatus();
    const status = sidecarState(health);
    coordinator?.emit({
      at: new Date().toISOString(),
      type: "voice.sidecar",
      state: status.state,
      detail: runtime.detail,
      runtime,
    });
  };

  const applyVoxaSettings = async (settings: VoxaSettings): Promise<void> => {
    voxaSettings = settings;
    voxaSelection = discoverVoxa(settings);
    voxaHealth = null;
    endpointCompatible = false;
    lastRuntimeFailure = voxaSelection.failure;
    await voxaSupervisor.reconfigure(voxaLaunch(voxaSelection, settings));
    await publishRuntimeStatus();
  };
  voxaSupervisor.on("status", () => {
    if (coordinator) void publishRuntimeStatus();
  });

  updateController = new UpdateController({
    updater: electronUpdater.autoUpdater,
    packaged: app.isPackaged,
    currentVersion: () => app.getVersion(),
    marker: fileUpdateMarker(join(appRoot, "update", "pending.json")),
    publish: (update) => {
      coordinator?.emit({ at: new Date().toISOString(), type: "update.status", update });
    },
    shutdown: () => shutdownConfirmed(),
    beforeInstallerHandoff: () => {
      allowQuit = true;
      shuttingDown = true;
      return () => {
        allowQuit = false;
        shuttingDown = false;
      };
    },
    onShutdownFailure: () => {
      allowQuit = false;
      shuttingDown = false;
    },
  });

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
    updates: {
      check: () => updateController!.check(),
      download: () => updateController!.download(),
      installAndRestart: () => updateController!.installAndRestart(),
      installOnClose: () => updateController!.installOnClose(),
      acknowledge: () => updateController!.acknowledge(),
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
        const health = voxaSelection.command === null ? null : await voxaAt().health();
        voxaHealth = health;
        if (health) endpointCompatible = health.architecture === expectedArchitecture;
        const runtime = runtimeStatus();
        return { ...sidecarState(health), detail: runtime.detail, runtime };
      },
      chooseExecutable: async () => {
        const parent = window;
        if (!parent) return null;
        const result = await dialog.showOpenDialog(parent, {
          title: "Choose Voxa executable",
          buttonLabel: "Use Voxa",
          properties: ["openFile"],
          filters: [
            { name: "Voxa executable", extensions: ["exe"] },
            { name: "All files", extensions: ["*"] },
          ],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        const path = result.filePaths[0];
        const validation = validateVoxaExecutable(path, expectedArchitecture);
        if (!validation.ok) {
          await dialog.showMessageBox(parent, {
            type: "error",
            title: "Voxa cannot be used",
            message: validation.detail,
          });
          return null;
        }
        return path;
      },
      applySettings: applyVoxaSettings,
      restart: async () => {
        voxaHealth = null;
        endpointCompatible = false;
        lastRuntimeFailure = voxaSelection.failure;
        await voxaSupervisor.restart();
        await publishRuntimeStatus();
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
  startupProvider = null;

  // Both children are allowed to be absent: the app opens, browses and navigates regardless,
  // and the affected features carry a stated reason (R-6).
  coordinator.superviseAs("harness", opencodeSupervisor);
  coordinator.superviseAs("voice", voxaSupervisor);

  const { port } = await coordinator.start(0);
  void updateController.initialize();
  backgroundNotifications.arm(coordinator.getState());
  applyHostTheme(coordinator.getState().app.appearance.theme, false);

  // Pasting. A screenshot off the clipboard has no file behind it, so the bytes come here, land
  // in the spool and go into the world by the ordinary filing path. The window sends bytes and
  // gets back a path it never sees — the preload holds it just long enough to name it in a
  // file-artifact frame (SPEC-001 R-9). Last run's couriers are swept first; nothing in there
  // outlives the process that wrote it.
  await sweepSpool(appRoot);
  return { port };
}

async function shutdownConfirmed(): Promise<void> {
  if (shuttingDown) throw new Error("shutdown is already in progress");
  shuttingDown = true;
  backgroundNotifications.stop();
  const stop = coordinator?.stop() ?? startupProvider?.close() ?? Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      stop,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("local shutdown did not finish safely")), 15_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    shuttingDown = false;
  }
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

  app.whenReady().then(async () => {
    if (process.platform === "win32") app.setAppUserModelId("studio.arke.app");
    registerHostIpc();
    startupController = new StartupController({
      initialize,
      cleanup: async () => {
        const started = coordinator;
        const provider = startupProvider;
        coordinator = null;
        startupProvider = null;
        if (started) await started.stop();
        else await provider?.close();
      },
      publish: publishStartup,
      report: (error) => {
        console.error("[arke] startup failed:", error);
        traceDesktop("startup.error", { error: String(error) });
      },
    });
    try {
      await launchDesktop(createWindow, startupController);
    } catch (error) {
      console.error("[arke] launch window failed:", error);
      traceDesktop("window.startup-error", { error: String(error) });
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (updateController?.isInstallOnCloseArmed()) {
      if (!closeForUpdate) {
        closeForUpdate = updateController.prepareInstallOnClose().then((ready) => {
          closeForUpdate = null;
          if (ready) app.quit();
        });
      }
      return;
    }
    if (normalShutdown) return;
    updateController?.beginShutdown();
    normalShutdown = shutdownConfirmed()
      .then(() => {
        allowQuit = true;
        app.quit();
      })
      .catch(async () => {
        normalShutdown = null;
        updateController?.failShutdown();
        if (window && !window.isDestroyed()) {
          await dialog.showMessageBox(window, {
            type: "warning",
            title: "Arke could not close safely",
            message: "Local work is still shutting down.",
            detail: "Wait a moment and close Arke Studio again. No update was installed.",
          });
        }
      });
  });
}
