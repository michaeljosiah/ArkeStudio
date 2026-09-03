import { useEffect, useRef, useState } from "react";
import { subscribeSingleActResults, undoSingleAct, type SingleActResult } from "../lib/store.js";
import { Button, Callout } from "./ui.js";

/** Correlate one control's presses without making transient result news part of the world snapshot. */
export function useSingleAct() {
  const requestId = useRef<string | null>(null);
  const [result, setResult] = useState<SingleActResult | null>(null);
  useEffect(
    () =>
      subscribeSingleActResults((answer) => {
        if (answer.requestId !== requestId.current) return;
        setResult(answer);
        requestId.current = null;
      }),
    [],
  );
  const track = (next: string | null): boolean => {
    if (next === null) return false;
    requestId.current = next;
    setResult(null);
    return true;
  };
  const undo = (): void => {
    if (result?.undo) track(undoSingleAct(result));
  };
  return { result, track, undo };
}

export function SingleActFeedback({
  result,
  undoLabel = "Undo",
  onUndo,
}: {
  result: SingleActResult | null;
  undoLabel?: string;
  onUndo(): void;
}) {
  const [dismissedRequestId, setDismissedRequestId] = useState<string | null>(null);
  if (!result || dismissedRequestId === result.requestId) return null;
  const dismiss = <Button variant="ghost" onClick={() => setDismissedRequestId(result.requestId)}>Dismiss</Button>;
  if (result.disposition === "refused") {
    return <Callout tone="warning" title="Not changed"><span role="alert">{result.reason}</span>{dismiss}</Callout>;
  }
  if (result.disposition === "merged") {
    return <Callout title="Saved to the open draft">Review that draft before accepting its combined work.{dismiss}</Callout>;
  }
  return (
    <Callout title={result.disposition === "undone" ? "Change undone" : "Change accepted"}>
      {result.ripples?.map((ripple) => <div key={`${ripple.kind}:${ripple.summary}`}>{ripple.summary}</div>)}
      {result.undo && <Button onClick={onUndo}>{undoLabel}</Button>}
      {dismiss}
    </Callout>
  );
}
