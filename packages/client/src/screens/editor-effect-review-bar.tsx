export interface EffectReviewBarProps {
  version: number;
  changes: number;
  comparison: "current" | "suggested";
  busy: boolean;
  reason: string | null;
  canApply: boolean;
  onCompare: (value: "current" | "suggested") => void;
  onChanges: () => void;
  onRevise: () => void;
  onUpdate: () => void;
  onDiscard: () => void;
  onApply: () => void;
  onClose: () => void;
  onCheckResponse: () => void;
}

/** This bar belongs only to an explicitly reviewed version; incoming cards never mount it. */
export function EffectReviewBar(props: EffectReviewBarProps) {
  return <section className="fy-effect-review-bar" aria-label="Effects arrangement review">
    <div className="fy-effect-review-bar__row">
      <strong>Review · Version {props.version}</strong>
      <div role="group" aria-label="Compare effect arrangement" className="fy-effect-review-bar__compare">
        <button type="button" aria-pressed={props.comparison === "current"} onClick={() => props.onCompare("current")}>Current</button>
        <button type="button" aria-pressed={props.comparison === "suggested"} onClick={() => props.onCompare("suggested")}>Suggested</button>
      </div>
      <button type="button" onClick={props.onChanges}>{props.changes} {props.changes === 1 ? "change" : "changes"}</button>
      <button type="button" disabled={props.busy} onClick={props.onRevise}>Ask Arke to revise</button>
      <button type="button" onClick={props.onClose}>Return to Current editing</button>
    </div>
    <div className="fy-effect-review-bar__row">
      <span className="fy-effect-review-bar__status" role="status">{props.busy ? "Preparing reviewed edit…" : props.reason ??
        (props.changes === 0 ? "No changes to apply" : props.comparison === "current" ? "Current · comparison only" : "Suggested · edits stay pending")}</span>
      {props.busy && <button type="button" onClick={props.onCheckResponse}>Check response</button>}
      {props.reason && <button type="button" disabled={props.busy} onClick={props.onUpdate}>Update proposal</button>}
      <button type="button" disabled={props.busy} onClick={props.onDiscard}>Discard</button>
      {!props.reason && <button type="button" className="fy-effect-review-bar__apply" disabled={props.busy || !props.canApply} onClick={props.onApply}>Apply reviewed version</button>}
    </div>
  </section>;
}
