import type { BrowserWindow, MessageBoxOptions } from "electron";

/** A renderer cannot draw its own crash recovery. Keep this prompt in the host (SPEC-001, #1815). */
export function installRendererRecovery(window: BrowserWindow, host: {
  canRecover(): boolean;
  prompt(options: MessageBoxOptions): Promise<number>;
  report(): void;
}): void {
  let failed = false, prompting = false, reloading = false, away = false, generation = 0;
  const available = () => !window.isDestroyed() && !window.webContents.isDestroyed() && host.canRecover();
  const offer = async () => {
    if (!failed || prompting || reloading || !available()) return;
    prompting = true;
    away = false;
    const current = generation;
    try {
      const response = await host.prompt({ type: "warning", title: "Arke Studio",
        message: "The window stopped working",
        detail: "Reload the window to return to your work. Background jobs keep running and will not be submitted again.\n\nUnsaved changes in this window may be lost.",
        buttons: ["Not now", "Reload window"], defaultId: 1, cancelId: 0, noLink: true });
      if (response !== 1 || current !== generation || !failed || !available()) return;
      reloading = true;
      window.webContents.reload();
    } catch {
      reloading = false;
      host.report();
    } finally {
      prompting = false;
      away = false;
    }
  };
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || !available()) return;
    failed = true;
    reloading = false;
    generation++;
    void offer();
  });
  window.webContents.on("did-finish-load", () => {
    failed = false;
    reloading = false;
    away = false;
    generation++;
  });
  window.webContents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
    if (!isMainFrame || !reloading) return;
    reloading = false;
    // Navigation hides the app until its theme is ready; a failed reload must remain reachable.
    if (available()) window.showInactive();
  });
  // A native prompt itself blurs/focuses its owner. Require a new departure after dismissal.
  window.on("blur", () => { if (failed && !prompting && !reloading) away = true; });
  window.on("focus", () => { if (away) { away = false; void offer(); } });
}
