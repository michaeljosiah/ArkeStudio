import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBackgroundLogin, launchDesktop, StartupController, StartupWindowPresentation, type StartupState } from "../src/startup.js";

describe("desktop startup", () => {
  it("detects Windows login arguments and macOS login state without hiding ordinary launches", () => {
    assert.equal(isBackgroundLogin("win32", ["--remote-background"]), true);
    assert.equal(isBackgroundLogin("darwin", [], { wasOpenedAtLogin: true }), true);
    assert.equal(isBackgroundLogin("win32", [], { wasOpenedAtLogin: true }), false);
    assert.equal(isBackgroundLogin("darwin", ["--remote-background"], { wasOpenedAtLogin: false }), false);
    assert.equal(isBackgroundLogin("linux", ["--remote-background"]), false);
  });
  it("starts the host after hidden first paint without either readiness path showing the window", async () => {
    let shown = 0, initialized = false;
    const presentation = new StartupWindowPresentation(true, () => { shown++; });
    const controller = new StartupController({
      initialize: async () => { initialized = true; return { port: 43122 }; },
      cleanup: async () => {}, publish: () => {}, report: error => assert.fail(String(error)),
    });
    const launching = launchDesktop(() => presentation.ready, controller);
    assert.equal(initialized, false);
    presentation.present();
    await launching;
    assert.equal(initialized, true);
    presentation.present();
    assert.equal(shown, 0, "the themed and fallback readiness paths both keep login launches hidden");
    presentation.reveal();
    assert.equal(shown, 1, "an explicit Open can reveal the window");
  });
  it("reveals a failed background launch so the owner can recover", async () => {
    let shown = 0;
    const presentation = new StartupWindowPresentation(true, () => { shown++; });
    presentation.present();
    const controller = new StartupController({
      initialize: async () => { throw new Error("startup failed"); }, cleanup: async () => {},
      publish: state => { if (state.status === "failed") presentation.reveal(); }, report: () => {},
    });
    await controller.run();
    assert.equal(shown, 1);
  });
  it("does not initialize the core until the launch window is shown", async () => {
    let show!: () => void;
    let initialized = false;
    const controller = new StartupController({
      initialize: async () => {
        initialized = true;
        return { port: 43122 };
      },
      cleanup: async () => {},
      publish: () => {},
      report: () => assert.fail("launch should succeed"),
    });

    const launching = launchDesktop(() => new Promise<void>((resolve) => (show = resolve)), controller);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(initialized, false);
    show();
    await launching;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(initialized, true);
  });

  it("publishes initializing before delayed core initialization settles", async () => {
    let finish!: (value: { port: number }) => void;
    const states: StartupState[] = [];
    const controller = new StartupController({
      initialize: () => new Promise((resolve) => (finish = resolve)),
      cleanup: async () => {},
      publish: (state) => states.push(state),
      report: () => assert.fail("a delayed start is not an error"),
    });

    const pending = controller.run();
    assert.deepEqual(states, [{ status: "initializing" }]);
    finish({ port: 43123 });
    await pending;
    assert.deepEqual(states, [{ status: "initializing" }, { status: "ready", port: 43123 }]);
  });

  it("catches a failed start, cleans up, and permits retry", async () => {
    const states: StartupState[] = [];
    const errors: unknown[] = [];
    let attempts = 0;
    let cleanups = 0;
    const controller = new StartupController({
      initialize: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("injected startup failure");
        return { port: 43124 };
      },
      cleanup: async () => {
        cleanups += 1;
      },
      publish: (state) => states.push(state),
      report: (error) => errors.push(error),
    });

    await assert.doesNotReject(controller.run());
    assert.equal(cleanups, 1);
    assert.equal(errors.length, 1);
    assert.equal(states.at(-1)?.status, "failed");

    await controller.run();
    assert.deepEqual(states.at(-1), { status: "ready", port: 43124 });
  });

  it("queues retry while failed-attempt cleanup is still running", async () => {
    let releaseCleanup!: () => void;
    let attempts = 0;
    const states: StartupState[] = [];
    const controller = new StartupController({
      initialize: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first attempt failed");
        return { port: 43125 };
      },
      cleanup: () => new Promise<void>((resolve) => (releaseCleanup = resolve)),
      publish: (state) => states.push(state),
      report: () => {},
    });

    const first = controller.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(states.at(-1)?.status, "failed");
    void controller.run();
    releaseCleanup();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(attempts, 2);
    assert.deepEqual(states.at(-1), { status: "ready", port: 43125 });
  });
});
