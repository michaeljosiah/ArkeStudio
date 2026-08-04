import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClientState, DomainEvent, Job } from "@arke-studio/contracts";
import {
  BackgroundNotificationController,
  type BackgroundNotificationDeps,
  type NotificationWindow,
} from "../src/background-notifications.js";

const AT = "2026-08-04T09:00:00Z";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "jb_01J8E0000000000000000000J1",
    idempotencyKey: "01J8E1000000000000000000K9",
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    target: { kind: "shot", id: "sh_14" },
    capability: "video",
    provider: "fal",
    model: "seedance-2.0",
    params: {},
    estimatedMicroUsd: 110000,
    status: "running",
    providerJobId: "remote-1",
    attempt: 1,
    error: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function state(
  jobs: Job[] = [],
  preference: ClientState["app"]["backgroundNotifications"] = "background-results-and-issues",
): ClientState {
  return {
    app: { backgroundNotifications: preference, jobs, queues: [] },
  } as unknown as ClientState;
}

function event(next: Job): DomainEvent {
  return { at: AT, type: "job.updated", job: next };
}

function readyEvent(next: Job): DomainEvent {
  return { at: AT, type: "job.ready", job: next };
}

function harness(options: { focused?: boolean; visible?: boolean } = {}) {
  const shown: Array<{ title: string; body: string; silent: boolean }> = [];
  let click: (() => void) | null = null;
  const actions: string[] = [];
  const window: NotificationWindow = {
    isFocused: () => options.focused ?? false,
    isDestroyed: () => false,
    isMinimized: () => true,
    isVisible: () => options.visible ?? false,
    restore: () => actions.push("restore"),
    show: () => actions.push("show"),
    focus: () => actions.push("focus"),
    activateActivity: () => actions.push("activity"),
  };
  const deps: BackgroundNotificationDeps = {
    packaged: true,
    platform: "win32",
    supported: () => true,
    window: () => window,
    create: (input) => ({
      onClick: (listener) => {
        click = listener;
      },
      show: () => shown.push(input),
    }),
  };
  const controller = new BackgroundNotificationController(deps);
  return { controller, shown, actions, click: () => click?.() };
}

describe("Windows background notifications", () => {
  it("notifies once when an unfocused running job succeeds", () => {
    const h = harness();
    const running = job();
    h.controller.arm(state([running]));
    const succeeded = job({ status: "succeeded" });
    h.controller.observe(readyEvent(succeeded));
    h.controller.observe(readyEvent(succeeded));
    assert.deepEqual(h.shown, [
      { title: "Generation ready", body: "Shot is ready in Arke Studio.", silent: true },
    ]);
  });

  it("waits for required follow-on finalization before reporting a result ready", () => {
    const h = harness();
    h.controller.arm(state([job()]));
    h.controller.observe(
      event(job({ status: "succeeded", finalization: { status: "pending", error: null, updatedAt: AT } })),
    );
    assert.equal(h.shown.length, 0);
    h.controller.observe(
      readyEvent(
        job({ status: "succeeded", finalization: { status: "complete", error: null, updatedAt: AT } }),
      ),
    );
    assert.equal(h.shown.length, 1);
  });

  it("names the character in a completed character sheet notification", () => {
    const h = harness();
    h.controller.arm(state([]));
    h.controller.observe(
      readyEvent(
        job({
          status: "succeeded",
          target: { kind: "character-sheet", id: "maren-kest/g1" },
          params: { characterName: "Maren Kest" },
        }),
      ),
    );
    assert.equal(h.shown[0]?.body, "Character sheet for Maren Kest is ready in Arke Studio.");
  });

  it("does not expose raw errors in failure copy", () => {
    const h = harness();
    h.controller.arm(state([job()]));
    h.controller.observe(
      event(job({ status: "failed", error: "C:\\Users\\name\\secret prompt.txt: key sk-test" })),
    );
    assert.equal(h.shown.length, 1);
    assert.equal(h.shown[0]?.body, "A generation needs attention. Open Activity for details.");
    assert.equal(JSON.stringify(h.shown).includes("sk-test"), false);
  });

  it("ignores progress transitions, startup terminal history, and focused outcomes", () => {
    const h = harness({ focused: true });
    const terminal = job({ status: "succeeded" });
    h.controller.arm(state([terminal]));
    h.controller.observe(event(job({ id: "jb_01J8E0000000000000000000J2", status: "queued" })));
    h.controller.observe(event(job({ id: "jb_01J8E0000000000000000000J2", status: "submitting" })));
    h.controller.observe(event(job({ id: "jb_01J8E0000000000000000000J2", status: "running" })));
    h.controller.observe(readyEvent(job({ id: "jb_01J8E0000000000000000000J2", status: "succeeded" })));
    assert.equal(h.shown.length, 0);
  });

  it("applies all three preferences", () => {
    const results = harness();
    results.controller.arm(state([], "issues-only"));
    results.controller.observe(readyEvent(job({ status: "succeeded" })));
    assert.equal(results.shown.length, 0);
    results.controller.observe(event(job({ id: "jb_01J8E0000000000000000000J2", status: "failed" })));
    assert.equal(results.shown.length, 1);

    const off = harness();
    off.controller.arm(state([], "off"));
    off.controller.observe(event(job({ status: "failed" })));
    assert.equal(off.shown.length, 0);
  });

  it("notifies once per pause and allows a resumed provider to notify again", () => {
    const h = harness();
    h.controller.arm(state([], "issues-only"));
    const paused: DomainEvent = {
      at: AT,
      type: "queue.status",
      queue: { provider: "fal", paused: true, pauseKind: "fault", held: 2, reason: "raw provider error" },
    };
    h.controller.observe(paused);
    h.controller.observe(paused);
    assert.equal(h.shown.length, 1);
    h.controller.observe({
      at: AT,
      type: "queue.status",
      queue: { provider: "fal", paused: false, held: 0 },
    });
    h.controller.observe(paused);
    assert.equal(h.shown.length, 2);
    assert.equal(JSON.stringify(h.shown).includes("raw provider error"), false);
  });

  it("does not notify for a self-recovering offline pause", () => {
    const h = harness();
    h.controller.arm(state([], "issues-only"));
    h.controller.observe({
      at: AT,
      type: "queue.status",
      queue: { provider: "fal", paused: true, pauseKind: "offline", held: 1, reason: "offline" },
    });
    assert.equal(h.shown.length, 0);
  });

  it("notifies when reconciliation or finalization fails again after recovery", () => {
    const h = harness();
    h.controller.arm(state([], "issues-only"));
    h.controller.observe(event(job({ status: "needs-reconciliation" })));
    h.controller.observe(event(job({ status: "running" })));
    h.controller.observe(event(job({ status: "needs-reconciliation" })));
    h.controller.observe(
      event(job({ status: "succeeded", finalization: { status: "failed", error: "x", updatedAt: AT } })),
    );
    h.controller.observe(
      event(job({ status: "succeeded", finalization: { status: "pending", error: null, updatedAt: AT } })),
    );
    h.controller.observe(
      event(job({ status: "succeeded", finalization: { status: "failed", error: "x", updatedAt: AT } })),
    );
    assert.equal(h.shown.length, 4);
  });

  it("restores, shows, focuses, and activates Activity on click", () => {
    const h = harness();
    h.controller.arm(state([job()]));
    h.controller.observe(readyEvent(job({ status: "succeeded" })));
    h.click();
    assert.deepEqual(h.actions, ["restore", "show", "focus", "activity"]);
  });

  it("stops producing and activating notifications during shutdown", () => {
    const h = harness();
    h.controller.arm(state([job()]));
    h.controller.observe(readyEvent(job({ status: "succeeded" })));
    h.controller.stop();
    h.click();
    h.controller.observe(event(job({ id: "jb_01J8E0000000000000000000J2", status: "failed" })));
    assert.deepEqual(h.actions, []);
    assert.equal(h.shown.length, 1);
  });
});
