import { ownerStamp, OWNER_START_TOLERANCE_MS, probeProcesses, type ProcessProbe } from "../child-ledger.js";
import { inspectOwnedCommandJob } from "../setup/process-job.js";

/** Private reservation identity, never a renderer/diagnostic field or executable command. */
export function mingStorageOwner(jobName: string): string {
  const token = /^Global\\ArkeOwnedCommand-([a-f0-9]{64})$/.exec(jobName)?.[1];
  if (!token) throw new Error("Ming storage requires its original global native job.");
  const owner = ownerStamp();
  return `ming_${owner.ownerPid}_${owner.ownerStartedAt}_${token}`;
}

export async function mingOwnerSettled(id: string, signal: AbortSignal, ports?: {
  probe: ProcessProbe; inspect: typeof inspectOwnedCommandJob;
}): Promise<boolean> {
  const match = /^ming_([1-9][0-9]{0,9})_([1-9][0-9]{0,15})_([a-f0-9]{64})$/.exec(id);
  if (!match) return false;
  const pid = Number(match[1]), startedAt = Number(match[2]);
  if (!Number.isSafeInteger(startedAt)) return false;
  try {
    signal.throwIfAborted();
    const found = (await (ports?.probe ?? (pids => probeProcesses(pids, { timeoutMs: 15_000 })))([pid])).get(pid);
    signal.throwIfAborted();
    // A live owner may still launch or write files, even if its native job is currently empty.
    if (found && (found.startedAt === null || Math.abs(found.startedAt - startedAt) <= OWNER_START_TOLERANCE_MS)) return false;
    const count = await (ports?.inspect ?? inspectOwnedCommandJob)(`Global\\ArkeOwnedCommand-${match[3]}`, signal);
    signal.throwIfAborted();
    return count === null || count === 0;
  } catch { return false; }
}
