import { useEffect, useRef, useState } from "react";
import { dependencyOrder, groupApprovalEligible, type ConversationActionCard } from "@arke-studio/contracts";
import { approveConversationGroup, type GroupApprovalResult } from "../lib/conversation-group-approval.js";
import { conversationGroupApprovalPort } from "../lib/store.js";
import { ConversationPermissionCard } from "./conversation.js";
import { Button } from "./ui.js";

export function ConversationActionGroup({ actions, conversationSeq }: { actions: readonly ConversationActionCard[]; conversationSeq: number }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GroupApprovalResult | null>(null);
  const gesture = useRef<AbortController | null>(null);
  useEffect(() => () => gesture.current?.abort(), []);
  const ordered = dependencyOrder(actions);
  const eligible = ordered.filter(action => action.status === "pending" && groupApprovalEligible(action));
  const individual = ordered.filter(action => action.status === "pending" && !groupApprovalEligible(action));
  const estimate = actions.reduce((sum, action) => sum + (action.shown.body.family === "generation" ? action.shown.body.estimatedMicroUsd ?? 0 : 0), 0);
  const unpriced = actions.some(action => action.shown.body.family === "generation" && action.shown.body.estimatedMicroUsd === undefined);
  const first = actions[0];
  if (!first) return null;
  const approve = async () => {
    if (gesture.current || !eligible.length) return;
    const controller = new AbortController(); gesture.current = controller;
    setBusy(true); setResult(null);
    const answer = await approveConversationGroup(conversationGroupApprovalPort(first.conversationId), first.turnId, controller.signal);
    if (!controller.signal.aborted) { setResult(answer); setBusy(false); }
    gesture.current = null;
  };
  return <section className="fy-actiongroup" aria-label="Turn card group">
    <header className="fy-actiongroup__head"><strong>{actions.length} cards</strong><span>Estimated ${(estimate / 1_000_000).toFixed(2)}{unpriced ? " + unpriced work" : ""}</span>
      {eligible.length > 0 && <Button variant="primary" disabled={busy} onClick={() => void approve()}>{busy ? "Approving…" : `Approve all (${eligible.length})`}</Button>}
      {individual.length > 0 && <span>{individual.length} individual {individual.length === 1 ? "decision" : "decisions"}</span>}
    </header>
    {result && <p role="status">{result.approved} approved · {result.left} left. {result.detail}</p>}
    <ol className="fy-actiongroup__sequence">{ordered.map(action => <li key={action.actionId}>
      {action.dependencies.length > 0 && <p className="fy-chat__notice">Requires {action.dependencies.map(id => actions.find(one => one.actionId === id)?.shown.title ?? id).join(" · ")}</p>}
      <ConversationPermissionCard action={action} conversationSeq={conversationSeq} />
    </li>)}</ol>
  </section>;
}
