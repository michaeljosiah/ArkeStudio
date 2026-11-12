import type { CommandContext } from "./context.js";
import type { CommandModule } from "./router.js";

/** Desktop-owned update commands. Electron APIs remain outside the coordinator. */
export interface DesktopUpdates {
  check: () => Promise<void>;
  download: () => Promise<void>;
  installAndRestart: () => Promise<void>;
  installOnClose: () => Promise<void>;
  acknowledge: () => void;
}

/** Application updates: checking, downloading and installing. Application state, no world. */
export function updateCommands(ctx: CommandContext, deps: { updates: () => DesktopUpdates | undefined }) {
  return {
    "check-updates": {
      scope: "none",
      async handle() {
        const updates = deps.updates();
        if (!updates) {
          ctx.emit({
            at: new Date().toISOString(),
            type: "update.status",
            update: {
              status: "externally-managed",
              targetVersion: null,
              progressPercent: null,
              flow: null,
              releaseName: null,
              releaseNotes: null,
              detail: "Updates are managed outside this build.",
            },
          });
          return;
        }
        await updates.check();
      },
    },
    "download-update": { scope: "none", async handle() { await deps.updates()?.download(); } },
    "install-update-and-restart": { scope: "none", async handle() { await deps.updates()?.installAndRestart(); } },
    "install-update-on-close": { scope: "none", async handle() { await deps.updates()?.installOnClose(); } },
    "acknowledge-update": { scope: "none", handle() { deps.updates()?.acknowledge(); } },
  } satisfies CommandModule;
}
