import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { UpdateState } from "@arke-studio/contracts";

export interface PendingUpdate {
  targetVersion: string;
  flow: "restart" | "on-close";
}

export interface UpdateMarker {
  read(): Promise<PendingUpdate | null>;
  write(marker: PendingUpdate): Promise<void>;
  clear(): Promise<void>;
}

export function fileUpdateMarker(path: string): UpdateMarker {
  return {
    async read() {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const value = JSON.parse(raw) as Partial<PendingUpdate>;
      if (
        typeof value.targetVersion !== "string" ||
        (value.flow !== "restart" && value.flow !== "on-close")
      ) throw new Error("the pending update receipt is invalid");
      return { targetVersion: value.targetVersion, flow: value.flow };
    },
    async write(marker) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(marker), "utf8");
      await rename(temporary, path);
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}

type UpdateCheckResult = {
  isUpdateAvailable?: boolean;
  updateInfo: { version: string };
} | null;

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<UpdateCheckResult>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateControllerOptions {
  updater: UpdaterLike;
  packaged: boolean;
  currentVersion: () => string;
  marker: UpdateMarker;
  publish: (state: UpdateState) => void;
  shutdown: () => Promise<void>;
  beforeInstallerHandoff: () => () => void;
  onShutdownFailure: () => void;
}

export class UpdateController {
  private state: UpdateState = {
    status: "idle",
    targetVersion: null,
    progressPercent: null,
    flow: null,
    detail: null,
  };
  private checkPromise: Promise<void> | null = null;
  private downloadPromise: Promise<void> | null = null;
  private installPromise: Promise<void> | null = null;
  private installOnCloseArmed = false;
  private shuttingDown = false;
  private undoHandoff: (() => void) | null = null;

  constructor(private readonly options: UpdateControllerOptions) {
    options.updater.autoDownload = false;
    options.updater.autoInstallOnAppQuit = false;
    if (!options.packaged) return;

    options.updater.on("checking-for-update", () => this.set({ status: "checking" }));
    options.updater.on("update-available", (info: { version?: string }) => {
      this.set({ status: "available", targetVersion: info.version ?? this.state.targetVersion });
    });
    options.updater.on("update-not-available", () => this.set({ status: "none", targetVersion: null }));
    options.updater.on("download-progress", (progress: { percent?: number }) => {
      this.set({
        status: "downloading",
        progressPercent: Math.max(0, Math.min(100, progress.percent ?? 0)),
      });
    });
    options.updater.on("update-downloaded", (info: { version?: string }) => {
      this.set({
        status: "ready",
        targetVersion: info.version ?? this.state.targetVersion,
        progressPercent: 100,
        detail: null,
      });
    });
    options.updater.on("error", () => {
      if (this.undoHandoff) {
        this.undoHandoff();
        this.undoHandoff = null;
        this.installPromise = null;
        this.options.onShutdownFailure();
        void this.options.marker.clear().catch(() => {});
      }
      this.set({
        status: "error",
        detail: "The update could not be prepared. Check your connection and try again.",
      });
    });
  }

  async initialize(): Promise<void> {
    if (!this.options.packaged) {
      this.set({ status: "externally-managed", detail: "Updates are managed outside this build." });
      return;
    }
    let pending: PendingUpdate | null;
    try {
      pending = await this.options.marker.read();
    } catch {
      this.set({
        status: "install-failed",
        detail: "Arke could not read the update receipt. Check the update folder permissions and restart.",
      });
      return;
    }
    if (pending) {
      try {
        await this.options.marker.clear();
      } catch {
        this.set({
          status: "install-failed",
          targetVersion: pending.targetVersion,
          flow: pending.flow,
          detail: "Arke could not clear the update receipt. Check the update folder permissions and restart.",
        });
        return;
      }
      if (this.options.currentVersion() === pending.targetVersion) {
        this.set({
          status: "updated",
          targetVersion: pending.targetVersion,
          flow: pending.flow,
          detail: null,
        });
        return;
      }
      this.set({
        status: "install-failed",
        targetVersion: pending.targetVersion,
        flow: pending.flow,
        detail: "The expected version was not installed. Check for updates and try again.",
      });
      return;
    }
    await this.check();
  }

  check(): Promise<void> {
    if (!this.options.packaged) {
      this.set({ status: "externally-managed", detail: "Updates are managed outside this build." });
      return Promise.resolve();
    }
    if (this.checkPromise) return this.checkPromise;
    if (this.installOnCloseArmed) return Promise.resolve();
    this.set({ status: "checking", targetVersion: null, progressPercent: null, flow: null, detail: null });
    this.checkPromise = this.options.updater
      .checkForUpdates()
      .then((result) => {
        if (result?.isUpdateAvailable === true) {
          this.set({ status: "available", targetVersion: result.updateInfo.version });
        } else {
          this.set({ status: "none", targetVersion: null });
        }
      })
      .catch(() => {
        this.set({
          status: "error",
          detail: "The update check failed. Check your connection and try again.",
        });
      })
      .finally(() => {
        this.checkPromise = null;
      });
    return this.checkPromise;
  }

  download(): Promise<void> {
    if (this.state.status !== "available" && this.state.status !== "error") return Promise.resolve();
    if (this.downloadPromise) return this.downloadPromise;
    this.set({ status: "downloading", progressPercent: 0, detail: null });
    this.downloadPromise = this.options.updater
      .downloadUpdate()
      .then(() => {
        if (this.state.status === "downloading") {
          this.set({ status: "ready", progressPercent: 100 });
        }
      })
      .catch(() => {
        this.set({
          status: "error",
          detail: "The update download failed. Check your connection and try again.",
        });
      })
      .finally(() => {
        this.downloadPromise = null;
      });
    return this.downloadPromise;
  }

  installAndRestart(): Promise<void> {
    if (this.installPromise) return this.installPromise;
    if (this.state.status !== "ready" || !this.state.targetVersion) return Promise.resolve();
    const targetVersion = this.state.targetVersion;
    this.installPromise = (async () => {
      this.set({ status: "shutting-down", flow: "restart", detail: null });
      try {
        await this.options.shutdown();
        await this.options.marker.write({ targetVersion, flow: "restart" });
        this.set({ status: "installing", flow: "restart" });
        const undoHandoff = this.options.beforeInstallerHandoff();
        this.undoHandoff = undoHandoff;
        try {
          this.options.updater.quitAndInstall(true, true);
        } catch (error) {
          undoHandoff();
          this.undoHandoff = null;
          throw error;
        }
      } catch {
        await this.options.marker.clear().catch(() => {});
        this.options.updater.autoInstallOnAppQuit = false;
        this.options.onShutdownFailure();
        this.set({
          status: "install-failed",
          flow: null,
          detail: "Arke could not finish local work safely. Restart Arke and try the update again.",
        });
        this.installPromise = null;
      }
    })();
    return this.installPromise;
  }

  installOnClose(): Promise<void> {
    if (this.state.status !== "ready" || !this.state.targetVersion) return Promise.resolve();
    this.installOnCloseArmed = true;
    this.set({
      status: "install-on-close",
      flow: "on-close",
      detail: "The update will install after a clean close. Arke will remain closed.",
    });
    return Promise.resolve();
  }

  isInstallOnCloseArmed(): boolean {
    return this.installOnCloseArmed;
  }

  shouldKeepWindowVisible(): boolean {
    return (
      this.installOnCloseArmed || this.state.status === "shutting-down" || this.state.status === "installing"
    );
  }

  async prepareInstallOnClose(): Promise<boolean> {
    if (!this.installOnCloseArmed || !this.state.targetVersion) return false;
    const targetVersion = this.state.targetVersion;
    this.set({ status: "shutting-down", flow: "on-close", detail: null });
    try {
      await this.options.shutdown();
      await this.options.marker.write({ targetVersion, flow: "on-close" });
      this.options.beforeInstallerHandoff();
      this.options.updater.quitAndInstall(true, false);
      return true;
    } catch {
      await this.options.marker.clear().catch(() => {});
      this.options.updater.autoInstallOnAppQuit = false;
      this.installOnCloseArmed = false;
      this.options.onShutdownFailure();
      this.set({
        status: "install-failed",
        flow: null,
        detail: "Arke could not close local work safely. Restart Arke before trying again.",
      });
      return false;
    }
  }

  acknowledge(): void {
    if (this.state.status !== "updated") return;
    this.set({ status: "idle", targetVersion: null, flow: null });
    void this.check();
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    this.set({ status: "shutting-down", flow: this.installOnCloseArmed ? "on-close" : null, detail: null });
  }

  failShutdown(): void {
    if (!this.shuttingDown) return;
    this.shuttingDown = false;
    this.set({
      status: this.installOnCloseArmed ? "install-on-close" : "error",
      flow: this.installOnCloseArmed ? "on-close" : null,
      detail: "Arke could not close local work safely. Wait a moment and try again.",
    });
  }

  private set(change: Partial<UpdateState>): void {
    this.state = { ...this.state, ...change };
    this.options.publish(this.state);
  }
}
