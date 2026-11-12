import type { RecoveryActionRegistry } from "../recovery/actions.js";
import { recoveryCommand } from "../recovery/commands.js";
import type { RecoveryControlService } from "../recovery/control.js";
import type { RecoveryHistoryService } from "../recovery/history.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/** Recovery: its history, its policy and the actions it offers. Application state, no world. */
export function recoveryCommands(ctx: CommandContext, deps: {
  control: () => RecoveryControlService | null | undefined;
  history: () => RecoveryHistoryService | null | undefined;
  actions: RecoveryActionRegistry;
  publishPolicy(): void;
  retryHeldArtifactTransfers(): void;
  trackBackground(work: Promise<unknown>): void;
}) {
  const control = async (msg: CommandOf<"recovery-set-mode" | "recovery-set-advanced" | "recovery-set-preferences" | "recovery-history-control">) => {
    const oldTransfer = deps.control()?.advancedSettings().artifactTransfer;
    const result = await recoveryCommand(msg, { control: deps.control(), history: deps.history() });
    if (msg.kind === "recovery-set-advanced" && result.status === "saved" && !ctx.stopping() && JSON.stringify(oldTransfer) !== JSON.stringify(msg.settings.artifactTransfer)) deps.retryHeldArtifactTransfers();
    if (!ctx.stopping()) ctx.emit({ type: "recovery.command-result", at: ctx.nowIso(), result });
  };
  return {
    "recovery-history-read": { scope: "none", handle(msg) {
      const page = deps.history()?.page(msg.query) ?? { status: "unavailable" as const, filter: msg.query.filter, pageSize: msg.query.pageSize, offset: 0,
        ...(msg.query.view === "actions" ? { view: "actions" as const, actions: [] } : {}),
        at: Date.now(), audit: "unavailable" as const, incidents: [], totalCount: 0, revision: null, nextCursor: null, previousCursor: null };
      ctx.emit({ type: "recovery.history-page", at: ctx.nowIso(), requestId: msg.requestId, page });
    } },
    "recovery-set-mode": { scope: "none", handle: control },
    "recovery-set-advanced": { scope: "none", handle: control },
    "recovery-set-preferences": { scope: "none", handle: control },
    "recovery-history-control": { scope: "none", handle: control },
    "recovery-action": { scope: "none", async handle(msg) {
      await deps.actions.handle(msg); deps.publishPolicy();
      if (!ctx.stopping()) deps.trackBackground(deps.actions.maintainCleanup());
    } },
  } satisfies CommandModule;
}
