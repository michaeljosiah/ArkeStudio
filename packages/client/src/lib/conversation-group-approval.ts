import { dependencyOrder, groupApprovalEligible, ulid, type ConversationActionCard, type ConversationActionDecisionResult } from "@arke-studio/contracts";

export interface GroupApprovalSnapshot { worldId: string; conversationId: string; seq: number; actions: readonly ConversationActionCard[] }
export interface GroupApprovalPort {
  read(): GroupApprovalSnapshot | null;
  decide(action: ConversationActionCard, seq: number, requestId: string): Promise<ConversationActionDecisionResult>;
  changed(signal: AbortSignal): Promise<void>;
}
export interface GroupApprovalResult { approved: number; left: number; detail: string }

/** Two views of one turn share the same gesture, including each member's request identity. */
const active = new Map<string, Promise<GroupApprovalResult>>();
export function approveConversationGroup(port: GroupApprovalPort, turnId: string, signal: AbortSignal): Promise<GroupApprovalResult> {
  const initial = port.read();
  if (!initial) return Promise.resolve({ approved: 0, left: 0, detail: "The conversation is unavailable." });
  const key = `${initial.worldId}:${initial.conversationId}:${turnId}`;
  const running = active.get(key);
  if (running) return running;
  const members = dependencyOrder(initial.actions.filter(action => action.turnId === turnId && action.status === "pending" && groupApprovalEligible(action)));
  const work = run().finally(() => { if (active.get(key) === work) active.delete(key); });
  active.set(key, work);
  return work;

  async function run(): Promise<GroupApprovalResult> {
    let approved = 0;
    const finish = (detail: string) => ({ approved, left: members.length - approved, detail });
    try {
      for (const member of members) {
        let snapshot = port.read();
        for (;;) {
          if (signal.aborted || !snapshot || snapshot.worldId !== initial!.worldId || snapshot.conversationId !== initial!.conversationId) return finish("The conversation changed.");
          const current = snapshot.actions.find(action => action.actionId === member.actionId);
          if (!current || current.status !== "pending" || current.previewDigest !== member.previewDigest || !groupApprovalEligible(current)) return finish("A card changed. Review the remaining cards.");
          const dependencies = current.dependencies.map(id => snapshot!.actions.find(action => action.actionId === id));
          if (dependencies.some(action => !action || ["failed", "cancelled", "denied", "stale", "superseded"].includes(action.status))) return finish("A required action did not complete.");
          if (dependencies.every(action => action?.status === "completed")) break;
          await port.changed(signal);
          snapshot = port.read();
        }
        const answer = await port.decide(member, snapshot.seq, ulid());
        if (answer.disposition !== "recorded" || answer.decision !== "approve") return finish(answer.detail ?? "A card was refused.");
        approved++;
        if (answer.status === "failed" || answer.status === "stale" || answer.status === "cancelled") return finish("An approved action did not complete.");
        // The acknowledgement records permission, not execution. Completion stays authoritative.
        while (port.read()?.actions.find(action => action.actionId === member.actionId)?.status !== "completed") {
          const latest = port.read();
          const status = latest?.actions.find(action => action.actionId === member.actionId)?.status;
          if (!latest || latest.worldId !== initial!.worldId || latest.conversationId !== initial!.conversationId ||
              !status || ["failed", "cancelled", "denied", "stale", "superseded"].includes(status)) return finish("An approved action did not complete.");
          await port.changed(signal);
        }
      }
      return finish("Eligible cards approved.");
    } catch {
      return finish("Stopped. Review the remaining cards before continuing.");
    }
  }
}
