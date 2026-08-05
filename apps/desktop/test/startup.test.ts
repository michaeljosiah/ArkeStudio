import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { launchDesktop, StartupController, type StartupState } from "../src/startup.js";

describe("desktop startup", () => {
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
