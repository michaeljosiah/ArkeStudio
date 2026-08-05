import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UpdateState } from "@arke-studio/contracts";
import { UpdateController, type PendingUpdate, type UpdateMarker, type UpdaterLike } from "../src/updates.js";

class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkResult: Awaited<ReturnType<UpdaterLike["checkForUpdates"]>> = null;
  quitCalls: Array<[boolean | undefined, boolean | undefined]> = [];
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  async checkForUpdates() {
    return this.checkResult;
  }

  async downloadUpdate(): Promise<void> {}

  quitAndInstall(silent?: boolean, forceRunAfter?: boolean): void {
    this.quitCalls.push([silent, forceRunAfter]);
  }
}

function memoryMarker(initial: PendingUpdate | null = null): UpdateMarker & { value: PendingUpdate | null } {
  return {
    value: initial,
    async read() {
      return this.value;
    },
    async write(value) {
      this.value = value;
    },
    async clear() {
      this.value = null;
    },
  };
}

function setup(
  overrides: {
    marker?: ReturnType<typeof memoryMarker>;
    shutdown?: () => Promise<void>;
    version?: string;
  } = {},
) {
  const updater = new FakeUpdater();
  const marker = overrides.marker ?? memoryMarker();
  const states: UpdateState[] = [];
  let handoffs = 0;
  let shutdownFailures = 0;
  const controller = new UpdateController({
    updater,
    packaged: true,
    currentVersion: () => overrides.version ?? "1.0.0",
    marker,
    publish: (state) => states.push({ ...state }),
    shutdown: overrides.shutdown ?? (() => Promise.resolve()),
    beforeInstallerHandoff: () => {
      handoffs += 1;
      return () => { handoffs -= 1; };
    },
    onShutdownFailure: () => { shutdownFailures += 1; },
  });
  return { controller, updater, marker, states, handoffs: () => handoffs, shutdownFailures: () => shutdownFailures };
}

describe("desktop update controller", () => {
  it("uses isUpdateAvailable and retains target version and progress", async () => {
    const { controller, updater, states } = setup();
    updater.checkResult = { isUpdateAvailable: false, updateInfo: { version: "9.9.9" } };
    await controller.check();
    assert.equal(states.at(-1)?.status, "none");

    updater.emit("update-available", { version: "1.1.0" });
    updater.emit("download-progress", { percent: 42.5 });
    updater.emit("update-downloaded", { version: "1.1.0" });
    assert.deepEqual(states.at(-1), {
      status: "ready",
      targetVersion: "1.1.0",
      progressPercent: 100,
      flow: null,
      detail: null,
    });
  });

  it("hands off exactly once and only after clean shutdown", async () => {
    let finishShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve;
    });
    const { controller, updater, marker, handoffs } = setup({ shutdown: () => shutdown });
    updater.emit("update-downloaded", { version: "1.1.0" });

    const first = controller.installAndRestart();
    const second = controller.installAndRestart();
    assert.equal(updater.quitCalls.length, 0);
    finishShutdown();
    await Promise.all([first, second]);

    assert.deepEqual(updater.quitCalls, [[true, true]]);
    assert.equal(handoffs(), 1);
    assert.deepEqual(marker.value, { targetVersion: "1.1.0", flow: "restart" });
  });

  it("defers installation when shutdown fails", async () => {
    const { controller, updater, states } = setup({ shutdown: () => Promise.reject(new Error("locked")) });
    updater.emit("update-downloaded", { version: "1.1.0" });
    await controller.installAndRestart();
    assert.equal(updater.quitCalls.length, 0);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(states.at(-1)?.status, "install-failed");
    assert.match(states.at(-1)?.detail ?? "", /could not finish local work safely/i);
  });

  it("restores host quit state when installer handoff throws", async () => {
    const { controller, updater, handoffs, shutdownFailures, marker } = setup();
    updater.quitAndInstall = () => { throw new Error("handoff failed"); };
    updater.emit("update-downloaded", { version: "1.1.0" });
    await controller.installAndRestart();
    assert.equal(handoffs(), 0);
    assert.equal(shutdownFailures(), 1);
    assert.equal(marker.value, null);
  });

  it("arms install-on-close only after clean shutdown and does not force a relaunch", async () => {
    const { controller, updater, marker, handoffs } = setup();
    updater.emit("update-downloaded", { version: "1.1.0" });
    await controller.installOnClose();
    assert.equal(updater.autoInstallOnAppQuit, false);

    assert.equal(await controller.prepareInstallOnClose(), true);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.deepEqual(updater.quitCalls, [[true, false]]);
    assert.equal(handoffs(), 1);
    assert.deepEqual(marker.value, { targetVersion: "1.1.0", flow: "on-close" });
  });

  it("confirms only a matching installed version and clears the marker", async () => {
    const matching = setup({ marker: memoryMarker({ targetVersion: "1.0.0", flow: "restart" }) });
    await matching.controller.initialize();
    assert.equal(matching.states.at(-1)?.status, "updated");
    assert.equal(matching.marker.value, null);

    const mismatch = setup({ marker: memoryMarker({ targetVersion: "1.1.0", flow: "restart" }) });
    await mismatch.controller.initialize();
    assert.equal(mismatch.states.at(-1)?.status, "install-failed");
    assert.equal(mismatch.marker.value, null);
  });
});
