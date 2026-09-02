import {
  describeEditorRequestDigest,
  editorRequestStaleness,
  editorRequestUndone,
  previewEditorRequest,
  type EditorRequest,
  type ProductionTimeline,
  type TimelineState,
} from "@arke-studio/contracts";
import { Button, cx } from "../components/ui.js";

/**
 * Arke's editor requests, as cards beside the conversation (SPEC-039 R-29, R-34; issue 684).
 *
 * Each card says what the request does in the person's terms — moves, removals, additions, the
 * range it touches, whether the story order changes — and carries the only two controls that
 * decide it. A pending card can also be previewed: the timeline draws the request applied in
 * memory, never saved, and drops it the moment the card is decided or the base moves.
 */
export function EditorRequestCards({
  requests,
  base,
  timelineState,
  currentFingerprint,
  frameRate,
  ghostId,
  onGhost,
  onDecide,
  disabled,
}: {
  requests: readonly EditorRequest[];
  /** The live base a pending request applies to, or null while there is none to apply to. */
  base: ProductionTimeline | null;
  timelineState: TimelineState | undefined;
  currentFingerprint: string | null;
  frameRate: number;
  ghostId: string | null;
  onGhost: (requestId: string | null) => void;
  onDecide: (requestId: string, decision: "accept" | "reject") => void;
  disabled: boolean;
}) {
  const shown = [...requests].reverse().slice(0, 12);
  if (shown.length === 0) return null;
  return (
    <section className="fy-reqcards" aria-label="Arke's editor requests">
      {shown.map((request) => {
        const stale = editorRequestStaleness(request, timelineState, currentFingerprint);
        const preview = request.status === "pending" && stale === null && base !== null ? previewEditorRequest(base, request.commands) : null;
        const status = request.status === "pending" && stale !== null ? "stale" : request.status;
        const undone = editorRequestUndone(request, timelineState);
        const lines = preview?.ok ? describeEditorRequestDigest(preview.digest, frameRate) : [];
        return (
          <article
            key={request.id}
            className={cx("fy-reqcard", `fy-reqcard--${status}`)}
            data-request={request.id}
            data-status={status}
            aria-label={`Editor request · ${status}`}
          >
            <p className="fy-reqcard__summary">{request.summary}</p>
            <span className="fy-mono fy-reqcard__status">
              {status}
              {request.resultRevision !== undefined ? ` · r${request.resultRevision}` : ""}
              {undone ? " · undone" : ""}
            </span>
            {lines.length > 0 && (
              <ul className="fy-reqcard__lines">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {stale !== null && <p className="fy-reqcard__reason">{stale} · ask Arke again</p>}
            {request.status === "stale" && request.reason !== undefined && <p className="fy-reqcard__reason">{request.reason}</p>}
            {preview !== null && !preview.ok && <p className="fy-reqcard__reason">Cannot apply: {preview.reason}</p>}
            {request.status === "pending" && (
              <div className="fy-reqcard__actions">
                {stale === null && (
                  <Button variant="primary" disabled={disabled || preview === null || !preview.ok} onClick={() => onDecide(request.id, "accept")}>
                    Accept
                  </Button>
                )}
                <Button variant="ghost" disabled={disabled} onClick={() => onDecide(request.id, "reject")}>
                  Reject
                </Button>
                {preview?.ok && (
                  <button
                    type="button"
                    className="fy-reqcard__preview"
                    aria-pressed={ghostId === request.id}
                    onClick={() => onGhost(ghostId === request.id ? null : request.id)}
                  >
                    Preview
                  </button>
                )}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
