import type { ClientMessage, RecoveryCommandResult } from "@arke-studio/contracts";
import type { RecoveryControlService } from "./control.js";
import type { RecoveryHistoryService } from "./history.js";

type Command = Extract<ClientMessage, { kind: RecoveryCommandResult["operation"] }>;
/** Host transport authentication/remote refusal precedes dispatch. These operations never
 * invoke a lifecycle owner, grant a repair, clear a circuit or replay submitted work. */
export async function recoveryCommand(message: Command, deps: { control?: RecoveryControlService | null; history?: RecoveryHistoryService | null }): Promise<RecoveryCommandResult> {
  const result = { requestId: message.requestId, operation: message.kind,
    ...(message.kind === "recovery-history-control" ? { historyAction: message.command.action } : {}) };
  try {
    let saved = false, available = false;
    if (message.kind === "recovery-set-mode") {
      available = deps.control?.policySnapshot().accepting === true;
      if (available) saved = await deps.control!.setMode(message.mode);
      available = deps.control?.policySnapshot().accepting === true;
    } else {
      available = deps.history?.snapshot().audit === "available";
      if (available && message.kind === "recovery-set-preferences") saved = await deps.history!.setPreferences(message.preferences);
      else if (available && message.kind === "recovery-history-control") {
        const command = message.command;
        saved = command.action === "clear-resolved" ? await deps.history!.clearResolved()
          : command.action === "acknowledge" ? await deps.history!.acknowledge(command.incidentId)
          : await deps.history!.snooze(command.incidentId, command.action === "snooze-hour" ? "one-hour" : "session");
      }
      available = deps.history?.snapshot().audit === "available";
    }
    return saved ? { ...result, status: "saved" } : { ...result, status: "refused", reason: available ? "not-applicable" : "unavailable" };
  } catch { return { ...result, status: "refused", reason: "unavailable" }; }
}
