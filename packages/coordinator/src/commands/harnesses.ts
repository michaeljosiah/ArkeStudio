import type { HarnessAvailability } from "@arke-studio/contracts";
import type { AppSettingsFile } from "../app-settings.js";
import type { CommandModule } from "./router.js";

/** The authoring harnesses: which one runs, and where Claude Code and Codex are installed. No world. */
export function harnessCommands(deps: {
  appSettings: () => AppSettingsFile | null;
  harnessAvailability(): Promise<HarnessAvailability[]>;
  emitHarnessStatus(known?: HarnessAvailability[]): Promise<void>;
  chooseClaudeExecutable?: () => Promise<string | null>;
  chooseCodexExecutable?: () => Promise<string | null>;
}) {
  return {
    "detect-harnesses": { scope: "none", async handle() { await deps.emitHarnessStatus(); } },
    "set-harness-engine": {
      scope: "none",
      async handle(msg) {
        const appSettings = deps.appSettings();
        if (!appSettings) return;
        const harnesses = await deps.harnessAvailability();
        const chosen = harnesses.find((h) => h.id === msg.engine);
        /*
         * The refusal lives here, not only on the screen.
         *
         * A disabled control is a courtesy to the reader; it is not a guarantee, because the
         * availability it was drawn from can be minutes old — a user can uninstall Claude Code
         * with Settings still open. Enabling a harness that is not there would replace working
         * authoring with a lane that cannot start, so the answer is no, and the screen is sent
         * the current truth so it stops showing the choice it thought it had.
         */
        if (!chosen?.installed) {
          await deps.emitHarnessStatus(harnesses);
          return;
        }
        await appSettings.setHarnessEngine(msg.engine);
        await deps.emitHarnessStatus(harnesses);
      },
    },
    "choose-claude-executable": {
      scope: "none",
      async handle() {
        const appSettings = deps.appSettings();
        if (!appSettings || !deps.chooseClaudeExecutable) return;
        const chosen = await deps.chooseClaudeExecutable().catch(() => null);
        // Cancelling a file dialog is not a decision — it must not clear an existing choice.
        if (chosen === null) return;
        await appSettings.setClaudePath(chosen);
        await deps.emitHarnessStatus();
      },
    },
    "clear-claude-executable": {
      scope: "none",
      async handle() {
        const appSettings = deps.appSettings();
        if (!appSettings) return;
        await appSettings.setClaudePath(null);
        await deps.emitHarnessStatus();
      },
    },
    "choose-codex-executable": {
      scope: "none",
      async handle() {
        const appSettings = deps.appSettings();
        if (!appSettings || !deps.chooseCodexExecutable) return;
        const chosen = await deps.chooseCodexExecutable().catch(() => null);
        if (chosen === null) return;
        await appSettings.setCodexPath(chosen);
        await deps.emitHarnessStatus();
      },
    },
    "clear-codex-executable": {
      scope: "none",
      async handle() {
        const appSettings = deps.appSettings();
        if (!appSettings) return;
        await appSettings.setCodexPath(null);
        await deps.emitHarnessStatus();
      },
    },
  } satisfies CommandModule;
}
