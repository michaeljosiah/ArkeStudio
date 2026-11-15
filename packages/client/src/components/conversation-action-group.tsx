import { useEffect, useRef, useState } from "react";
import { dependencyOrder, groupApprovalEligible, proposedBatchWords, type ConversationActionCard } from "@arke-studio/contracts";
import { ChapterWordCounts } from "./chapter-word-counts.js";
import { approveConversationGroup, type GroupApprovalResult } from "../lib/conversation-group-approval.js";
import { conversationGroupApprovalPort } from "../lib/store.js";
import { ConversationPermissionCard } from "./conversation.js";
import { Button } from "./ui.js";

/** Three or more neighbours fold to a range; two read better apart: "1, 2", not "1 to 2". */
function numberRuns(numbers: readonly number[]): string {
  const parts: string[] = [];
  for (let start = 0; start < numbers.length;) {
    let end = start;
    while (numbers[end + 1] === numbers[end]! + 1) end++;
    if (end - start < 2) parts.push(String(numbers[start++]));
    else { parts.push(`${numbers[start]} to ${numbers[end]}`); start = end + 1; }
  }
  return parts.join(", ");
}

/**
 * What a card waits for, the way its list shows it: the cards before it by their numbers here, and
 * a card the list leaves out (Earlier actions keeps only what is unsettled) by its title. One that
 * nothing here can name is left out; its id is no name.
 */
function waitsFor(action: ConversationActionCard, ordered: readonly ConversationActionCard[], known: readonly ConversationActionCard[]): string | undefined {
  const numbers = new Set<number>(), titles: string[] = [];
  for (const id of action.dependencies) {
    const at = ordered.findIndex(one => one.actionId === id);
    if (at >= 0) numbers.add(at + 1);
    else titles.push(known.find(one => one.actionId === id)?.shown.title ?? "");
  }
  const named = [numberRuns([...numbers].sort((a, b) => a - b)), ...titles].filter(Boolean);
  return named.length ? `After ${named.join(" · ")}` : undefined;
}

export function ConversationActionGroup({ actions, conversationSeq, known = actions }: {
  actions: readonly ConversationActionCard[]; conversationSeq: number;
  /** Every card of the conversation, to name one this list depends on and does not hold. */
  known?: readonly ConversationActionCard[];
}) {
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
  const words = proposedBatchWords(actions);
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
    <header className="fy-actiongroup__head">{(actions.length > 1 || estimate > 0 || unpriced) && <><strong>{actions.length} {actions.length === 1 ? "card" : "cards"}</strong><span>Estimated ${(estimate / 1_000_000).toFixed(2)}{unpriced ? " + unpriced work" : ""}</span></>}
      {eligible.length > 0 && <Button variant="primary" disabled={busy} onClick={() => void approve()}>{busy ? "Approving…" : `Approve all (${eligible.length})`}</Button>}
      {individual.length > 1 && <span>{individual.length} decisions</span>}
    </header>
    {result && <p role="status">{result.approved} approved · {result.left} left. {result.detail}</p>}
    {words.length > 1 && <ChapterWordCounts changes={words} batch />}
    {/* The card is all a row holds, so the list's number sits on its title. A "Requires …" line
        above the card took the number and read as the title (issue 3143). */}
    <ol className="fy-actiongroup__sequence">{ordered.map(action => <li key={action.actionId}>
      <ConversationPermissionCard action={action} conversationSeq={conversationSeq} after={waitsFor(action, ordered, known)} />
    </li>)}</ol>
  </section>;
}
