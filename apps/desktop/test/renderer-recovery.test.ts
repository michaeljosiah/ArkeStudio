import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { BrowserWindow, MessageBoxOptions } from "electron";
import { installRendererRecovery } from "../src/renderer-recovery.js";

function fixture() {
  let active = true, destroyed = false, reloads = 0, reports = 0, shown = 0;
  const prompts: { options: MessageBoxOptions; resolve(value: number): void; reject(error: Error): void }[] = [];
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed, reload: () => { reloads++; } });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => destroyed, showInactive: () => { shown++; } });
  installRendererRecovery(window as unknown as BrowserWindow, {
    canRecover: () => active,
    prompt: options => new Promise((resolve, reject) => prompts.push({ options, resolve, reject })),
    report: () => { reports++; },
  });
  return { window, contents, prompts, gone: (reason = "oom") => contents.emit("render-process-gone", {}, { reason }),
    leaveAndReturn: () => { window.emit("blur"); window.emit("focus"); },
    stop: () => { active = false; }, destroy: () => { destroyed = true; },
    counts: () => ({ reloads, reports, shown }) };
}

describe("desktop renderer recovery", () => {
  it("reloads only after the explicit recovery choice and waits for the load", async () => {
    const f = fixture(); f.gone();
    assert.deepEqual(f.prompts[0]!.options.buttons, ["Not now", "Reload window"]);
    assert.equal(f.prompts[0]!.options.defaultId, 1); assert.equal(f.prompts[0]!.options.cancelId, 0);
    assert.equal(f.counts().reloads, 0);
    f.prompts[0]!.resolve(1); await Promise.resolve();
    assert.equal(f.counts().reloads, 1);
    f.leaveAndReturn(); assert.equal(f.prompts.length, 1);
    f.contents.emit("did-finish-load"); f.leaveAndReturn();
    assert.equal(f.prompts.length, 1);
  });
  it("dismisses without reloading or a prompt-focus loop, and offers again on return", async () => {
    const f = fixture(); f.gone(); f.leaveAndReturn();
    assert.equal(f.prompts.length, 1);
    f.prompts[0]!.resolve(0); await Promise.resolve();
    f.window.emit("focus"); assert.equal(f.prompts.length, 1);
    assert.equal(f.counts().reloads, 0);
    f.leaveAndReturn(); assert.equal(f.prompts.length, 2);
    f.prompts[1]!.resolve(1); await Promise.resolve(); assert.equal(f.counts().reloads, 1);
  });
  for (const stale of ["shutdown", "destroyed", "loaded", "another crash"] as const) {
    it(`ignores a stale reload choice after ${stale}`, async () => {
      const f = fixture(); f.gone();
      if (stale === "shutdown") f.stop();
      if (stale === "destroyed") f.destroy();
      if (stale === "loaded") f.contents.emit("did-finish-load");
      if (stale === "another crash") f.gone("crashed");
      assert.equal(f.prompts.length, 1);
      f.prompts[0]!.resolve(1); await Promise.resolve();
      assert.equal(f.counts().reloads, 0);
      f.leaveAndReturn(); assert.equal(f.prompts.length, stale === "another crash" ? 2 : 1);
    });
  }
  it("ignores clean exits and shutdown failures", () => {
    const f = fixture(); f.gone("clean-exit"); f.stop(); f.gone(); f.leaveAndReturn();
    assert.equal(f.prompts.length, 0);
  });
  it("makes a failed reload visible and retryable on return without automatically retrying", async () => {
    const f = fixture(); f.gone(); f.prompts[0]!.resolve(1); await Promise.resolve();
    f.contents.emit("did-fail-load", {}, -2, "failed", "file:///fixture", false);
    assert.equal(f.counts().shown, 0);
    f.contents.emit("did-fail-load", {}, -2, "failed", "file:///fixture", true);
    assert.equal(f.counts().shown, 1); assert.equal(f.prompts.length, 1);
    f.leaveAndReturn(); assert.equal(f.prompts.length, 2);
  });
  it("contains native prompt errors and can offer recovery again", async () => {
    const f = fixture(); f.gone(); f.prompts[0]!.reject(new Error("native prompt failed")); await Promise.resolve();
    assert.deepEqual(f.counts(), { reloads: 0, reports: 1, shown: 0 });
    f.leaveAndReturn(); assert.equal(f.prompts.length, 2);
  });
  it("does not automatically retry a renderer that crashes again during reload", async () => {
    const f = fixture(); f.gone(); f.prompts[0]!.resolve(1); await Promise.resolve();
    f.gone("crashed"); assert.equal(f.prompts.length, 2); assert.equal(f.counts().reloads, 1);
  });
});
