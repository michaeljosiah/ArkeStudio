import type { AppSettingsFile } from "../app-settings.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/**
 * The bell: background notifications and what has been seen of the inbox, What's new and a world's
 * file problems. Application settings, no world: a world's problems are settled from the bell
 * whether or not that world is open.
 */
export function inboxCommands(ctx: CommandContext, deps: { appSettings: () => AppSettingsFile | null }) {
  const markSeen = async (msg: CommandOf<"mark-inbox-seen" | "mark-whats-new-seen">) => {
    // The instant is this clock's, the same one that stamps every job's updatedAt — so the
    // bell's "newer than the last look" is one clock against itself, never the renderer's.
    const appSettings = deps.appSettings();
    if (!appSettings) return;
    const settings = await appSettings.setActivitySeen(
      msg.kind === "mark-inbox-seen"
        ? { inboxSeenAt: new Date().toISOString() }
        : { whatsNewSeenVersion: msg.version },
    );
    ctx.emit({ at: new Date().toISOString(), type: "activity.seen", seen: settings.activity });
  };
  return {
    "set-background-notifications": {
      scope: "none",
      async handle(msg) {
        const appSettings = deps.appSettings();
        if (!appSettings) return;
        const settings = await appSettings.setBackgroundNotifications(msg.preference);
        ctx.emit({
          at: new Date().toISOString(),
          type: "background-notifications.changed",
          preference: settings.backgroundNotifications,
        });
      },
    },
    "mark-inbox-seen": { scope: "none", handle: markSeen },
    "mark-whats-new-seen": { scope: "none", handle: markSeen },
    "settle-file-problems": {
      scope: "none",
      async handle(msg) {
        const appSettings = deps.appSettings();
        if (!appSettings) return;
        const settings = await appSettings.setActivitySeen({ fileProblems: { [msg.worldId]: msg.paths } });
        ctx.emit({ at: new Date().toISOString(), type: "activity.seen", seen: settings.activity });
      },
    },
  } satisfies CommandModule;
}
